// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The visual vocabulary of a severity-graded vulnerability warning — one badge,
 * one icon and one text colour per grade, shared by the editor's lookup
 * preview, the save-time plugin warnings and the pipeline's Plugin security
 * tab. Vulnerability state never blocks a pipeline, so nothing here says
 * "blocked": the loudest grade is `critical` (a CISA known-exploited finding).
 */

import { Info, ShieldAlert, ShieldCheck, ShieldX, AlertTriangle, type LucideIcon } from 'lucide-react';
import { Badge, type BadgeColor } from '@/components/ui/Badge';
import {
  LOOKUP_WARNING_TITLES, SEVERITY_LABELS, asVulnSeverity, describeFinding, normalizeVulnFindings, sortBySeverity,
  type VulnGrade,
} from '@/lib/plugin-vulns';

const BADGE_COLOR: Record<VulnGrade, BadgeColor> = {
  ok: 'green', info: 'blue', warning: 'yellow', error: 'red', critical: 'red',
};

const ICON: Record<VulnGrade, LucideIcon> = {
  ok: ShieldCheck, info: Info, warning: AlertTriangle, error: ShieldAlert, critical: ShieldX,
};

/** Text colour per grade for inline warning lines. */
export const SEVERITY_TEXT: Record<VulnGrade, string> = {
  ok: 'text-success-strong',
  info: 'text-fg-muted',
  warning: 'text-warning-strong',
  error: 'text-danger-strong',
  critical: 'text-danger-strong font-semibold',
};

/** The grade as a pill (`critical` is bold, so it never reads as a plain error). */
export function VulnSeverityBadge({ grade, className = '' }: { grade: VulnGrade; className?: string }) {
  const Icon = ICON[grade];
  return (
    <Badge color={BADGE_COLOR[grade]} className={`gap-1 ${grade === 'critical' ? 'font-bold uppercase' : ''} ${className}`}>
      <Icon className="h-3 w-3" aria-hidden />
      {SEVERITY_LABELS[grade]}
    </Badge>
  );
}

/** The icon for a grade. */
export function VulnSeverityIcon({ grade, className = 'mt-0.5 h-3.5 w-3.5 shrink-0' }: { grade: VulnGrade; className?: string }) {
  const Icon = ICON[grade];
  return <Icon className={className} aria-label={SEVERITY_LABELS[grade]} />;
}

/** One warning as any of the three surfaces receives it. */
export interface GradedWarning {
  code: string;
  message: string;
  severity?: string;
  suggestedVersion?: string;
  findings?: unknown;
  /** Save-time warnings name the step and plugin. */
  stepKey?: string;
  plugin?: string;
}

/**
 * Warnings loudest first, each with its grade's icon and colour, the code's
 * heading, the server's message, the version that clears it (when the server
 * named one) and up to three findings.
 */
export function VulnWarningList({ warnings, label = 'Plugin vulnerability warnings', showStep = false, testId, itemTestId }: {
  warnings: readonly GradedWarning[];
  label?: string;
  /** Prefix each line with its step / plugin (the save-time list spans steps). */
  showStep?: boolean;
  testId?: string;
  /** Per-item test id (defaults to `plugin-vuln-<code>`). */
  itemTestId?: (w: GradedWarning) => string;
}) {
  if (warnings.length === 0) return null;
  return (
    <ul className="space-y-1 text-xs" aria-label={label} data-testid={testId}>
      {sortBySeverity(warnings).map((w, i) => {
        const grade = asVulnSeverity(w.severity);
        const findings = normalizeVulnFindings(w.findings);
        return (
          <li
            key={`${w.stepKey ?? ''}:${w.code}:${w.plugin ?? ''}:${i}`}
            className={`flex items-start gap-1.5 ${SEVERITY_TEXT[grade]}`}
            data-severity={grade}
            data-testid={itemTestId ? itemTestId(w) : `plugin-vuln-${w.code === 'VULN_FLAGGED' ? 'flagged' : w.code.toLowerCase().replace(/_/g, '-')}`}
          >
            <VulnSeverityIcon grade={grade} />
            <span>
              {showStep && (w.stepKey || w.plugin) && (
                <span className="font-mono text-fg-muted">{[w.stepKey, w.plugin].filter(Boolean).join(' · ')} — </span>
              )}
              <span className="font-medium">{LOOKUP_WARNING_TITLES[w.code] ?? w.code}: </span>
              {w.message}
              {w.suggestedVersion && (
                <span className="block font-medium" data-testid="plugin-vuln-suggested">
                  Suggested version: <span className="font-mono">{w.suggestedVersion}</span>
                </span>
              )}
              {findings.length > 0 && (
                <span className="block font-mono text-fg-muted">
                  {findings.slice(0, 3).map(describeFinding).join('; ')}
                </span>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
