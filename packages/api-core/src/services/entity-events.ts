// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Lightweight in-process event emitter for entity lifecycle events.
 *
 * Services emit events after mutations (create/update/delete) via CrudService hooks.
 * Subscribers react asynchronously to entity changes.
 *
 * Active subscribers:
 * - **Compliance event subscriber** (`registerComplianceEventSubscriber()`) — forwards
 *   entity events to the compliance service for post-mutation rule evaluation.
 *   Registered at startup in plugin and pipeline service index.ts.
 *
 * Design:
 * - Fire-and-forget: emit() never throws, subscriber errors are logged
 * - In-process only: no network, no Redis, no infrastructure
 * - Subscribers run async: never block the original request
 *
 * Durability contract (deliberately BEST-EFFORT):
 * - The post-mutation compliance evaluation this feeds is NOT the enforcement
 *   gate — LIVE validation on the mutation path already enforces compliance
 *   before the write commits. This async fan-out is a convenience/reporting
 *   signal, so a lost delivery (subscriber throw, process crash mid-callback)
 *   downgrades timeliness, not correctness. Backing it with the durable Redis
 *   spool would pull network/infra into a module whose whole point is to have
 *   none, for no enforcement benefit — so instead a dropped delivery is made
 *   OBSERVABLE via the `entity_event_subscriber_failed_total` counter (alert on
 *   a sustained rate) rather than silently swallowed at debug level.
 */

import { createLogger } from '../utils/logger.js';
import { emitCounter } from '../utils/metric-emitter.js';

const logger = createLogger('entity-events');

export type EntityEventType = 'created' | 'updated' | 'deleted';
export type EntityTarget = 'plugin' | 'pipeline' | 'message' | 'organization' | 'user';

export interface EntityEvent {
  /** The type of mutation that occurred */
  eventType: EntityEventType;
  /** The entity type that was mutated */
  target: EntityTarget;
  /** The entity's unique ID */
  entityId: string;
  /** The organization that owns this entity */
  orgId: string;
  /** Org → team hierarchy: the owning org's parent (present only when `orgId` is
   *  a team). Lets compliance evaluate parent `propagateToChildren` rules on the
   *  async event path, matching live validation. */
  parentOrgId?: string;
  /** The user who performed the mutation */
  userId: string;
  /** When the event occurred */
  timestamp: Date;
  /** Snapshot of entity attributes (for compliance evaluation) */
  attributes: Record<string, unknown>;
}

export interface EntityEventSubscriber {
  onEntityEvent(event: EntityEvent): Promise<void>;
}

class EntityEventEmitter {
  private subscribers: EntityEventSubscriber[] = [];

  /**
   * Register a subscriber to receive entity events.
   */
  subscribe(subscriber: EntityEventSubscriber): void {
    this.subscribers.push(subscriber);
  }

  /**
   * Remove a subscriber.
   */
  unsubscribe(subscriber: EntityEventSubscriber): void {
    this.subscribers = this.subscribers.filter((s) => s !== subscriber);
  }

  /**
   * Emit an entity event to all subscribers.
   * Fire-and-forget: errors are caught and logged, never thrown.
   */
  emit(event: EntityEvent): void {
    for (const subscriber of this.subscribers) {
      subscriber.onEntityEvent(event).catch((err) => {
        // Make the drop observable — a lost async compliance eval is best-effort
        // (live validation already enforced), but a sustained failure rate is an
        // operational signal, not something to bury at debug level.
        emitCounter('entity_event_subscriber_failed_total', {
          target: event.target,
          eventType: event.eventType,
        });
        logger.debug('Entity event subscriber failed', {
          target: event.target,
          eventType: event.eventType,
          entityId: event.entityId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  /**
   * Get the current subscriber count (for testing/diagnostics).
   */
  get subscriberCount(): number {
    return this.subscribers.length;
  }
}

/** Singleton entity event emitter — shared across the process */
export const entityEvents = new EntityEventEmitter();
