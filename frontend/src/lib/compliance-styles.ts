// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared compliance UI styling constants.
 * Centralizes severity, scan status, and exemption status visual config
 * used across compliance components.
 */
import { AlertCircle, AlertTriangle, CheckCircle, Clock, Info, Loader2, Square, XCircle } from 'lucide-react';
import type { BadgeColor } from '@/components/ui/Badge';
import type { ExemptionStatus, RuleSeverity, ScanStatus } from '../types/compliance';

/**
 * Compliance statuses, in the SAME vocabulary as every other status surface —
 * {@link BadgeColor}, rendered by `<Badge>`. These were raw Tailwind `bg`/`text`
 * pairs fed to `StatusPill`, which is how `pending` ended up yellow here and
 * blue on the invitations page.
 */

/** Severity: colour plus the icon that goes in front of it. */
export const SEVERITY_CONFIG: Record<RuleSeverity, { icon: typeof AlertCircle; color: BadgeColor; className?: string }> = {
  // `critical` and `error` are both red; the ring is what separates them (the
  // token set is brand + success/warning/danger/info, with no second red).
  critical: { icon: AlertCircle, color: 'red', className: 'ring-1 ring-danger-border' },
  error: { icon: AlertTriangle, color: 'red' },
  warning: { icon: Info, color: 'yellow' },
};

/** Scan status: colour plus its icon. */
export const SCAN_STATUS_CONFIG: Record<ScanStatus, { icon: typeof CheckCircle; color: BadgeColor }> = {
  pending: { icon: Clock, color: 'yellow' },
  running: { icon: Loader2, color: 'blue' },
  completed: { icon: CheckCircle, color: 'green' },
  failed: { icon: XCircle, color: 'red' },
  cancelled: { icon: Square, color: 'gray' },
};

/** Exemption status. */
export const EXEMPTION_STATUS_COLOR: Record<ExemptionStatus, BadgeColor> = {
  pending: 'yellow',
  approved: 'green',
  rejected: 'red',
  expired: 'gray',
};

/** Compliance check result (pass/warn/block). */
export const RESULT_STYLES: Record<string, { color: BadgeColor; label: string }> = {
  pass: { color: 'green', label: 'Pass' },
  warn: { color: 'yellow', label: 'Warn' },
  block: { color: 'red', label: 'Block' },
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
