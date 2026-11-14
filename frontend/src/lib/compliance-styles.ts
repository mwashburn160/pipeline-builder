// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared compliance UI styling constants.
 * Centralizes severity, scan status, and exemption status visual config
 * used across compliance components.
 */
import { AlertCircle, AlertTriangle, CheckCircle, Clock, Info, Loader2, Square, XCircle } from 'lucide-react';
import type { BadgeColor } from '@/components/ui/Badge';
import {
  COMPLIANCE_CHECK_RESULTS, COMPLIANCE_EXEMPTION_STATUSES, COMPLIANCE_SCAN_STATUSES, RULE_SCOPES, RULE_SEVERITIES, RULE_TARGETS,
  type ComplianceCheckVerdict, type ComplianceExemptionStatus, type ComplianceScanStatus, type RuleScope, type RuleSeverity, type RuleTarget,
} from '@pipeline-builder/api-core/wire-vocabulary';

/**
 * Compliance statuses, in the SAME vocabulary as every other status surface —
 * {@link BadgeColor}, rendered by `<Badge>`. These were raw Tailwind `bg`/`text`
 * pairs fed to `StatusPill`, which is how `pending` ended up yellow here and
 * blue on the invitations page.
 */

/** Severity: label, colour and the icon that goes in front of it — most severe first. */
export const SEVERITY_CONFIG: Record<RuleSeverity, { label: string; icon: typeof AlertCircle; color: BadgeColor; className?: string }> = {
  // `critical` and `error` are both red; the ring is what separates them (the
  // token set is brand + success/warning/danger/info, with no second red).
  critical: { label: 'Critical', icon: AlertCircle, color: 'red', className: 'ring-1 ring-danger-border' },
  error: { label: 'Error', icon: AlertTriangle, color: 'red' },
  warning: { label: 'Warning', icon: Info, color: 'yellow' },
};
/** Every rule severity, most severe first (a filter's order; an editor reverses it) — api-core's ladder, reversed. */
export const RULE_SEVERITY_IDS: readonly RuleSeverity[] = [...RULE_SEVERITIES].reverse();

/** The label for a severity off the wire, or null for one this build doesn't know. */
export function ruleSeverityLabel(severity: string): string | null {
  return Object.hasOwn(SEVERITY_CONFIG, severity) ? SEVERITY_CONFIG[severity as RuleSeverity].label : null;
}

/** What a rule evaluates. */
export const RULE_TARGET_LABELS: Record<RuleTarget, string> = {
  plugin: 'Plugin',
  pipeline: 'Pipeline',
};
export const RULE_TARGET_IDS: readonly RuleTarget[] = RULE_TARGETS;

/** Where a rule lives: the short filter label and the editor's explanation. */
export const RULE_SCOPE_META: Record<RuleScope, { label: string; description: string }> = {
  org: { label: 'Org', description: 'private to your organization' },
  published: { label: 'Published', description: 'shared catalog, other orgs can subscribe' },
};
export const RULE_SCOPE_IDS: readonly RuleScope[] = RULE_SCOPES;

/** Scan status: label, colour and icon. */
export const SCAN_STATUS_CONFIG = {
  pending: { label: 'Pending', icon: Clock, color: 'yellow' },
  running: { label: 'Running', icon: Loader2, color: 'blue' },
  completed: { label: 'Completed', icon: CheckCircle, color: 'green' },
  failed: { label: 'Failed', icon: XCircle, color: 'red' },
  cancelled: { label: 'Cancelled', icon: Square, color: 'gray' },
} as const satisfies Record<ComplianceScanStatus, { label: string; icon: typeof CheckCircle; color: BadgeColor }>;
export const SCAN_STATUS_IDS: readonly ComplianceScanStatus[] = COMPLIANCE_SCAN_STATUSES;

/**
 * Exemption status. The filter offers every key — it used to hand-list three
 * and leave out `expired`, which the list route accepts, so an expired
 * exemption could not be found except by scrolling "All".
 */
export const EXEMPTION_STATUS_META = {
  pending: { label: 'Pending', color: 'yellow' },
  approved: { label: 'Approved', color: 'green' },
  rejected: { label: 'Rejected', color: 'red' },
  expired: { label: 'Expired', color: 'gray' },
} as const satisfies Record<ComplianceExemptionStatus, { label: string; color: BadgeColor }>;
export const EXEMPTION_STATUS_IDS: readonly ComplianceExemptionStatus[] = COMPLIANCE_EXEMPTION_STATUSES;

/** Compliance check result (pass/warn/block). */
export const RESULT_STYLES = {
  pass: { color: 'green', label: 'Pass' },
  warn: { color: 'yellow', label: 'Warn' },
  block: { color: 'red', label: 'Block' },
} as const satisfies Record<ComplianceCheckVerdict, { color: BadgeColor; label: string }>;
export const COMPLIANCE_RESULT_IDS: readonly ComplianceCheckVerdict[] = COMPLIANCE_CHECK_RESULTS;

/**
 * A result off the wire as a badge. An unrecognised result is shown RAW and
 * neutral: this fell back to "Pass", so a result this build doesn't know read
 * as a passed check.
 */
export function resultStyle(result: string): { color: BadgeColor; label: string } {
  return Object.hasOwn(RESULT_STYLES, result)
    ? RESULT_STYLES[result as ComplianceCheckVerdict]
    : { color: 'gray', label: result };
}

/**
 * Human copy for a compliance audit entry's `action` — the five verbs the
 * `compliance_audit_log.action` column stores (upload | deploy | create |
 * update | scan), paired with the `target` (plugin | pipeline) that gives them
 * meaning — the bare code (`upload`) is a database value, not a sentence.
 *
 * An unknown action degrades to the raw code rather than being dropped — a new
 * backend verb must still show up in the feed while this map catches up.
 */
const COMPLIANCE_ACTION_VERBS: Record<string, string> = {
  upload: 'Upload of',
  deploy: 'Deployment of',
  create: 'Creation of',
  update: 'Change to',
  scan: 'Scan of',
};

/**
 * "Upload of plugin" / "Change to pipeline" — the subject line for one audit
 * entry, with the entity name (when known) appended by the caller.
 */
export function complianceActionLabel(action: string, target?: string): string {
  const verb = COMPLIANCE_ACTION_VERBS[action] ?? action;
  return target ? `${verb} ${target}` : verb;
}
