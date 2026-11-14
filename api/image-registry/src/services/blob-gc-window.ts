// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The weekly BLOB garbage-collection window, and the push freeze around it.
 *
 * Every manifest delete this service makes (age GC, storage prune, quarantine,
 * org teardown, a discarded image) removes a REFERENCE only. The bytes come
 * back when the registry's own `registry garbage-collect` runs — Distribution
 * never runs it by itself — so every deploy tree schedules it as the
 * `registry-blob-gc` job (a CronJob in each Kubernetes tree's registry.yaml, a
 * service in docker-compose.yml) at {@link BLOB_GC_WINDOW}.
 *
 * WHY A FREEZE. `garbage-collect` marks every blob some manifest references,
 * then sweeps the rest. A push that lands between the two — layers uploaded,
 * manifest PUT after the mark — would have its fresh layers swept out from
 * under a manifest that now points at nothing: a corrupted image, not a failed
 * push. Distribution's answer is read-only mode, which needs a registry
 * restart; ours is cheaper: this service is the registry's only token issuer,
 * so it stops granting `push` from (GC start − token TTL − 60s) until the
 * window closes. Every push token alive at GC start has then expired, and the
 * registry refuses any push without one. Pulls and deletes are unaffected.
 *
 * The job is run WITHOUT `--delete-untagged`: pipelines pin images BY DIGEST,
 * and both the storage prune and the public yank deliberately leave the
 * manifest pullable after removing its tag. `--delete-untagged` would delete
 * exactly those.
 *
 * The CronJob schedules and the compose loop are pinned to these numbers by
 * test/deploy-contracts/test/registry-blob-gc-contract.test.ts.
 */
export const BLOB_GC_WINDOW = {
  /** Day of week, UTC (0 = Sunday). */
  dayOfWeekUtc: 0,
  /** GC start, UTC: 03:10. */
  startHourUtc: 3,
  startMinuteUtc: 10,
  /** The job's hard deadline (`activeDeadlineSeconds` / `timeout`), minutes. */
  maxRunMinutes: 25,
  /** Freeze kept after the deadline, minutes — slack for a slow pod kill. */
  tailMinutes: 5,
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/** Margin past the token TTL before GC starts, so a request in flight at expiry finishes. */
const FREEZE_LEAD_MARGIN_MS = 60_000;

/**
 * The freeze interval `[start, end)` of the window nearest `nowMs` (this
 * week's, last week's or next week's — the lead can cross a day boundary).
 */
function freezeIntervals(nowMs: number, tokenTtlSeconds: number): Array<[number, number]> {
  const now = new Date(nowMs);
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const daysSince = (now.getUTCDay() - BLOB_GC_WINDOW.dayOfWeekUtc + 7) % 7;
  const thisWeek = midnight - daysSince * DAY_MS
    + (BLOB_GC_WINDOW.startHourUtc * 60 + BLOB_GC_WINDOW.startMinuteUtc) * 60_000;
  const lead = tokenTtlSeconds * 1000 + FREEZE_LEAD_MARGIN_MS;
  const tail = (BLOB_GC_WINDOW.maxRunMinutes + BLOB_GC_WINDOW.tailMinutes) * 60_000;
  return [thisWeek - WEEK_MS, thisWeek, thisWeek + WEEK_MS].map((gcStart) => [gcStart - lead, gcStart + tail]);
}

/** True while `push` must not be granted at `nowMs` (see the module comment). */
export function pushFreezeActiveAt(nowMs: number, tokenTtlSeconds: number): boolean {
  return freezeIntervals(nowMs, tokenTtlSeconds).some(([start, end]) => nowMs >= start && nowMs < end);
}

let clock: () => number = () => Date.now();

/** Test hook: pin the clock the freeze reads (pass nothing to restore it). */
export function setBlobGcClockForTests(now?: () => number): void {
  clock = now ?? (() => Date.now());
}

/** True while `push` must not be granted now. */
export function pushFreezeActive(tokenTtlSeconds: number): boolean {
  return pushFreezeActiveAt(clock(), tokenTtlSeconds);
}
