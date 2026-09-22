// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Sender side of the plugin-ecosystem notification relay
 * (docs/plugin-publishing.md).
 *
 * Platform owns SMTP, the user directory and the Roles, so an ecosystem notice
 * is ONE internal call — `POST /internal/notify-email` with an
 * {@link EcosystemNotifyRequest} — and platform resolves the recipient RULES,
 * applies each user's `ecosystem.*` email preferences, mails every recipient
 * individually and drops the in-app copy into their inbox through the message
 * service. The calling service never sees an address or a member list.
 *
 * The request is validated HERE with the same parser the relay uses, so a
 * malformed notice fails at the call site rather than as a 400 at flush time.
 */

import { createSafeClient } from './http-client.js';
import { getServiceAuthHeader } from '../middleware/service-tokens.js';
import { SYSTEM_ORG_ID } from '../middleware/system-org.js';
import type { ServiceConfig } from '../types/common.js';
import { parseEcosystemNotifyRequest, type EcosystemNotifyRequest } from '../types/ecosystem-notifications.js';
import { createLogger } from '../utils/logger.js';
import { emitCounter } from '../utils/metric-emitter.js';
import { errorMessage } from '../utils/response.js';
import { serviceEndpoint } from '../utils/service-registry.js';

const logger = createLogger('ecosystem-notify-client');

/** The relay path on platform. */
export const ECOSYSTEM_NOTIFY_PATH = '/internal/notify-email';

/** What one send achieved. `ok: false` means nothing was confirmed delivered. */
export interface EcosystemNotifyResult {
  ok: boolean;
  /** HTTP status from platform (absent when it was unreachable). */
  status?: number;
  /** Users (and addresses) the rules resolved to. */
  recipientCount?: number;
}

export interface EcosystemNotifyClient {
  send(request: EcosystemNotifyRequest): Promise<EcosystemNotifyResult>;
}

export interface EcosystemNotifyClientConfig {
  /** The calling service — must be one of the relay's allowed callers. */
  serviceName: string;
  /** Platform host (default env PLATFORM_SERVICE_HOST or 'platform'). */
  host?: string;
  /** Platform port (default env PLATFORM_SERVICE_PORT or 3000). */
  port?: number;
  /** Request timeout ms (default 10 000 — a fan-out to many recipients). */
  timeout?: number;
}

/**
 * Create the relay client. Never throws from `send` for a transport problem —
 * it resolves `{ ok: false }` and counts `ecosystem_notification_failed_total
 * {event}` so the caller (the digest dispatcher) can keep the row for retry.
 * It DOES throw for an invalid request: that is a programming error, and
 * retrying it would never succeed.
 */
export function createEcosystemNotifyClient(config: EcosystemNotifyClientConfig): EcosystemNotifyClient {
  const serviceConfig: ServiceConfig = {
    host: config.host ?? serviceEndpoint('platform').host,
    port: config.port ?? serviceEndpoint('platform').port,
    timeout: config.timeout ?? 10_000,
  };
  const client = createSafeClient(serviceConfig);

  return {
    async send(request: EcosystemNotifyRequest): Promise<EcosystemNotifyResult> {
      const parsed = parseEcosystemNotifyRequest(request);
      if (typeof parsed === 'string') throw new Error(`Invalid ecosystem notification: ${parsed}`);
      try {
        // System-org scoped, least privilege: the relay authorizes the CALLER by
        // its key-bound service name, not by a role or permission on the token.
        const authorization = getServiceAuthHeader({ serviceName: config.serviceName, orgId: SYSTEM_ORG_ID, role: 'member' });
        const response = await client.post<{ data?: { recipientCount?: number }; recipientCount?: number }>(
          ECOSYSTEM_NOTIFY_PATH, parsed, { headers: { Authorization: authorization } },
        );
        const status = response?.statusCode;
        const ok = status !== undefined && status >= 200 && status < 300;
        if (!ok) {
          emitCounter('ecosystem_notification_failed_total', { event: parsed.event });
          logger.warn('Ecosystem notification not delivered', { event: parsed.event, status: status ?? 'unreachable' });
          return { ok: false, ...(status !== undefined ? { status } : {}) };
        }
        const body = response!.body ?? {};
        const recipientCount = body.data?.recipientCount ?? body.recipientCount;
        return { ok: true, status, ...(typeof recipientCount === 'number' ? { recipientCount } : {}) };
      } catch (err) {
        emitCounter('ecosystem_notification_failed_total', { event: parsed.event });
        logger.warn('Ecosystem notification failed', { event: parsed.event, error: errorMessage(err) });
        return { ok: false };
      }
    },
  };
}
