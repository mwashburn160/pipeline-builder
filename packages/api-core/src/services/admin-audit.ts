// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger } from '../utils/logger';

const logger = createLogger('admin-audit');

export interface AuditEntry {
  userId: string;
  userEmail?: string;
  orgId?: string;
  action: string;
  targetType: string;
  targetId?: string;
  targetName?: string;
  detail?: Record<string, unknown>;
  ipAddress?: string;
}

const auditQueue: AuditEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

export function logAdminAction(entry: AuditEntry): void {
  logger.info('Admin action', entry);
  auditQueue.push(entry);
  if (!flushTimer) {
    flushTimer = setTimeout(flushAuditQueue, 5000);
  }
}

async function flushAuditQueue(): Promise<void> {
  flushTimer = null;
  const batch = auditQueue.splice(0, auditQueue.length);
  if (batch.length === 0) return;
  // Batch will be persisted when a DB writer is registered
  for (const entry of batch) {
    logger.debug('Audit entry queued', { action: entry.action, target: entry.targetType });
  }
}

export function getAuditQueue(): AuditEntry[] {
  return [...auditQueue];
}
