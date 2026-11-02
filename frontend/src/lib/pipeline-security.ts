// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure helpers behind a pipeline's Plugin security tab: the risk-acceptance
 * window, KEV detection on an exposure, and the triage body. Kept out of the
 * components so the rules are unit-testable.
 */

import type { ExposureTriageBody, PipelineExposureView, PipelineSecurity } from './api/pipeline-security-types';
import { SEVERITY_LABELS, asVulnSeverity, sortBySeverity } from './plugin-vulns';

/**
 * The longest a risk acceptance may run — the plugin service's default
 * `PLUGIN_RISK_ACCEPTANCE_MAX_DAYS`. A deployment may set it lower; the server's
 * 400 then names its own limit.
 */
export const RISK_ACCEPTANCE_MAX_DAYS = 90;

const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` of a date in the viewer's local calendar. */
export function localDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

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

/** `sha256:abcdef123456…` → `abcdef123456` (12 hex), or the input when it isn't a digest. */
export function shortDigest(digest: string | null | undefined): string {
  if (!digest) return '—';
  const hex = digest.replace(/^sha256:/, '');
  return hex.length > 12 ? hex.slice(0, 12) : hex;
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
