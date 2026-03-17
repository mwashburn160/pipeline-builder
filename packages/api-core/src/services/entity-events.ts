/**
 * Lightweight in-process event emitter for entity lifecycle events.
 *
 * Services emit events after mutations (create/update/delete) via CrudService hooks.
 * Subscribers (e.g., compliance service client) react asynchronously.
 *
 * Design:
 * - Fire-and-forget: emit() never throws, subscriber errors are logged
 * - In-process only: no network, no Redis, no infrastructure
 * - Subscribers run async: never block the original request
 */

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
      subscriber.onEntityEvent(event).catch(() => {
        // Silently swallow — subscriber is responsible for its own error handling.
        // This ensures entity mutations are never blocked by subscriber failures.
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
