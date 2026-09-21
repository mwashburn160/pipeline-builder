// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { entityEvents, type EntityEvent, type EntityEventSubscriber } from './entity-events.js';
import { InternalHttpClient } from './http-client.js';
import { serviceIdentity } from './service-keys.js';
import { getServiceAuthHeader } from '../middleware/auth.js';
import { type ServiceConfig } from '../types/common.js';
import { createLogger } from '../utils/logger.js';
import { emitCounter } from '../utils/metric-emitter.js';
import { errorMessage } from '../utils/response.js';

const logger = createLogger('compliance-events');

/**
 * Registers an entity event subscriber that forwards events to the compliance service.
 *
 * Call this at service startup (in index.ts) to enable automatic compliance
 * notification on entity mutations. Events are fire-and-forget — failures
 * are logged but never block the original request.
 *
 * @param config - Optional service config override (defaults to COMPLIANCE_SERVICE_HOST/PORT env vars)
 * @param serviceName - Service identifier baked into the signed JWT's `sub`
 *   (e.g. 'pipeline', 'plugin'). The compliance route is an INTERNAL route: it
 *   admits only those two services' own signed tokens, and no user token.
 *   Defaults to THIS process's identity (`SERVICE_NAME`) — since #14 a service
 *   holds only its own signing key, so a placeholder name would mint a token no
 *   peer could verify.
 */
export function registerComplianceEventSubscriber(
  config?: Partial<ServiceConfig>,
  serviceName: string = serviceIdentity(),
): void {
  const serviceConfig: ServiceConfig = {
    host: config?.host ?? process.env.COMPLIANCE_SERVICE_HOST ?? 'compliance',
    port: config?.port ?? parseInt(process.env.COMPLIANCE_SERVICE_PORT ?? '3000', 10),
  };

  const client = new InternalHttpClient(serviceConfig);

  const subscriber: EntityEventSubscriber = {
    async onEntityEvent(event: EntityEvent): Promise<void> {
      try {
        // Mint a per-event service JWT scoped to the event's org so the
        // compliance route's `runWithTenantContext` sees the right tenant
        // GUC. The compliance side enforces `requireAuth` +
        // `requireServicePrincipal` — the previous `x-internal-service`
        // header is no longer sufficient (and was spoofable).
        //
        // This HTTP notify is the SINGLE delivery channel for post-mutation
        // re-validation (primary enforcement is the fail-CLOSED live
        // validate path). A stable per-event `Idempotency-Key` makes the POST
        // retry-safe in the http-client, so a transient 5xx/timeout is retried
        // rather than dropped on the first attempt; compliance re-evaluation is
        // naturally idempotent, so a duplicate delivery is harmless.
        const response = await client.post('/compliance/events/entity', event, {
          headers: {
            'Authorization': getServiceAuthHeader({ serviceName, orgId: event.orgId, role: 'member' }),
            'Idempotency-Key': `${event.target}:${event.entityId}:${event.eventType}:${event.timestamp.toISOString()}`,
          },
        });
        // The client RETURNS a terminal 4xx/5xx (retries exhausted) rather than
        // throwing, so an unchecked call counted every rejection as delivered:
        // a 403 from a mis-provisioned service identity, or a 500 from a broken
        // compliance deploy, dropped every re-validation with no metric and no
        // log. Route it through the same drop path as a transport error.
        if (response.statusCode < 200 || response.statusCode >= 300) {
          throw new Error(`compliance rejected the entity event with HTTP ${response.statusCode}`);
        }
      } catch (err) {
        // Fire-and-forget: log + a drop metric so sustained loss is alertable
        // (operators can't act on a warn line alone), then swallow — compliance
        // notification is non-fatal to the originating mutation.
        emitCounter('compliance_event_drop_total', { service: serviceName, target: event.target });
        logger.warn('Failed to notify compliance service of entity event', {
          target: event.target,
          eventType: event.eventType,
          entityId: event.entityId,
          error: errorMessage(err),
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
