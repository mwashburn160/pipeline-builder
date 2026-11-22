// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Hold builds back across the registry's weekly blob-GC push freeze.
 *
 * image-registry withholds `push` from every registry token from (GC start −
 * token TTL − 60s) until the GC window closes (api-core helpers/blob-gc-window.ts:
 * Sunday about 03:04–03:40 UTC). A build that reaches its image push inside that
 * interval is refused ("UNAUTHORIZED ... insufficient scope") after doing all of
 * its work, and records a healthy plugin as FAILED. A fresh install whose
 * catalogue load ran into it lost 43 of 116 builds that way, each needing a
 * manual re-upload.
 *
 * So a worker that picks up a build which could reach its push inside the
 * freeze moves it to DELAYED until the freeze ends (no attempt spent, no slot
 * held), and the build then runs normally. "Could reach": it starts within
 * {@link BUILD_PUSH_LEAD_MS} of the freeze, a generous bound on how long a
 * build runs before it pushes. The cost is that builds pause for about an hour
 * a week, early on Sunday UTC.
 */

import { envInt, pushFreezeEndIfOverlapping } from '@pipeline-builder/api-core';

/** How long a build may run before its push: the hold starts this long before the freeze. */
export const BUILD_PUSH_LEAD_MS = 30 * 60_000;

/** Spread held builds over this long after the freeze ends, so they do not all start in the same second. */
export const HOLD_JITTER_MS = 2 * 60_000;

/**
 * When a build picked up at `nowMs` should start instead, or `null` to run it
 * now. The token TTL is image-registry's `REGISTRY_TOKEN_EXPIRES_IN` (it sets
 * where the freeze begins); every deploy tree leaves it at the default.
 */
export function blobGcHoldUntil(nowMs: number = Date.now(), random: () => number = Math.random): number | null {
  const tokenTtlSeconds = envInt('REGISTRY_TOKEN_EXPIRES_IN', 300, { min: 1 });
  const end = pushFreezeEndIfOverlapping(nowMs, tokenTtlSeconds, BUILD_PUSH_LEAD_MS);
  return end === null ? null : end + Math.floor(random() * HOLD_JITTER_MS);
}
