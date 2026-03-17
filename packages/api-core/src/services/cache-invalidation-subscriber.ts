/**
 * Entity event subscriber that invalidates cache entries when entities are mutated.
 *
 * Registers with the EntityEventEmitter to listen for create/update/delete events
 * and clears relevant cache keys. This ensures cached data stays consistent with
 * the database without requiring manual invalidation in every route handler.
 */

import { createLogger } from '../utils/logger';
import { entityEvents, type EntityEvent, type EntityEventSubscriber } from './entity-events';
import { type CacheService } from './cache-service';

const logger = createLogger('cache-invalidation');

/**
 * Register a cache invalidation subscriber.
 *
 * When entities are created/updated/deleted, all cache keys matching
 * the entity's orgId and type are invalidated.
 *
 * @param caches - Map of entity target names to their CacheService instances
 *
 * @example
 * ```typescript
 * const pluginCache = createCacheService('plugin:', 300);
 * const pipelineCache = createCacheService('pipeline:', 300);
 *
 * registerCacheInvalidationSubscriber({
 *   plugin: pluginCache,
 *   pipeline: pipelineCache,
 * });
 * ```
 */
export function registerCacheInvalidationSubscriber(
  caches: Record<string, CacheService>,
): void {
  const subscriber: EntityEventSubscriber = {
    async onEntityEvent(event: EntityEvent): Promise<void> {
      const cache = caches[event.target];
      if (!cache) return;

      try {
        // Invalidate all cache entries for this org + entity type
        const deleted = await cache.invalidatePattern(`${event.orgId}:*`);

        // Also invalidate the specific entity key
        await cache.del(`${event.orgId}:id:${event.entityId}`);

        if (deleted > 0) {
          logger.debug('Cache invalidated', {
            target: event.target,
            orgId: event.orgId,
            entityId: event.entityId,
            eventType: event.eventType,
            keysInvalidated: deleted,
          });
        }
      } catch (err) {
        // Cache invalidation failure is non-fatal
        logger.debug('Cache invalidation failed', {
          target: event.target,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };

  entityEvents.subscribe(subscriber);
  logger.info('Cache invalidation subscriber registered', {
    targets: Object.keys(caches),
  });
}
