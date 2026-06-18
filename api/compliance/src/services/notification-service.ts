// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Persistence for compliance notifications: read an org's delivery preferences
 * and append to the audit log. Split out from the notifiers so the channel
 * adapters stay DB-free and the orchestration in compliance-notifier reads
 * cleanly.
 */

import { createLogger, errorMessage } from '@pipeline-builder/api-core';
import { schema, withTenantTx } from '@pipeline-builder/pipeline-core';
import { and, eq, inArray } from 'drizzle-orm';
import type { ComplianceNotification } from '../helpers/notification-channels.js';

const logger = createLogger('compliance-notification-service');

export type ComplianceNotificationPreference = typeof schema.complianceNotificationPreference.$inferSelect;

/** Read an org's compliance notification preference, or null if it has none
 *  (callers treat absence as the column defaults — block notifications on). */
export async function getNotificationPreference(orgId: string): Promise<ComplianceNotificationPreference | null> {
  const [row] = await withTenantTx(async (tx) => tx
    .select()
    .from(schema.complianceNotificationPreference)
    .where(eq(schema.complianceNotificationPreference.orgId, orgId))
    .limit(1));
  return row ?? null;
}

/** Fields a caller may set on an org's notification preference. Only provided
 *  keys are written (absent = unchanged) so a webhook secret survives an edit
 *  that doesn't re-enter it. */
export interface NotificationPreferencePatch {
  notifyOnBlock?: boolean;
  notifyOnWarning?: boolean;
  emailEnabled?: boolean;
  digestMode?: string;
  targetUsers?: string[] | null;
  webhookUrl?: string | null;
  webhookSecret?: string | null;
}

/** Create or update an org's notification preference (unique on orgId). */
export async function upsertNotificationPreference(
  orgId: string,
  patch: NotificationPreferencePatch,
): Promise<ComplianceNotificationPreference> {
  const [row] = await withTenantTx(async (tx) => tx
    .insert(schema.complianceNotificationPreference)
    .values({ orgId, ...patch })
    .onConflictDoUpdate({
      target: schema.complianceNotificationPreference.orgId,
      set: { ...patch, updatedAt: new Date() },
    })
    .returning());
  return row;
}

export interface NotificationLogEntry {
  orgId: string;
  channel: 'in-app' | 'webhook' | 'email';
  status: 'sent' | 'failed';
  payload: Record<string, unknown>;
  webhookResponseCode?: number;
  webhookError?: string;
}

/** Append a delivery attempt to `compliance_notification_log`. Best-effort —
 *  a logging failure must never break (or be reported as) a notification. */
export async function recordNotificationLog(entry: NotificationLogEntry): Promise<void> {
  try {
    await withTenantTx(async (tx) => tx.insert(schema.complianceNotificationLog).values({
      orgId: entry.orgId,
      channel: entry.channel,
      status: entry.status,
      payload: entry.payload,
      webhookResponseCode: entry.webhookResponseCode ?? null,
      webhookError: entry.webhookError ?? null,
    }));
  } catch (err) {
    logger.warn('Failed to write compliance notification log', {
      orgId: entry.orgId, channel: entry.channel, error: errorMessage(err),
    });
  }
}

// -- Digest batching ---------------------------------------------------------
// When an org's digestMode is daily/weekly, a notification is parked as a
// `channel: 'digest'`, `status: 'pending'` log row instead of being sent. The
// digest scheduler later aggregates the pending rows into one delivery.

/** Park a notification for later digest delivery. Best-effort (never throws). */
export async function recordPendingDigest(orgId: string, notification: ComplianceNotification): Promise<void> {
  try {
    await withTenantTx(async (tx) => tx.insert(schema.complianceNotificationLog).values({
      orgId,
      channel: 'digest',
      status: 'pending',
      payload: notification as unknown as Record<string, unknown>,
    }));
  } catch (err) {
    logger.warn('Failed to record pending digest', { orgId, error: errorMessage(err) });
  }
}

/** Distinct orgs that currently have at least one pending digest entry. */
export async function getOrgsWithPendingDigests(): Promise<string[]> {
  const rows = await withTenantTx(async (tx) => tx
    .selectDistinct({ orgId: schema.complianceNotificationLog.orgId })
    .from(schema.complianceNotificationLog)
    .where(and(
      eq(schema.complianceNotificationLog.channel, 'digest'),
      eq(schema.complianceNotificationLog.status, 'pending'),
    )));
  return rows.map((r) => r.orgId);
}

export interface PendingDigestEntry { id: string; notification: ComplianceNotification }

/** Pending digest entries for an org, oldest first. */
export async function getPendingDigests(orgId: string): Promise<PendingDigestEntry[]> {
  const rows = await withTenantTx(async (tx) => tx
    .select({ id: schema.complianceNotificationLog.id, payload: schema.complianceNotificationLog.payload })
    .from(schema.complianceNotificationLog)
    .where(and(
      eq(schema.complianceNotificationLog.orgId, orgId),
      eq(schema.complianceNotificationLog.channel, 'digest'),
      eq(schema.complianceNotificationLog.status, 'pending'),
    ))
    .orderBy(schema.complianceNotificationLog.createdAt));
  return rows.map((r) => ({ id: r.id, notification: r.payload as unknown as ComplianceNotification }));
}

/** Mark digest entries delivered. */
export async function markDigestsSent(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await withTenantTx(async (tx) => tx
    .update(schema.complianceNotificationLog)
    .set({ status: 'sent' })
    .where(inArray(schema.complianceNotificationLog.id, ids)));
}

/** Stamp an org's last-digest time after a successful flush. */
export async function touchLastDigestAt(orgId: string, at: Date): Promise<void> {
  await withTenantTx(async (tx) => tx
    .update(schema.complianceNotificationPreference)
    .set({ lastDigestAt: at, updatedAt: at })
    .where(eq(schema.complianceNotificationPreference.orgId, orgId)));
}
