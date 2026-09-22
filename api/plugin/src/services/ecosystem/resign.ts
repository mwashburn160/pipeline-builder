// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The re-sign job (docs/plans/plugin-ecosystem.md §3.3, G34): a publisher tier
 * change, suspension, unsuspension, handle change or ownership transfer
 * re-signs every published image of the affected publisher (or listing) with
 * the new `pb.trust` / `pb.publisher` annotations, then invalidates the lookup
 * verify cache — so a tier edited in the database without a re-sign is
 * detectable at lookup.
 *
 * Jobs are rows in `ecosystem_settings` (`resign-job:<scope>:<id>`) holding
 * only the SCOPE and the ids already done: the annotations are always computed
 * from the CURRENT publisher state when an image is signed, so a later change
 * simply supersedes an earlier job (idempotent, latest wins) and a crash
 * resumes where it stopped. The maintenance scheduler drives them; each
 * re-sign is audited by image-registry (`registry.image.resign`).
 */

import { emitCounter, createLogger, errorMessage } from '@pipeline-builder/api-core';
import type { Publisher } from '@pipeline-builder/pipeline-data';

import { invalidateVerifyCache, resignImage, type TrustTier } from './registry.js';
import { listings, publishers, settings, versions } from './store.js';

const logger = createLogger('ecosystem-resign');

export const RESIGN_JOB_PREFIX = 'resign-job:';

export interface ResignJob {
  scope: 'publisher' | 'listing';
  id: string;
  reason: string;
  requestedBy: string;
  createdAt: string;
  /** Listing-version ids already re-signed under this job. */
  done: string[];
}

const jobKey = (scope: ResignJob['scope'], id: string) => `${RESIGN_JOB_PREFIX}${scope}:${id}`;

/**
 * The trust annotation a publisher's images carry: its tier, or `unverified`
 * while it is suspended — the lowest trust, so every org policy that allows
 * only Official/Verified refuses it at lookup even before a cache expires.
 */
export function trustFor(p: Pick<Publisher, 'tier' | 'suspendedAt'>): TrustTier {
  return p.suspendedAt ? 'unverified' : p.tier;
}

/** Queue (or restart) a re-sign of everything a publisher or a listing has published. */
export async function enqueueResign(scope: ResignJob['scope'], id: string, reason: string, requestedBy: string): Promise<void> {
  const job: ResignJob = { scope, id, reason, requestedBy, createdAt: new Date().toISOString(), done: [] };
  await settings.put(jobKey(scope, id), job, requestedBy);
  emitCounter('ecosystem_resign_jobs_enqueued_total', { scope, reason });
}

/** Queued jobs (the console shows them; the scheduler runs them). */
export async function pendingResignJobs(): Promise<ResignJob[]> {
  return (await settings.withPrefix(RESIGN_JOB_PREFIX)).map((r) => r.value as ResignJob);
}

/**
 * Advance every queued job, re-signing at most `budget` images in total per
 * call. A job whose image fails stops for this pass (it resumes next pass from
 * its `done` list); a finished job is removed. Returns what was done.
 */
export async function runResignJobs(budget = 200): Promise<{ resigned: number; failed: number; completed: number }> {
  const out = { resigned: 0, failed: 0, completed: 0 };
  for (const job of await pendingResignJobs()) {
    if (budget <= 0) break;
    const listingRows = job.scope === 'listing'
      ? [await listings.byId(job.id)].filter((l): l is NonNullable<typeof l> => l !== null)
      : await listings.list({ publisherId: job.id });
    const targets = (await versions.forListings(listingRows.map((l) => l.id)))
      .filter((v) => v.imageDigest && v.imageRepository);
    const total = targets.length;
    let stopped = false;
    for (const v of targets) {
      if (job.done.includes(v.id)) continue;
      if (budget <= 0) { stopped = true; break; }
      const listing = listingRows.find((l) => l.id === v.listingId)!;
      const publisher = await publishers.byId(listing.publisherId);
      if (!publisher) { job.done.push(v.id); continue; }
      try {
        await resignImage({
          imageRepository: v.imageRepository!,
          digest: v.imageDigest!,
          publisherHandle: publisher.handle,
          tier: trustFor(publisher),
          publisherOrgId: publisher.ownerOrgId,
          progress: { completed: job.done.length + 1, total },
        });
        job.done.push(v.id);
        out.resigned++;
        budget--;
        emitCounter('ecosystem_resign_images_total', { scope: job.scope });
      } catch (err) {
        out.failed++;
        emitCounter('ecosystem_resign_failures_total', { scope: job.scope });
        logger.warn('Re-sign failed; the job resumes on the next pass', { scope: job.scope, id: job.id, version: v.id, error: errorMessage(err) });
        stopped = true;
        break;
      }
    }
    if (stopped) {
      await settings.put(jobKey(job.scope, job.id), job, job.requestedBy);
      continue;
    }
    for (const l of listingRows) {
      const repos = new Set(targets.filter((v) => v.listingId === l.id).map((v) => v.imageRepository!));
      for (const imageRepository of repos) await invalidateVerifyCache({ imageRepository }).catch(() => undefined);
    }
    await settings.remove(jobKey(job.scope, job.id));
    out.completed++;
    emitCounter('ecosystem_resign_jobs_completed_total', { scope: job.scope });
    logger.info('Re-sign job complete', { scope: job.scope, id: job.id, reason: job.reason, images: total });
  }
  return out;
}
