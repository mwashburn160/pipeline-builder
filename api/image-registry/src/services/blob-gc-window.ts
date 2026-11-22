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
 * The window itself (BLOB_GC_WINDOW) and the freeze arithmetic live in
 * api-core (helpers/blob-gc-window.ts), shared with the plugin build workers,
 * which hold a build back until the freeze ends rather than let its push be
 * refused. The CronJob schedules and the compose loop are pinned to those
 * numbers by test/deploy-contracts/test/registry-blob-gc-contract.test.ts.
 */
import { pushFreezeActiveAt } from '@pipeline-builder/api-core';

export { BLOB_GC_WINDOW, pushFreezeActiveAt } from '@pipeline-builder/api-core';

let clock: () => number = () => Date.now();

/** Test hook: pin the clock the freeze reads (pass nothing to restore it). */
export function setBlobGcClockForTests(now?: () => number): void {
  clock = now ?? (() => Date.now());
}

/** True while `push` must not be granted now. */
export function pushFreezeActive(tokenTtlSeconds: number): boolean {
  return pushFreezeActiveAt(clock(), tokenTtlSeconds);
}
