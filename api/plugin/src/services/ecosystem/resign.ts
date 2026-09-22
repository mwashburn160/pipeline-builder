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
 * the SCOPE, the ids already done, and the GRACE: the annotations images
 * carried before the change(s), which lookup still accepts until the job
 * finishes (E1) — otherwise every install of a re-tiered/renamed/transferred
 * publisher stops resolving until its last image is re-signed. The annotations
 * are always computed from the CURRENT publisher state when an image is signed,
 * so a later change supersedes an earlier job (its `done` list restarts, its
 * grace list is APPENDED to); a crash resumes where it stopped.
 *
 * Concurrency (E2): every enqueue stamps a fresh `generation`; a runner writes
 * back (or deletes) a job only under a row lock and only when the stored
 * generation is still the one it ran, merging `done` rather than overwriting —
 * so a change landing mid-run is never lost. An enqueue KICKS a run at once
 * (after its transaction commits); the maintenance scheduler is the backstop.
 * Each re-sign is audited by image-registry (`registry.image.resign`).
 */

import { randomUUID } from 'crypto';

import { emitCounter, createLogger, errorMessage } from '@pipeline-builder/api-core';
import type { Publisher } from '@pipeline-builder/pipeline-data';

import { invalidateVerifyCache, resignImage, type TrustTier } from './registry.js';
import { atomically, inTransaction, listings, publishers, settings, versions } from './store.js';

const logger = createLogger('ecosystem-resign');

export const RESIGN_JOB_PREFIX = 'resign-job:';

/** Signature annotations an image may carry: the trust tier and the publisher handle. */
export interface SignedAs {
  tier: TrustTier;
  handle: string;
}

/** How many superseded annotation pairs a job keeps accepting (the newest). */
const MAX_GRACE = 10;

export interface ResignJob {
  scope: 'publisher' | 'listing';
  id: string;
  reason: string;
  requestedBy: string;
  createdAt: string;
  /** Unique per enqueue: a runner only writes back / removes the generation it ran. */
  generation: string;
  /** Listing-version ids already re-signed under this generation. */
  done: string[];
  /** The annotations lookup still accepts until the job completes (E1 grace). */
  previous: SignedAs[];
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

/** What a publisher's images are signed as right now (before a change is applied). */
export function signedAs(p: Pick<Publisher, 'tier' | 'suspendedAt' | 'handle'>): SignedAs {
  return { tier: trustFor(p), handle: p.handle };
}

// -----------------------------------------------------------------------------
// Kicking a run (single-flight per replica)
// -----------------------------------------------------------------------------

let running: Promise<void> | null = null;
let again = false;

const liveKick = (): void => {
  if (running) { again = true; return; }
  running = (async () => {
    do {
      again = false;
      await runResignJobs();
    } while (again);
  })().catch((err) => {
    logger.warn('Kicked re-sign run failed; the maintenance pass retries it', { error: errorMessage(err) });
  }).finally(() => { running = null; });
};

let kick: () => void = liveKick;

/** Test hook: replace the background kick (pass nothing to restore the live one). */
export function setResignKickForTests(fn?: () => void): void {
  kick = fn ?? liveKick;
}

/**
 * Start a re-sign run now, in the background (never throws, never blocks the
 * caller). A caller that enqueued inside an `atomically` block calls this once
 * the block has COMMITTED — a run started earlier would not see the job.
 */
export function kickResignJobs(): void {
  kick();
}

// -----------------------------------------------------------------------------
// Enqueue / list / grace
// -----------------------------------------------------------------------------

/**
 * Queue (or restart) a re-sign of everything a publisher or a listing has
 * published. `previous` is what its images are signed as BEFORE this change
 * (null when lookup must stop trusting the old signature at once, e.g. a
 * suspension); it is appended to the job's grace list. Joins the caller's
 * transaction when there is one; kicks a run immediately when there isn't.
 */
export async function enqueueResign(
  scope: ResignJob['scope'], id: string, reason: string, requestedBy: string, previous: SignedAs | null = null,
): Promise<void> {
  await atomically(async () => {
    const existing = await settings.getForUpdate<ResignJob>(jobKey(scope, id));
    const grace = [...(existing?.previous ?? []), ...(previous ? [previous] : [])]
      .filter((g, i, all) => all.findIndex((x) => x.tier === g.tier && x.handle === g.handle) === i)
      .slice(-MAX_GRACE);
    const job: ResignJob = {
      scope, id, reason, requestedBy, createdAt: new Date().toISOString(), generation: randomUUID(), done: [], previous: grace,
    };
    await settings.put(jobKey(scope, id), job, requestedBy);
  });
  emitCounter('ecosystem_resign_jobs_enqueued_total', { scope, reason });
  if (!inTransaction()) kickResignJobs();
}

/** Queued jobs (the console shows them; the scheduler runs them). */
export async function pendingResignJobs(): Promise<ResignJob[]> {
  return (await settings.withPrefix(RESIGN_JOB_PREFIX)).map((r) => r.value as ResignJob);
}

/**
 * The superseded annotations lookup still accepts for a listing of this
 * publisher (E1): the grace lists of an open publisher job and an open listing
 * job. Empty when nothing is being re-signed.
 */
export async function resignGrace(publisherId: string, listingId: string): Promise<SignedAs[]> {
  const [p, l] = await Promise.all([
    settings.get<ResignJob>(jobKey('publisher', publisherId)),
    settings.get<ResignJob>(jobKey('listing', listingId)),
  ]);
  return [...(p?.previous ?? []), ...(l?.previous ?? [])];
}

// -----------------------------------------------------------------------------
// The run
// -----------------------------------------------------------------------------

/**
 * Write a job's progress back — or remove it when `finished` — but only while
 * the stored row is still the SAME generation (E2). A newer enqueue replaced
 * it mid-run: its restarted `done` list and appended grace win, and this run's
 * work is simply redone under the new annotations. Returns whether it applied.
 */
async function settleJob(job: ResignJob, finished: boolean): Promise<boolean> {
  return atomically(async () => {
    const key = jobKey(job.scope, job.id);
    const current = await settings.getForUpdate<ResignJob>(key);
    if (!current || current.generation !== job.generation) return false;
    if (finished) {
      await settings.remove(key);
    } else {
      // Merge, never overwrite: two runners of one generation both keep their progress.
      await settings.put(key, { ...current, done: [...new Set([...current.done, ...job.done])] }, job.requestedBy);
    }
    return true;
  });
}

/**
 * Advance every queued job, re-signing at most `budget` images in total per
 * call. A job whose image fails stops for this pass (it resumes next pass from
 * its `done` list); a finished job is removed — ending its grace. `signal`
 * (the maintenance leader lease) stops the run at the next image. Returns what
 * was done.
 */
export async function runResignJobs(budget = 200, signal?: AbortSignal): Promise<{ resigned: number; failed: number; completed: number }> {
  const out = { resigned: 0, failed: 0, completed: 0 };
  for (const job of await pendingResignJobs()) {
    if (budget <= 0 || signal?.aborted) break;
    const listingRows = job.scope === 'listing'
      ? [await listings.byId(job.id)].filter((l): l is NonNullable<typeof l> => l !== null)
      : await listings.list({ publisherId: job.id });
    const targets = (await versions.forListings(listingRows.map((l) => l.id)))
      .filter((v) => v.imageDigest && v.imageRepository);
    const total = targets.length;
    let stopped = false;
    for (const v of targets) {
      if (job.done.includes(v.id)) continue;
      // Out of budget, or the scheduler's leader lease was lost: save progress and stop.
      if (budget <= 0 || signal?.aborted) { stopped = true; break; }
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
      await settleJob(job, false);
      continue;
    }
    for (const l of listingRows) {
      const repos = new Set(targets.filter((v) => v.listingId === l.id).map((v) => v.imageRepository!));
      for (const imageRepository of repos) await invalidateVerifyCache({ imageRepository }).catch(() => undefined);
    }
    if (!await settleJob(job, true)) {
      logger.info('Re-sign job was superseded mid-run; the newer one continues', { scope: job.scope, id: job.id });
      continue;
    }
    out.completed++;
    emitCounter('ecosystem_resign_jobs_completed_total', { scope: job.scope });
    logger.info('Re-sign job complete', { scope: job.scope, id: job.id, reason: job.reason, images: total });
  }
  return out;
}
