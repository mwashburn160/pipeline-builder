// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure helpers behind a pipeline's Plugin security tab: the risk-acceptance
 * window, KEV detection on an exposure, and the triage body. Kept out of the
 * components so the rules are unit-testable.
 */

import { localDay } from './local-day';
import type { ExposureTriageBody, PipelineBuildImage, PipelineExposureView, PipelineSecurity } from './api/pipeline-security-types';
import { SEVERITY_LABELS, asVulnSeverity, sortBySeverity } from './plugin-vulns';

/**
 * The longest a risk acceptance may run — the plugin service's default
 * `PLUGIN_RISK_ACCEPTANCE_MAX_DAYS`. A deployment may set it lower; the server's
 * 400 then names its own limit.
 */
export const RISK_ACCEPTANCE_MAX_DAYS = 90;

const DAY_MS = 86_400_000;

/** The `min` / `max` of the acceptance date picker: tomorrow … today + max days. */
export function acceptanceWindow(now: Date = new Date(), maxDays = RISK_ACCEPTANCE_MAX_DAYS): { min: string; max: string; defaultValue: string } {
  return {
    min: localDay(new Date(now.getTime() + DAY_MS)),
    max: localDay(new Date(now.getTime() + maxDays * DAY_MS)),
    defaultValue: localDay(new Date(now.getTime() + 30 * DAY_MS)),
  };
}

/**
 * The ISO instant an acceptance chosen as `day` (`YYYY-MM-DD`) runs until: the
 * start of that day (UTC), clamped inside the server's window so a picker in a
 * timezone ahead of UTC can never overshoot it. Null for an invalid or past day.
 */
export function acceptedUntilIso(day: string, now: Date = new Date(), maxDays = RISK_ACCEPTANCE_MAX_DAYS): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const t = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(t)) return null;
  const ceiling = now.getTime() + maxDays * DAY_MS - 5 * 60_000;
  const until = Math.min(t, ceiling);
  if (until <= now.getTime()) return null;
  return new Date(until).toISOString();
}

/**
 * Whether accepting `exposure` needs the explicit KEV acknowledgement: any of
 * its stored findings is KEV-listed, or the step running it reports KEV
 * findings in its current scan.
 */
export function exposureHasKev(exposure: PipelineExposureView, security?: PipelineSecurity | null): boolean {
  if (exposure.topFindings.some((f) => f.kev === true)) return true;
  const step = security?.steps.find((s) => s.exposures.some((e) => e.id === exposure.id));
  return (step?.scan?.kev ?? 0) > 0;
}

/** Validation problem of a triage draft, or null when it can be sent. */
export function triageProblem(draft: { action: ExposureTriageBody['action']; reason: string; day: string; kevAck: boolean }, needsKev: boolean, now: Date = new Date()): string | null {
  if (draft.action === 'reopen') return null;
  if (!draft.reason.trim()) return draft.action === 'accept' ? 'Accepting a risk needs a reason.' : 'A false positive needs a reason.';
  if (draft.reason.trim().length > 2000) return 'Keep the reason under 2000 characters.';
  if (draft.action === 'accept') {
    if (!acceptedUntilIso(draft.day, now)) return `Choose a date from tomorrow to ${RISK_ACCEPTANCE_MAX_DAYS} days out.`;
    if (needsKev && !draft.kevAck) return 'This version has known-exploited (KEV) findings; tick the acknowledgement to accept them.';
  }
  return null;
}

/** The request body for a triage draft (assumes {@link triageProblem} returned null). */
export function triageBody(draft: { action: ExposureTriageBody['action']; reason: string; day: string; kevAck: boolean }, needsKev: boolean, now: Date = new Date()): ExposureTriageBody {
  if (draft.action === 'reopen') return { action: 'reopen', ...(draft.reason.trim() ? { reason: draft.reason.trim() } : {}) };
  if (draft.action === 'false_positive') return { action: 'false_positive', reason: draft.reason.trim() };
  return {
    action: 'accept',
    reason: draft.reason.trim(),
    acceptedUntil: acceptedUntilIso(draft.day, now) ?? undefined,
    ...(needsKev ? { kev: draft.kevAck } : {}),
  };
}

/**
 * The non-blocking toast a save answers when the server returned
 * `pluginWarnings` (create / update / bulk): its type follows the loudest
 * severity (`info` → info, louder → warning — never an error toast, the save
 * succeeded), the text names the count, the loudest grade and the first
 * message. Null when there is nothing to say.
 */
export function pluginWarningsToast(warnings: ReadonlyArray<{ severity?: string; message: string; stepKey?: string }> | undefined): { type: 'info' | 'warning'; message: string } | null {
  if (!warnings || warnings.length === 0) return null;
  const sorted = sortBySeverity(warnings.map((w) => ({ ...w, code: '' })));
  const loudest = asVulnSeverity(sorted[0]!.severity);
  const first = sorted[0]!;
  const n = warnings.length;
  return {
    type: loudest === 'info' ? 'info' : 'warning',
    message: `Saved with ${n} plugin warning${n === 1 ? '' : 's'} (loudest: ${SEVERITY_LABELS[loudest].toLowerCase()}). `
      + `${first.stepKey ? `${first.stepKey}: ` : ''}${first.message}${n > 1 ? ` (+${n - 1} more)` : ''} `
      + 'Vulnerabilities never block a pipeline — see its Plugin security tab.',
  };
}

/** What the Build image row says about how the release was chosen. */
export const RESOLVED_VIA_LABELS: Record<string, string> = {
  pin: 'Pinned by this pipeline',
  'org-default': 'Organization default',
  canary: 'Canary',
  default: 'Platform default',
};

/**
 * The run that carries the "toolchain X → Y" marker: the FIRST execution that
 * started at or after the deploy that changed the release. Null when nothing
 * changed, or no run has started since. Order-independent.
 */
export function toolchainChangeRunId(
  executions: ReadonlyArray<{ execution_id: string; started_at: string | null }> | null | undefined,
  change: PipelineBuildImage['change'] | null | undefined,
): string | null {
  if (!change || !executions) return null;
  const at = Date.parse(change.changedAt);
  if (Number.isNaN(at)) return null;
  let first: { id: string; t: number } | null = null;
  for (const ex of executions) {
    const t = ex.started_at ? Date.parse(ex.started_at) : Number.NaN;
    if (Number.isNaN(t) || t < at) continue;
    if (!first || t < first.t) first = { id: ex.execution_id, t };
  }
  return first?.id ?? null;
}
