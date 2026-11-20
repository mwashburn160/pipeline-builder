// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A managed toolchain release's BUILD INPUTS, kept for the nightly toolchain
 * fix. Both halves are uploaded PREBUILT (the release's exact bits from
 * build-plugin-images.sh), so neither keeps a source ZIP — but a fix must
 * rebuild them from their Dockerfiles and recompute the spec's sourceDigest.
 * So each managed upload keeps its top-level text inputs (Dockerfile,
 * plugin-spec.yaml; load-plugin-worker.sh puts the Dockerfile in a managed
 * half's ZIP) as one small JSON object in the plugin-sources bucket:
 *
 *   <systemOrgId>/toolchain-inputs/<releaseVersion>/<half>.json   { "<file>": "<text>", … }
 *
 * An approved fix writes the inputs of the release it publishes, so the next
 * fix starts from them. A release uploaded before inputs were kept has none:
 * its fix ends needs_owner (TOOLCHAIN_INPUTS_MISSING).
 */

import * as fs from 'fs';
import path from 'path';

import { GetObjectCommand } from '@aws-sdk/client-s3';
import { createLogger, errorMessage, SYSTEM_ORG_ID, TOOLCHAIN_FIX_METRICS } from '@pipeline-builder/api-core';
import { s3Client } from '@pipeline-builder/api-core/s3';
import { incCounter } from '@pipeline-builder/api-server';

import { TOOLCHAIN_INPUT_EXCLUDED, type ToolchainDir } from './toolchain-spec.js';
// Namespace import: suites mocking plugin-sources with only what they use still link.
import * as sources from '../plugin-sources.js';

const logger = createLogger('toolchain-inputs');

/** One input file is at most this large (the release's Dockerfiles and specs are a few KB). */
const MAX_INPUT_BYTES = 256 * 1024;
const MAX_INPUT_FILES = 32;

export const toolchainInputsKey = (releaseVersion: string, half: ToolchainDir): string =>
  `${SYSTEM_ORG_ID.toLowerCase()}/toolchain-inputs/${releaseVersion}/${half}.json`;

export type ToolchainInputFiles = Record<string, string>;

/** Read and write a release's kept inputs (swappable in tests). */
export interface ToolchainInputsStore {
  read(releaseVersion: string, half: ToolchainDir): Promise<ToolchainInputFiles | null>;
  write(releaseVersion: string, half: ToolchainDir, files: ToolchainInputFiles): Promise<void>;
}

/** The top-level text build inputs of an extracted upload (or build context). */
export function readToolchainInputs(dir: string): ToolchainInputFiles {
  const out: ToolchainInputFiles = {};
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isFile() || TOOLCHAIN_INPUT_EXCLUDED.has(e.name) || Object.keys(out).length >= MAX_INPUT_FILES) continue;
    const abs = path.join(dir, e.name);
    if (fs.statSync(abs).size > MAX_INPUT_BYTES) continue;
    const buf = fs.readFileSync(abs);
    if (buf.includes(0)) continue;
    out[e.name] = buf.toString('utf8');
  }
  return out;
}

function isFileMap(v: unknown): v is ToolchainInputFiles {
  return !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v as Record<string, unknown>).every((x) => typeof x === 'string');
}

export const liveToolchainInputs: ToolchainInputsStore = {
  async read(releaseVersion, half) {
    try {
      const out = await s3Client().send(new GetObjectCommand({ Bucket: sources.pluginSourcesBucket(), Key: toolchainInputsKey(releaseVersion, half) }));
      const text = out.Body ? await out.Body.transformToString('utf-8') : null;
      let parsed: unknown = null;
      // A garbled object reads as missing (the fix goes to the owner) rather than failing the job on every attempt.
      try { parsed = text ? JSON.parse(text) : null; } catch { logger.warn('Kept toolchain inputs are not valid JSON; treated as missing', { releaseVersion, half }); }
      return isFileMap(parsed) ? parsed : null;
    } catch (err) {
      if ((err as { name?: string }).name === 'NoSuchKey') return null;
      throw err;
    }
  },
  async write(releaseVersion, half, files) {
    await sources.putRemediationArtifact(toolchainInputsKey(releaseVersion, half), JSON.stringify(files));
  },
};

/**
 * Keep a managed half's inputs at upload. Best-effort: the upload itself is
 * unaffected; a failure is logged and counted
 * (`toolchain_fix_failures_total{stage="keep_inputs"}`, alerted) — the release
 * can then only get an owner request, never a candidate.
 */
export async function keepToolchainInputs(releaseVersion: string, half: ToolchainDir, extractDir: string, store: ToolchainInputsStore = liveToolchainInputs): Promise<boolean> {
  try {
    const files = readToolchainInputs(extractDir);
    if (!files.Dockerfile) logger.warn('A managed toolchain upload carried no Dockerfile; its fix will need the owner', { releaseVersion, half });
    await store.write(releaseVersion, half, files);
    return true;
  } catch (err) {
    incCounter(TOOLCHAIN_FIX_METRICS.failures, { stage: 'keep_inputs' });
    logger.error('Could not keep a toolchain release\'s build inputs', { releaseVersion, half, error: errorMessage(err) });
    return false;
  }
}
