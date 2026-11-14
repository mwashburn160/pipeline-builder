// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure helpers for the system org's plugin version Retention panel. No React,
 * so each rule is testable on its own. The server decides everything; these
 * only put its report into words.
 */
import { formatBytes } from '@/lib/format';
import type {
  RetentionAction, RetentionCollection, RetentionCollectionOutcome, RetentionReport, RetentionState,
  RetentionVersionEntry,
} from '@/types/plugin-retention';

/** Why a version is kept or retirable, in words. */
const RULE_LABEL: Record<string, string> = {
  // Ordering
  implicit_install: 'Newest of the major the implicit Official install follows',
  newest_in_major: 'Newest version of its major',
  within_keep: 'Within the newest versions kept per major',
  prerelease_ahead_of_stable: 'Prerelease with no newer stable version yet',
  // Installs
  install_pinned: 'An install pins it',
  install_resolved: 'An install resolved to it',
  install_pending_change: 'A pending install change asks for it',
  install_newest_admitted: 'Newest version an install policy admits',
  // References
  managed_toolchain: 'Managed toolchain (retired from the Toolchain console)',
  default_version: 'Default version',
  paused: 'Listed version is paused',
  pipeline_reference: 'A pipeline references it',
  deleted_pipeline_pin: 'A deleted pipeline still pins it',
  template_pin: 'A template pins it',
  publish_request_pending: 'A publish request is pending',
  declared_without_resolution: 'A pipeline declares the plugin without resolution rows',
  resolution_refresh_incomplete: 'Refresh of the pipelines naming it did not finish; nothing decided this pass',
  // Retirable
  superseded_in_major: 'Superseded within its major',
  superseded_prerelease: 'Superseded prerelease',
  finish_retirement: 'Yanked earlier; finishing its retirement',
  already_yanked: 'Already yanked',
  purged: 'Purged',
};

/** A rule code in words; an unknown code is shown as itself, readable. */
export function retentionRuleLabel(rule: string): string {
  return RULE_LABEL[rule] ?? rule.replace(/_/g, ' ');
}

const STATE_LABEL: Record<RetentionState, string> = {
  keep: 'Kept',
  deprecate: 'Deprecate',
  notice: 'In notice',
  yank: 'Yank',
  reverse: 'Reverse deprecation',
  refused: 'Refused',
};

/** A state in words; an unknown one is shown as itself. */
export function retentionStateLabel(state: string): string {
  return STATE_LABEL[state as RetentionState] ?? state;
}

/** Badge colour for a state. */
export function retentionStateColor(state: string): 'green' | 'yellow' | 'red' | 'blue' | 'gray' {
  switch (state) {
    case 'keep': return 'green';
    case 'deprecate': case 'notice': return 'yellow';
    case 'yank': return 'red';
    case 'reverse': return 'blue';
    default: return 'gray';
  }
}

const ACTION_LABEL: Record<RetentionAction, string> = {
  deprecated: 'Deprecated',
  yanked: 'Yanked',
  reversed: 'Reversed',
  deferred: 'Deferred',
  skipped: 'Skipped',
  failed: 'Failed',
};

export function retentionActionLabel(action: string): string {
  return ACTION_LABEL[action as RetentionAction] ?? action;
}

const OUTCOME_LABEL: Record<RetentionCollectionOutcome, string> = {
  collected: 'Collected',
  already_gone: 'Already gone',
  held: 'Held',
  refused_by_registry: 'Refused by the registry',
  failed: 'Failed',
};

export function retentionOutcomeLabel(outcome: string): string {
  return OUTCOME_LABEL[outcome as RetentionCollectionOutcome] ?? outcome;
}

/** The per-pass throttle holds this version for a later pass. */
export function isDeferred(v: Pick<RetentionVersionEntry, 'deferred' | 'action'>): boolean {
  return v.deferred === true || v.action === 'deferred';
}

/** States that retire (or un-retire) a version: everything but `keep`. */
export function isActionable(v: Pick<RetentionVersionEntry, 'state'>): boolean {
  return v.state !== 'keep';
}

/** Whether the report's byte figures can be trusted. */
export function bytesMeasured(storage: RetentionReport['storage']): boolean {
  return storage.measured && !storage.incomplete;
}

/** Bytes formatted, or "not measured" when the figure is null or the measurement incomplete. */
export function reclaimableText(bytes: number | null | undefined, storage: RetentionReport['storage']): string {
  if (bytes === null || bytes === undefined || !bytesMeasured(storage)) return 'not measured';
  return formatBytes(bytes);
}

/** A fraction as a whole percent. */
export function fractionText(f: number): string {
  return `${Math.round(f * 100)}%`;
}

/** Versions the per-plugin throttle deferred: the plan's flag, plus a run's `deferred` action (which also covers the per-pass batch cap). */
export function deferredCount(report: Pick<RetentionReport, 'plugins'>): number {
  return report.plugins.reduce((n, p) => n + p.versions.filter(isDeferred).length, 0);
}

/** The totals row, in display order. `refused` appears only when non-zero. */
export function retentionTotalsLines(report: Pick<RetentionReport, 'plugins' | 'totals' | 'storage'>): { label: string; value: string }[] {
  const t = report.totals;
  const lines = [
    { label: 'Retirable', value: String(t.retirable) },
    { label: 'Deprecate', value: String(t.deprecate) },
    { label: 'In notice', value: String(t.notice) },
    { label: 'Yank', value: String(t.yank) },
    { label: 'Reverse', value: String(t.reverse) },
    { label: 'Deferred', value: String(Math.max(t.deferred, deferredCount(report))) },
  ];
  if (t.refused > 0 || t.refusedPlugins > 0) {
    lines.push({ label: 'Refused', value: `${t.refused} (${t.refusedPlugins} plugin${t.refusedPlugins === 1 ? '' : 's'})` });
  }
  lines.push(
    { label: 'Awaiting collection', value: String(t.awaitingCollection) },
    { label: 'Stuck', value: String(t.stuck) },
    { label: 'Reclaimable', value: reclaimableText(t.marginalBytes, report.storage) },
  );
  return lines;
}

/** The scheduled-pass configuration, in words. */
export function retentionConfigText(report: Pick<RetentionReport, 'enabled' | 'keep' | 'noticeDays' | 'batch' | 'maxFraction'>): string {
  const state = report.enabled ? 'Scheduled pass enabled' : 'Scheduled pass disabled';
  return `${state} · keep ${report.keep} per major · ${report.noticeDays}-day notice · deprecates up to ${fractionText(report.maxFraction)} of a plugin's live versions per pass · ${report.batch} actions per pass`;
}

/**
 * Whether "Run a pass now" may be pressed, and why not. The run route acts
 * whatever the scheduled switch says, so `enabled` does not block it; only the
 * permission and a writable session do.
 */
export function runAvailability(input: { mayModerate: boolean; readOnly: boolean }): { allowed: boolean; reason: string | null } {
  if (!input.mayModerate) return { allowed: false, reason: 'Requires plugins:moderate' };
  if (input.readOnly) return { allowed: false, reason: 'This session is read-only' };
  return { allowed: true, reason: null };
}

/** What a run did: counts per action, the versions that failed or were skipped, and the collections. */
export function runOutcome(report: Pick<RetentionReport, 'plugins' | 'collected'>): {
  actions: { action: RetentionAction; count: number }[];
  problems: { ref: string; action: string; error: string }[];
  collected: { outcome: RetentionCollectionOutcome; count: number }[];
  collectionProblems: RetentionCollection[];
} {
  const actionCounts = new Map<RetentionAction, number>();
  const problems: { ref: string; action: string; error: string }[] = [];
  for (const p of report.plugins) {
    for (const v of p.versions) {
      if (!v.action) continue;
      actionCounts.set(v.action, (actionCounts.get(v.action) ?? 0) + 1);
      if ((v.action === 'failed' || v.action === 'skipped') && v.error) problems.push({ ref: `${p.name}@${v.version}`, action: v.action, error: v.error });
    }
  }
  const outcomeCounts = new Map<RetentionCollectionOutcome, number>();
  for (const c of report.collected) outcomeCounts.set(c.outcome, (outcomeCounts.get(c.outcome) ?? 0) + 1);
  const order = Object.keys(ACTION_LABEL) as RetentionAction[];
  const outcomeOrder = Object.keys(OUTCOME_LABEL) as RetentionCollectionOutcome[];
  return {
    actions: order.filter((a) => actionCounts.has(a)).map((a) => ({ action: a, count: actionCounts.get(a)! })),
    problems,
    collected: outcomeOrder.filter((o) => outcomeCounts.has(o)).map((o) => ({ outcome: o, count: outcomeCounts.get(o)! })),
    collectionProblems: report.collected.filter((c) => c.outcome === 'failed' || c.outcome === 'refused_by_registry' || c.outcome === 'held'),
  };
}
