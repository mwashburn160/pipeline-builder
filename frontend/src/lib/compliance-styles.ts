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
  critical: { icon: AlertCircle, color: 'text-danger-strong', bg: 'bg-danger-bg' },
  error: { icon: AlertTriangle, color: 'text-danger', bg: 'bg-danger-bg' },
  warning: { icon: Info, color: 'text-warning', bg: 'bg-warning-bg' },
};

/** Severity badge classes (combined bg + text). */
export const SEVERITY_BADGE: Record<RuleSeverity, string> = {
  warning: 'bg-warning-bg text-warning',
  error: 'bg-danger-bg text-danger',
  critical: 'bg-danger-bg text-danger-strong ring-1 ring-danger-border',
};

/** Scan status badge with icon, color, and background classes. */
export const SCAN_STATUS_CONFIG: Record<ScanStatus, { icon: typeof CheckCircle; color: string; bg: string }> = {
  pending: { icon: Clock, color: 'text-warning', bg: 'bg-warning-bg' },
  running: { icon: Loader2, color: 'text-brand', bg: 'bg-info-bg' },
  completed: { icon: CheckCircle, color: 'text-success', bg: 'bg-success-bg' },
  failed: { icon: XCircle, color: 'text-danger', bg: 'bg-danger-bg' },
  cancelled: { icon: Square, color: 'text-fg-muted', bg: 'bg-surface-muted' },
};

/** Exemption status badge classes. */
export const EXEMPTION_STATUS_STYLES: Record<ExemptionStatus, { bg: string; text: string }> = {
  pending: { bg: 'bg-warning-bg', text: 'text-warning' },
  approved: { bg: 'bg-success-bg', text: 'text-success' },
  rejected: { bg: 'bg-danger-bg', text: 'text-danger' },
  expired: { bg: 'bg-surface-muted', text: 'text-fg-muted' },
};

/** Compliance check result badge classes (pass/warn/block). */
export const RESULT_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  pass: { bg: 'bg-success-bg', text: 'text-success', label: 'Pass' },
  warn: { bg: 'bg-warning-bg', text: 'text-warning', label: 'Warn' },
  block: { bg: 'bg-danger-bg', text: 'text-danger', label: 'Block' },
};

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
