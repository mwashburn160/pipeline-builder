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
  pending: { icon: Clock, color: 'text-yellow-600', bg: 'bg-yellow-100 dark:bg-yellow-900/30' },
  running: { icon: Loader2, color: 'text-blue-600', bg: 'bg-blue-100 dark:bg-blue-900/30' },
  completed: { icon: CheckCircle, color: 'text-green-600', bg: 'bg-green-100 dark:bg-green-900/30' },
  failed: { icon: XCircle, color: 'text-red-600', bg: 'bg-red-100 dark:bg-red-900/30' },
  cancelled: { icon: Square, color: 'text-gray-500', bg: 'bg-gray-100 dark:bg-gray-700' },
};

/** Exemption status badge classes. */
export const EXEMPTION_STATUS_STYLES: Record<ExemptionStatus, { bg: string; text: string }> = {
  pending: { bg: 'bg-yellow-100 dark:bg-yellow-900/30', text: 'text-yellow-700 dark:text-yellow-400' },
  approved: { bg: 'bg-green-100 dark:bg-green-900/30', text: 'text-green-700 dark:text-green-400' },
  rejected: { bg: 'bg-red-100 dark:bg-red-900/30', text: 'text-red-700 dark:text-red-400' },
  expired: { bg: 'bg-gray-100 dark:bg-gray-700', text: 'text-gray-500 dark:text-gray-400' },
};
