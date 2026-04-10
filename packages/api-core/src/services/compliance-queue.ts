// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger } from '../utils/logger';

const logger = createLogger('compliance-queue');

export interface ComplianceEvent {
  eventType: 'validate' | 'scan' | 'notify';
  target: 'plugin' | 'pipeline';
  entityId: string;
  orgId: string;
  userId: string;
  attributes: Record<string, unknown>;
  timestamp: string;
}

/**
 * Pluggable compliance event queue.
 * Services register a backend (BullMQ, SQS, or in-memory) at startup.
 * If no backend is registered, events are logged and discarded.
 */
let enqueueFn: ((event: ComplianceEvent) => Promise<void>) | null = null;

export function registerComplianceQueueBackend(fn: (event: ComplianceEvent) => Promise<void>): void {
  enqueueFn = fn;
  logger.info('Compliance queue backend registered');
}

export async function enqueueComplianceEvent(event: ComplianceEvent): Promise<void> {
  if (!enqueueFn) {
    logger.debug('Compliance event discarded (no queue backend registered)', {
      eventType: event.eventType, target: event.target, entityId: event.entityId,
    });
    return;
  }
  try {
    await enqueueFn(event);
    logger.debug('Compliance event enqueued', { eventType: event.eventType, target: event.target, entityId: event.entityId });
  } catch (err) {
    logger.warn('Failed to enqueue compliance event', {
      eventType: event.eventType,
      entityId: event.entityId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
