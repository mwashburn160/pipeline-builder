import { type ServiceConfig } from '../types/common';
import { createLogger } from '../utils/logger';
import { entityEvents, type EntityEvent, type EntityEventSubscriber } from './entity-events';
import { InternalHttpClient } from './http-client';

const logger = createLogger('compliance-events');

/**
 * Registers an entity event subscriber that forwards events to the compliance service.
 *
 * Call this at service startup (in index.ts) to enable automatic compliance
 * notification on entity mutations. Events are fire-and-forget — failures
 * are logged but never block the original request.
 *
 * @param config - Optional service config override (defaults to COMPLIANCE_SERVICE_HOST/PORT env vars)
 */
export function registerComplianceEventSubscriber(config?: Partial<ServiceConfig>): void {
  const serviceConfig: ServiceConfig = {
    host: config?.host ?? process.env.COMPLIANCE_SERVICE_HOST ?? 'compliance',
    port: config?.port ?? parseInt(process.env.COMPLIANCE_SERVICE_PORT ?? '3000', 10),
  };

  const client = new InternalHttpClient(serviceConfig);

  const subscriber: EntityEventSubscriber = {
    async onEntityEvent(event: EntityEvent): Promise<void> {
      try {
        await client.post('/compliance/events/entity', event, {
          headers: { 'x-internal-service': 'true' },
        });
      } catch (err) {
        // Fire-and-forget: log and swallow. Compliance notification is non-fatal.
        logger.debug('Failed to notify compliance service of entity event', {
          target: event.target,
          eventType: event.eventType,
          entityId: event.entityId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };

  entityEvents.subscribe(subscriber);
  logger.info('Compliance event subscriber registered', {
    host: serviceConfig.host,
    port: serviceConfig.port,
  });
}
