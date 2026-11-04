// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The storage-reclaim view: what an organization's registry storage is spent
 * on, and what deleting a version would actually give back.
 *
 * Mirrors the plugin service's `ReclaimPlan`. The one field to understand is
 * {@link ReclaimCandidate.marginalBytes} — see its note.
 */

/** Why a version cannot be pruned; `null` means it can. */
export type ReclaimIneligibleReason = 'in_use' | 'published' | 'unknown_version';

export interface ReclaimCandidate {
  repo: string;
  tag: string;
  pluginName: string | null;
  version: string | null;
  /** Bytes this version's layers occupy, SHARED ONES INCLUDED. */
  totalBytes: number;
  /**
   * Bytes that would come back if this version alone were removed.
   *
   * The ONLY figure to show beside a delete button. Under deduplication,
   * deleting one of ten versions sharing a 400 MB base frees just that
   * version's own layers — so `totalBytes` would promise 411 MB and free 11.
   */
  marginalBytes: number;
  /** Server-rendered form of `marginalBytes`, so every surface words it alike. */
  marginalLabel: string;
  eligible: boolean;
  reason: ReclaimIneligibleReason | null;
  /** Pipelines blocking a prune (this org's own, named). */
  blockedBy: Array<{ id: string; name: string | null }>;
}

export interface StorageReclaimPlan {
  orgId: string;
  /** The org's measured total — the same figure the push gate enforces. */
  bytes: number;
  /** Sum over ELIGIBLE candidates: what pruning could actually free. */
  reclaimableBytes: number;
  candidates: ReclaimCandidate[];
  /**
   * True when the registry could not measure everything. Both figures then
   * UNDER-state reality, so the surface must say the picture is partial — the
   * viewer is about to decide what to delete.
   */
  incomplete: boolean;
  computedAt: number;
  usedLabel: string;
  reclaimableLabel: string;
}

export interface StoragePruneResult {
  pruned: boolean;
  repo: string;
  tag: string;
  freedBytes: number;
  freedLabel: string;
  reason: string | null;
}
