// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared compliance UI styling constants.
 * Centralizes severity, scan status, and exemption status visual config
 * used across compliance components.
 */
import { AlertCircle, AlertTriangle, CheckCircle, Clock, Info, Loader2, Square, XCircle } from 'lucide-react';
import type { ExemptionStatus, RuleSeverity, ScanStatus } from '../types/compliance';

/** Severity badge with icon, color, and background classes. */
export const SEVERITY_CONFIG: Record<RuleSeverity, { icon: typeof AlertCircle; color: string; bg: string }> = {
  critical: { icon: AlertCircle, color: 'text-red-600 dark:text-red-400', bg: 'bg-red-100 dark:bg-red-900/30' },
  error: { icon: AlertTriangle, color: 'text-orange-600 dark:text-orange-400', bg: 'bg-orange-100 dark:bg-orange-900/30' },
  warning: { icon: Info, color: 'text-yellow-600 dark:text-yellow-400', bg: 'bg-yellow-100 dark:bg-yellow-900/30' },
};

/** Severity badge classes (combined bg + text). */
export const SEVERITY_BADGE: Record<RuleSeverity, string> = {
  warning: 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400',
  error: 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400',
  critical: 'bg-red-200 dark:bg-red-900/50 text-red-800 dark:text-red-300',
};

/** Scan status badge with icon, color, and background classes. */
export const SCAN_STATUS_CONFIG: Record<ScanStatus, { icon: typeof CheckCircle; color: string; bg: string }> = {
  pending: { icon: Clock, color: 'text-warning', bg: 'bg-yellow-100 dark:bg-yellow-900/30' },
  running: { icon: Loader2, color: 'text-brand', bg: 'bg-blue-100 dark:bg-blue-900/30' },
  completed: { icon: CheckCircle, color: 'text-success', bg: 'bg-green-100 dark:bg-green-900/30' },
  failed: { icon: XCircle, color: 'text-danger', bg: 'bg-red-100 dark:bg-red-900/30' },
  cancelled: { icon: Square, color: 'text-fg-muted', bg: 'bg-gray-100 dark:bg-gray-700' },
};

/** Exemption status badge classes. */
export const EXEMPTION_STATUS_STYLES: Record<ExemptionStatus, { bg: string; text: string }> = {
  pending: { bg: 'bg-yellow-100 dark:bg-yellow-900/30', text: 'text-yellow-700 dark:text-yellow-400' },
  approved: { bg: 'bg-green-100 dark:bg-green-900/30', text: 'text-green-700 dark:text-green-400' },
  rejected: { bg: 'bg-red-100 dark:bg-red-900/30', text: 'text-red-700 dark:text-red-400' },
  expired: { bg: 'bg-gray-100 dark:bg-gray-700', text: 'text-fg-muted' },
};

/** Compliance check result badge classes (pass/warn/block). */
export const RESULT_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  pass: { bg: 'bg-green-100 dark:bg-green-900/30', text: 'text-green-700 dark:text-green-400', label: 'Pass' },
  warn: { bg: 'bg-yellow-100 dark:bg-yellow-900/30', text: 'text-yellow-700 dark:text-yellow-400', label: 'Warn' },
  block: { bg: 'bg-red-100 dark:bg-red-900/30', text: 'text-red-700 dark:text-red-400', label: 'Block' },
};

/**
 * Human copy for a compliance audit entry's `action` — the five verbs the
 * `compliance_audit_log.action` column stores (upload | deploy | create |
 * update | scan), paired with the `target` (plugin | pipeline) that gives them
 * meaning. Both dashboards printed the bare code in a `<code>` block, so an org
 * admin's "recent violations" list read `upload`, which is a database value, not
 * a sentence.
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
