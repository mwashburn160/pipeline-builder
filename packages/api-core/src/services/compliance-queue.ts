// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger } from '../utils/logger.js';

const logger = createLogger('compliance-queue');

export interface ComplianceEvent {
  eventType: 'validate' | 'scan' | 'notify';
  target: 'plugin' | 'pipeline';
  entityId: string;
  orgId: string;
  /** Owning org's parent (present only when `orgId` is a team) so the async
   *  worker evaluates parent `propagateToChildren` rules like the live path. */
  parentOrgId?: string;
  userId: string;
  attributes: Record<string, unknown>;
  timestamp: string;
}

/**
 * Pluggable compliance event queue.
 * Services register a backend (BullMQ, SQS, or in-memory) at startup.
 * If no backend is registered, events are logged and discarded.
 *
 * NOTE (2026-07): currently has NO producer. The entity-event path was the only
 * caller of {@link enqueueComplianceEvent}, but it only ever ran in the
 * plugin/pipeline processes — which register NO backend — so every enqueue was a
 * silent no-op there (the "durable async re-validation" it advertised never
 * existed). That dead call was removed; post-mutation re-validation now rides the
 * retriable HTTP notify in `compliance-event-subscriber.ts` (primary enforcement
 * is the fail-closed live validate path regardless). This queue machinery is
 * retained for a future real durable producer; until one is wired it is inert.
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
