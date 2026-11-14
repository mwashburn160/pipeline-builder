// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Superseded system plugin version retention, as the plugin service reports it
 * under `/api/plugins/retention/*` (system org, `plugins:moderate`, aal2). The
 * dry run (`GET /plugins/retention/plan`) and an on-demand pass
 * (`POST /plugins/retention/run`) answer with the same report; only a run
 * carries each version's `action` and the `collected` images.
 */

/**
 * What the pass does with one version:
 *  - `keep`: retained (`rule` says why);
 *  - `deprecate`: retirable and not yet in its notice period, so it is deprecated now;
 *  - `notice`: deprecated by an earlier pass, notice period still running;
 *  - `yank`: notice period over and still retirable, so it is yanked and soft-deleted now;
 *  - `reverse`: deprecated by an earlier pass but no longer retirable, so the deprecation is reversed;
 *  - `refused`: retirable, but the plugin was refused for this pass because the
 *    refresh of the declared resolutions of the pipelines naming it did not finish.
 */
export type RetentionState = 'keep' | 'deprecate' | 'notice' | 'yank' | 'reverse' | 'refused';

/** What a run did with one version (absent in a dry run). */
export type RetentionAction = 'deprecated' | 'yanked' | 'reversed' | 'deferred' | 'skipped' | 'failed';

export interface RetentionVersionEntry {
  version: string;
  digest: string | null;
  state: RetentionState;
  /** Why it is kept, refused, or retirable (a code; see `retentionRuleLabel`). */
  rule: string;
  /** When the retention pass deprecated it (ISO). */
  deprecatedAt?: string;
  /** When its notice period ends (ISO). */
  yankAfter?: string;
  /** A `deprecate` the per-plugin throttle held back: a later pass deprecates it. */
  deferred?: boolean;
  /** Orgs a deprecate / yank of this version notifies. */
  notifyOrgIds?: string[];
  /** Bytes freed once every copy of this version is gone; null when image-registry could not measure. */
  marginalBytes: number | null;
  /** The run's action (run only). */
  action?: RetentionAction;
  /** Why the action failed, was skipped or deferred. */
  error?: string;
}

export interface RetentionPluginEntry {
  name: string;
  listed: boolean;
  versions: RetentionVersionEntry[];
  /** Sum of the retirable versions' marginal bytes; null when not measured. */
  marginalBytes: number | null;
  /** A rule code (`resolution_refresh_incomplete`) when the plugin was refused this pass; its versions are `refused`. */
  refusedReason?: string;
}

/** What image-registry did with one retired version's system image (run only). */
export type RetentionCollectionOutcome = 'collected' | 'already_gone' | 'held' | 'refused_by_registry' | 'failed';

export interface RetentionCollection {
  name: string;
  version: string;
  digest: string | null;
  outcome: RetentionCollectionOutcome;
  rule?: string;
  error?: string;
}

export interface RetentionTotals {
  /** Versions retirable now: deprecate + notice + yank. */
  retirable: number;
  deprecate: number;
  notice: number;
  yank: number;
  reverse: number;
  /** Versions in a refused plugin. */
  refused: number;
  /** Plugins refused because their declared-resolution refresh did not finish. */
  refusedPlugins: number;
  /** `deprecate` versions the per-plugin throttle deferred to a later pass. */
  deferred: number;
  /** Sum over retirable versions; null when image-registry could not measure. */
  marginalBytes: number | null;
  /** Yanked retirements whose system image is not collected yet. */
  awaitingCollection: number;
  /** Yanked retirements past their purge deadline that the purge guard keeps refusing. */
  stuck: number;
}

/** `GET /plugins/retention/plan` and `POST /plugins/retention/run`. */
export interface RetentionReport {
  generatedAt: string;
  /** Whether the scheduled pass runs (PLUGIN_RETENTION_ENABLED). A manual run acts either way. */
  enabled: boolean;
  dryRun: boolean;
  keep: number;
  noticeDays: number;
  batch: number;
  maxFraction: number;
  plugins: RetentionPluginEntry[];
  /** Retired versions whose images were handed over this pass (empty in a dry run). */
  collected: RetentionCollection[];
  totals: RetentionTotals;
  /** Whether image-registry's byte figures cover everything. */
  storage: { measured: boolean; incomplete: boolean };
}
