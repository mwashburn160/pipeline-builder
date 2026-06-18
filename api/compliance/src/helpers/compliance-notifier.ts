// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, errorMessage } from '@pipeline-builder/api-core';
import {
  getNotificationChannel,
  type ChannelTarget,
  type ComplianceNotification,
} from './notification-channels.js';
import type { Violation } from '../engine/rule-engine.js';
import {
  getNotificationPreference,
  recordNotificationLog,
  recordPendingDigest,
  type ComplianceNotificationPreference,
} from '../services/notification-service.js';

const logger = createLogger('compliance-notifier');

/** Per-channel delivery timeout. Tight on purpose — a slow webhook receiver
 *  shouldn't hold up the (fire-and-forget) notification. */
const DELIVERY_TIMEOUT_MS = parseInt(process.env.COMPLIANCE_NOTIFY_TIMEOUT_MS || '5000', 10);

type NotificationKind = 'block' | 'warning';

/** Build the in-app/webhook/email notification for a compliance result. */
function buildNotification(
  kind: NotificationKind,
  orgId: string,
  target: string,
  entityName: string,
  violations: Violation[],
): ComplianceNotification {
  const summary = violations
    .map((v) => `- ${v.ruleName}: ${v.message} (${v.severity})`)
    .join('\n');

  if (kind === 'block') {
    return {
      recipientOrgId: orgId,
      messageType: 'conversation',
      priority: 'high',
      subject: `Compliance violation: ${target} "${entityName}" blocked`,
      content: `A ${target} operation was blocked by compliance rules.\n\n**Entity:** ${entityName}\n**Violations:**\n${summary}`,
      payload: {
        event: 'compliance.block',
        orgId,
        target,
        entityName,
        violations: violations.map((v) => ({ ruleId: v.ruleId, ruleName: v.ruleName, message: v.message, severity: v.severity })),
      },
    };
  }

  return {
    recipientOrgId: orgId,
    messageType: 'conversation',
    priority: 'normal',
    subject: `Compliance warnings: ${target} "${entityName}"`,
    content: `A ${target} operation raised compliance warnings (not blocked).\n\n**Entity:** ${entityName}\n**Warnings:**\n${summary}`,
    payload: {
      event: 'compliance.warning',
      orgId,
      target,
      entityName,
      warnings: violations.map((v) => ({ ruleId: v.ruleId, ruleName: v.ruleName, message: v.message, severity: v.severity })),
    },
  };
}

/** Deliver on one channel with a bounded timeout, then append to the audit log.
 *  Never throws. */
async function dispatch(
  orgId: string,
  channelName: 'in-app' | 'webhook' | 'email',
  target: ChannelTarget,
  notification: ComplianceNotification,
): Promise<void> {
  const channel = getNotificationChannel(channelName);
  if (!channel) return;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
  let result;
  try {
    result = await channel.deliver(notification, target, controller.signal);
  } catch (err) {
    result = { ok: false, error: errorMessage(err) };
  } finally {
    clearTimeout(timer);
  }

  await recordNotificationLog({
    orgId,
    channel: channelName,
    status: result.ok ? 'sent' : 'failed',
    payload: notification.payload,
    webhookResponseCode: result.code,
    webhookError: result.error,
  });
}

/** Fan a notification out to every channel the org has enabled: in-app always,
 *  webhook when a URL is configured, email when opted in. Sends now — used both
 *  for immediate delivery and by the digest scheduler when flushing. */
export async function dispatchImmediate(
  orgId: string,
  preference: ComplianceNotificationPreference | null,
  notification: ComplianceNotification,
): Promise<void> {
  await dispatch(orgId, 'in-app', {}, notification);

  if (preference?.webhookUrl) {
    await dispatch(orgId, 'webhook', { url: preference.webhookUrl, secret: preference.webhookSecret ?? undefined }, notification);
  }

  if (preference?.emailEnabled) {
    await dispatch(orgId, 'email', { targetUsers: preference.targetUsers ?? null }, notification);
  }
}

/** Route a notification: park it for the digest scheduler when the org runs a
 *  daily/weekly digest, otherwise deliver immediately. */
async function deliverToEnabledChannels(
  orgId: string,
  preference: ComplianceNotificationPreference | null,
  notification: ComplianceNotification,
): Promise<void> {
  if (preference && preference.digestMode && preference.digestMode !== 'immediate') {
    await recordPendingDigest(orgId, notification);
    return;
  }
  await dispatchImmediate(orgId, preference, notification);
}

/**
 * Shared block/warning path: drop suppressed items, read the org preference,
 * apply the per-kind severity gate, then fan out (or park for digest). Fire-and-
 * forget: errors are logged, never thrown.
 */
async function notify(
  kind: NotificationKind,
  orgId: string,
  target: string,
  entityName: string,
  items: Violation[],
  shouldNotify: (preference: ComplianceNotificationPreference | null) => boolean,
): Promise<void> {
  try {
    const notifiable = items.filter((v) => !v.suppressNotification);
    if (notifiable.length === 0) return;

    const preference = await getNotificationPreference(orgId);
    if (!shouldNotify(preference)) return;

    await deliverToEnabledChannels(orgId, preference, buildNotification(kind, orgId, target, entityName, notifiable));
  } catch (err) {
    logger.warn(`Failed to send compliance ${kind} notification`, { orgId, target, entityName, error: errorMessage(err) });
  }
}

/**
 * Notify an org that a compliance BLOCK occurred. Honours `notifyOnBlock`
 * (absent preference row → column default of on), delivers to every enabled
 * channel, and logs each attempt.
 */
export async function notifyComplianceBlock(
  orgId: string,
  target: string,
  entityName: string,
  violations: Violation[],
): Promise<void> {
  // Blocks notify by default — only an explicit notifyOnBlock=false opts out.
  return notify('block', orgId, target, entityName, violations, (p) => !p || p.notifyOnBlock);
}

/**
 * Notify an org about non-blocking compliance WARNINGS. Opt-in: only delivered
 * when the org's preference has `notifyOnWarning` set (absent row → off, so
 * default behaviour is unchanged).
 */
export async function notifyComplianceWarnings(
  orgId: string,
  target: string,
  entityName: string,
  warnings: Violation[],
): Promise<void> {
  // Warnings are opt-in — only delivered when notifyOnWarning is explicitly on.
  return notify('warning', orgId, target, entityName, warnings, (p) => !!p?.notifyOnWarning);
}
