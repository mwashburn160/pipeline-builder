// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, errorMessage } from '@pipeline-builder/api-core';
import {
  listRepositories,
  listTags,
  getManifest,
  deleteManifest,
  isNotFound,
} from './registry-client';
import { invalidateStorageCache } from './storage-usage';

const logger = createLogger('registry-gc');

export interface GcOptions {
  /** Repo namespace prefix to GC (e.g. `org-acme/`). Required — full-registry GC is not exposed. */
  prefix: string;
  /** Manifests older than this many days are eligible. Default 30. */
  maxAgeDays?: number;
  /**
   * Dry-run mode: walks the repos + identifies candidates without issuing
   * DELETEs. Logs the count + sample so an operator can validate before
   * flipping to a real run.
   */
  dryRun?: boolean;
}

export interface GcResult {
  /** Number of repos walked under `prefix`. */
  reposScanned: number;
  /** Number of manifests considered for pruning across all repos. */
  candidates: number;
  /**
   * Number of manifests actually deleted. Always 0 in dry-run mode.
   * Distribution's GC reconciles the blob store on its own schedule, so
   * the bytes-on-disk number only drops when the registry's `garbage-collect`
   * command runs (operator-driven, separate from this app-level GC).
   */
  deleted: number;
  /** Per-repo breakdown for the operator's run log. */
  perRepo: Array<{ repo: string; scanned: number; deleted: number }>;
}

/**
 * Application-level registry GC. Walks every repo under `prefix` and, for
 * each repo, lists tags; for each tag, fetches the manifest and reads its
 * `created` timestamp from the v2 config. Manifests older than
 * `maxAgeDays` are deleted by digest.
 *
 * NOTE: This deletes the *manifest reference*. The underlying registry's
 * blob garbage-collector (`registry garbage-collect`) is what frees the
 * bytes on disk. That's a separate operator action — usually scheduled
 * weekly off-peak; we don't drive it from this app.
 *
 * Used by both:
 *  - the periodic CronJob (`deploy/{minikube,aws/ec2}/k8s/registry-gc-cronjob.yaml`)
 *    that runs daily across every `org-*` namespace, AND
 *  - the admin `POST /api/admin/gc` endpoint for manual one-off runs.
 */
export async function runRegistryGc(opts: GcOptions): Promise<GcResult> {
  const { prefix, maxAgeDays = 30, dryRun = false } = opts;
  if (!prefix) throw new Error('prefix is required');

  const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const perRepo: GcResult['perRepo'] = [];
  let candidates = 0;
  let deleted = 0;

  // Walk the catalog and collect repos under `prefix`.
  const repos: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await listRepositories({ n: 100, last: cursor });
    for (const r of page.repositories) if (r.startsWith(prefix)) repos.push(r);
    cursor = page.next;
  } while (cursor);

  for (const repo of repos) {
    let scanned = 0;
    let repoDeleted = 0;
    try {
      const { tags } = await listTags(repo);
      for (const tag of tags) {
        scanned++;
        let mani;
        try {
          mani = await getManifest(repo, tag);
        } catch (err) {
          if (isNotFound(err)) continue;
          logger.warn('GC: manifest fetch failed', {
            repo, tag, error: errorMessage(err),
          });
          continue;
        }
        // Determine creation time. Image manifests embed it in the config
        // blob, but fetching the config requires a blob GET — too expensive.
        // We fall back on `created` if present at the manifest level (some
        // CI tools embed it as a label-equivalent) and skip otherwise.
        // Future enhancement: walk config blobs for more accurate age data.
        const body = mani.body as { created?: string; annotations?: Record<string, string> };
        const created = body?.created ?? body?.annotations?.['org.opencontainers.image.created'];
        if (!created) continue;
        const ts = Date.parse(created);
        if (!Number.isFinite(ts) || ts > cutoffMs) continue;

        candidates++;
        if (dryRun) {
          logger.info('GC dry-run candidate', { repo, tag, digest: mani.digest, created });
          continue;
        }

        try {
          await deleteManifest(repo, mani.digest);
          repoDeleted++;
          deleted++;
        } catch (err) {
          logger.warn('GC: delete failed', {
            repo, tag, digest: mani.digest, error: errorMessage(err),
          });
        }
      }
    } catch (err) {
      logger.warn('GC: tag list failed', { repo, error: errorMessage(err) });
    }
    perRepo.push({ repo, scanned, deleted: repoDeleted });
  }

  if (deleted > 0) invalidateStorageCache(prefix);

  return {
    reposScanned: repos.length,
    candidates,
    deleted,
    perRepo,
  };
}
