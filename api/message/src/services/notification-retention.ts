// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Age-out for SYSTEM notifications — the machine-written inbox items that
 * `POST /internal/notify` creates (report delivery, downgrade and dunning
 * notices, quota thresholds, offers, compliance alerts).
 *
 * Only those. A conversation or a support case is correspondence somebody wrote
 * and may need years later; a "your report is ready" notice from last spring is
 * not. Without this, every org's inbox grew by one row per notice forever, and
 * the soft-delete sweep never saw them because nobody deletes a notification.
 *
 * A notification is recognised by how `/internal/notify` writes it: authored by
 * the system org as the system actor on the `notifications` channel. One that
 * somebody REPLIED to has become a conversation and is kept — deleting its root
 * would orphan the replies.
 */

import { envInt, SYSTEM_ACTOR_ID, SYSTEM_ORG_ID } from '@pipeline-builder/api-core';
import { schema, withTenantTx } from '@pipeline-builder/pipeline-data';
import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm';

/** Days a system notification is kept. */
export const NOTIFICATION_RETENTION_DAYS = envInt('MESSAGE_NOTIFICATION_RETENTION_DAYS', 365, { min: 7 });

/**
 * Hard-delete one batch of system notifications older than the retention
 * window. Runs inside the soft-delete purge sweep (sysadmin scope, leader lock,
 * one `message.purge` audit row per tick). Returns how many were removed.
 */
export async function purgeAgedNotifications(now: Date, limit = 500): Promise<number> {
  const cutoff = new Date(now.getTime() - NOTIFICATION_RETENTION_DAYS * 86_400_000);
  const m = schema.message;
  return withTenantTx(async (tx) => {
    // pg DELETE has no LIMIT — select a bounded batch, then delete by id.
    const doomed = await tx
      .select({ id: m.id })
      .from(m)
      .where(and(
        eq(m.orgId, SYSTEM_ORG_ID),
        eq(m.createdBy, SYSTEM_ACTOR_ID),
        eq(m.channel, 'notifications'),
        isNull(m.threadId),
        lt(m.createdAt, cutoff),
        sql`NOT EXISTS (SELECT 1 FROM messages r WHERE r.thread_id = ${m.id})`,
      ))
      .limit(limit);
    if (doomed.length === 0) return 0;
    const removed = await tx.delete(m)
      .where(inArray(m.id, doomed.map((d) => d.id)))
      .returning({ id: m.id });
    return removed.length;
  });
}
