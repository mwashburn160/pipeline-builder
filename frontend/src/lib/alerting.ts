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
