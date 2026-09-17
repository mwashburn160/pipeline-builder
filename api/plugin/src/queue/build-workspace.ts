// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Build context and temp-directory lifecycle: staging a local build context,
 * removing it afterwards, and the periodic sweep that reclaims directories
 * orphaned by a crashed or killed worker.
 *
 * Split out of plugin-build-queue.ts for size. Deletion here is deliberately
 * conservative — see getProtectedContextDirs, which is what stops the sweeper
 * from removing a directory an in-flight build is still using.
 */

import * as fs from 'fs';
import path from 'path';
import { createLogger, errorMessage } from '@pipeline-builder/api-core';
import { UnrecoverableError } from 'bullmq';
import { v7 as uuid } from 'uuid';
import { BUILD_TEMP_ROOT } from '../helpers/docker-build.js';
import type { BuildRequest } from '../helpers/docker-build.js';
import { extractZipToDir } from '../helpers/zip-extract.js';
import { deletePluginArtifact, getPluginArtifactToFile } from '../services/plugin-artifact-storage.js';

const logger = createLogger('plugin-build-queue');

export function cleanupContextDir(dir: string): void {
  if (dir && fs.existsSync(dir)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      logger.debug('Temp dir cleanup failed', { path: dir, error: errorMessage(err) });
    }
  }
}

/**
 * Terminal cleanup for a finished build: remove the local scratch context AND
 * the staged S3 build-context object. Call ONLY at points where the job is truly
 * done (success or give-up) — NOT when handing a job to the DLQ for retry, where
 * a retry on another replica still needs the S3 object to re-materialize. Both
 * deletes are best-effort (the bucket's expiry lifecycle is the backstop).
 */
export function cleanupBuildArtifacts(buildRequest: Pick<BuildRequest, 'contextDir' | 's3Key'>): void {
  cleanupContextDir(buildRequest.contextDir);
  void deletePluginArtifact(buildRequest.s3Key);
}

/**
 * The build context is gone for good: not on this replica's disk and not
 * restorable from object storage. Retrying cannot bring it back, so this is an
 * {@link UnrecoverableError} — BullMQ fails the job immediately instead of
 * burning its retry budget, and the failure handlers treat it as terminal.
 */
export class BuildContextMissingError extends UnrecoverableError {
  constructor(detail: string) {
    super(`Build context missing: ${detail}`);
  }
}

/** S3 / MinIO "object absent" — the staged context expired or was never written. */
function isMissingObjectError(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === 'NoSuchKey' || name === 'NotFound';
}

/**
 * Ensure the build context exists on THIS replica's local disk, returning the
 * usable path. Fast path: the extractDir the uploader wrote is present (same
 * replica) — use it as-is. Cross-replica: the local dir is absent, so download
 * the staged ZIP from object storage and re-extract into a fresh local dir,
 * mutating `buildRequest.contextDir` so the rest of the pipeline (build +
 * cleanup) is oblivious to where it came from. Throws
 * {@link BuildContextMissingError} when the context is neither local nor in
 * object storage; a transient storage error propagates as-is (retryable).
 */
export async function ensureLocalBuildContext(buildRequest: BuildRequest): Promise<void> {
  if (buildRequest.contextDir && fs.existsSync(buildRequest.contextDir)) return;
  if (!buildRequest.s3Key) {
    throw new BuildContextMissingError(`${buildRequest.contextDir} (no S3 key to restore from)`);
  }

  const zipPath = path.join(BUILD_TEMP_ROOT, `${uuid()}.zip`);
  const extractDir = path.join(BUILD_TEMP_ROOT, uuid());
  try {
    try {
      await getPluginArtifactToFile(buildRequest.s3Key, zipPath);
    } catch (err) {
      if (isMissingObjectError(err)) {
        throw new BuildContextMissingError(`${buildRequest.contextDir} (staged object ${buildRequest.s3Key} not found)`);
      }
      throw err;
    }
    await extractZipToDir(zipPath, extractDir);
  } finally {
    // The downloaded ZIP is only needed for extraction — drop it either way.
    try { fs.rmSync(zipPath, { force: true }); } catch { /* ignore */ }
  }
  buildRequest.contextDir = extractDir;
  logger.info('Rehydrated build context from object storage', { s3Key: buildRequest.s3Key, extractDir });
}
