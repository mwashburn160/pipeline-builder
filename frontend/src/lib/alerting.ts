// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Alert rule severity and alert-destination channel, each keyed by its wire id.
 *
 * The destinations page spelled the channel out four times — a colour ladder,
 * an icon if-chain, the target field's label, and two option lists — and the
 * rules and destinations pages each coloured severity with their own ternary.
 * One table each, typed by the union, so a new channel or severity is a compile
 * error on every surface instead of a silent grey fallback on some of them.
 */

import { ALERT_CHANNELS, ALERT_RULE_SEVERITIES, type AlertChannel, type AlertRuleSeverity } from '@pipeline-builder/api-core/wire-vocabulary';
import { PLUGIN_REMEDIATION_METRICS } from '@pipeline-builder/api-core/plugin-scan';
import { Bell, Mail, MessageSquare, Webhook, type LucideIcon } from 'lucide-react';
import type { BadgeColor } from '@/components/ui/Badge';

/** Least to most severe — a destination's minimum includes everything after it. */
export const ALERT_SEVERITY_META: Record<AlertRuleSeverity, { label: string; color: BadgeColor; minimumLabel: string }> = {
  warning: { label: 'Warning', color: 'yellow', minimumLabel: 'Warning + Critical' },
  critical: { label: 'Critical', color: 'red', minimumLabel: 'Critical only' },
};
export const ALERT_SEVERITY_IDS: readonly AlertRuleSeverity[] = ALERT_RULE_SEVERITIES;

export const ALERT_CHANNEL_META: Record<AlertChannel, {
  /** Short name (filters, badges). */
  label: string;
  /** What the create picker calls it. */
  optionLabel: string;
  color: BadgeColor;
  icon: LucideIcon;
  iconClass: string;
  /** The target field's label and placeholder; null when the channel has no target. */
  target: { label: string; placeholder: string } | null;
  /** Whether the target is a bearer-equivalent URL (masked) or plain text. */
  secretTarget: boolean;
  /**
   * False for a channel with no delivery path yet — still listed, disabled, so
   * an existing destination on it labels correctly on edit.
   */
  deliverable: boolean;
}> = {
  slack: {
    label: 'Slack', optionLabel: 'Slack incoming webhook', color: 'purple',
    icon: MessageSquare, iconClass: 'text-purple-600 dark:text-purple-400',
    target: { label: 'Slack incoming-webhook URL', placeholder: 'https://hooks.slack.com/services/...' }, secretTarget: true, deliverable: true,
  },
  webhook: {
    label: 'Webhook', optionLabel: 'Generic HTTPS webhook', color: 'blue',
    icon: Webhook, iconClass: 'text-brand',
    target: { label: 'Webhook URL', placeholder: 'https://...' }, secretTarget: true, deliverable: true,
  },
  email: {
    label: 'Email', optionLabel: 'Email recipient', color: 'green',
    icon: Mail, iconClass: 'text-success',
    target: { label: 'Email address', placeholder: 'ops@example.com' }, secretTarget: false, deliverable: true,
  },
  // In-app delivery has no real delivery path yet (the relay only logs it).
  'in-app': {
    label: 'In-app', optionLabel: 'In-app message (coming soon — not yet delivered)', color: 'gray',
    icon: Bell, iconClass: 'text-fg-muted',
    target: null, secretTarget: false, deliverable: false,
  },
};
/** api-core's channel list, deliverable channels first (a picker offers what works before what is coming). */
export const ALERT_CHANNEL_IDS: readonly AlertChannel[] = [...ALERT_CHANNELS]
  .sort((a, b) => Number(ALERT_CHANNEL_META[b].deliverable) - Number(ALERT_CHANNEL_META[a].deliverable));

/**
 * A destination's channel off the wire. A channel this build doesn't know
 * renders as the inert `in-app` row (grey, bell, no target) rather than
 * throwing — the table must still list the destination.
 */
export function alertChannelMeta(channel: string): (typeof ALERT_CHANNEL_META)[AlertChannel] {
  return Object.hasOwn(ALERT_CHANNEL_META, channel)
    ? ALERT_CHANNEL_META[channel as AlertChannel]
    : ALERT_CHANNEL_META['in-app'];
}

/** A severity off the wire; an unknown one is badged like a warning. */
export function alertSeverityMeta(severity: string): (typeof ALERT_SEVERITY_META)[AlertRuleSeverity] {
  return Object.hasOwn(ALERT_SEVERITY_META, severity)
    ? ALERT_SEVERITY_META[severity as AlertRuleSeverity]
    : ALERT_SEVERITY_META.warning;
}

/**
 * Alerts the PLATFORM ships (deploy alert-rules.yml, evaluated by the
 * operator's Prometheus), listed read-only beside an org's own rules so a
 * reader knows what is already watched. They page the operator, not this
 * org's destinations, and cannot be edited here.
 */
export interface BuiltInAlertRule {
  id: string;
  name: string;
  severity: AlertRuleSeverity;
  /** What it watches, as PromQL over the metric (illustrative of the shipped rule). */
  watches: string;
  summary: string;
}

export const BUILT_IN_ALERT_RULES: readonly BuiltInAlertRule[] = [
  {
    id: 'plugin-remediation-failures',
    name: 'Plugin remediation failures',
    severity: 'warning',
    watches: `increase(${PLUGIN_REMEDIATION_METRICS.remediations}{outcome="error"}[1h]) > 0`,
    summary: 'A nightly CVE remediation job failed (build infrastructure, checksum mismatch or an internal error).',
  },
  {
    id: 'plugin-source-delete-failures',
    name: 'Plugin source delete failures',
    severity: 'warning',
    watches: `increase(${PLUGIN_REMEDIATION_METRICS.sourceDeleteFailures}[1h]) > 0`,
    summary: 'A purge could not delete a kept plugin source, image or prefix; it is recorded as an orphan and retried by the next sweep.',
  },
  {
    id: 'plugin-source-missing',
    name: 'Missing plugin sources',
    severity: 'warning',
    watches: 'increase(plugin_source_missing_total[1h]) > 0',
    summary: 'A version\'s kept build source was missing (for example after a restore); it can now only be remediated with an overlay layer.',
  },
  {
    id: 'plugin-source-checksum-mismatch',
    name: 'Plugin source checksum mismatch',
    severity: 'critical',
    watches: 'increase(plugin_source_checksum_mismatch_total[1h]) > 0',
    summary: 'A kept build source no longer matches the SHA-256 recorded when it was kept: treat it as tampering. Nothing was built from it.',
  },
  {
    id: 'plugin-remediation-canary-stale',
    name: 'Stale remediation canary',
    severity: 'warning',
    watches: 'The nightly fixture canary in the system org has not been flagged and fixed on schedule',
    summary: 'The per-package-type fixture plugins stopped being flagged and fixed: the scanner or a patcher broke.',
  },
];
