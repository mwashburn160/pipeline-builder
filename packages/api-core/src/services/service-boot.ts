// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { setApiKeyExchangeServiceName } from './api-key-exchange.js';
import type { RemoteAuditClient } from './remote-audit-client.js';
import { wireAuthzDenialAuditor } from './remote-audit-client.js';
import { createEnvRedisTokenRevocationStore } from './token-revocation.js';
import { setTokenRevocationStore, type TokenRevocationStore } from '../middleware/auth.js';

/** Per-service overrides for {@link wireServiceSecurity}. */
export interface ServiceSecurityOptions {
  /**
   * Token-revocation reader to register instead of the env-Redis one. The
   * plugin service passes a store built on the pooled ioredis connection its
   * BullMQ build queue and readiness probe already share, so the process holds
   * ONE Redis connection rather than two. Fail-open either way: a miss/outage
   * yields null and auth degrades to natural token expiry.
   */
  tokenRevocationStore?: TokenRevocationStore;
}

/**
 * Wire the two boot-security concerns every stateless service sets up
 * identically at startup:
 *   1. forward denied (non-GET) authorizations to the shared `authz.denied`
 *      audit sink (`wireAuthzDenialAuditor`);
 *   2. register the env-Redis token-revocation reader (fail-open) so
 *      `requireAuth` can reject a token behind the platform-published
 *      `tokenVersion` (`setTokenRevocationStore(createEnvRedisTokenRevocationStore())`);
 *   3. name this process in the access-key exchange call's own service token, so
 *      platform can attribute (and rate-limit) the exchanges it performs.
 *
 * Collapses the copy-pasted lines in each service's `index.ts` into one call.
 *
 * EVERY stateless service goes through here, plugin included. Plugin used to
 * hand-roll these three calls because it needs a different revocation store
 * (its pooled BullMQ Redis connection, not the env-Redis one) — which meant the
 * next concern added here would have silently skipped it. That override is now
 * a parameter, so opting out of the env-Redis store no longer means opting out
 * of the wiring.
 *
 * @param serviceName short service name minted into the `authz.denied` records
 * @param getAuditClient lazy accessor for the service's RemoteAuditClient
 * @param opts per-service overrides — see {@link ServiceSecurityOptions}
 */
export function wireServiceSecurity(
  serviceName: string,
  getAuditClient: () => RemoteAuditClient,
  opts: ServiceSecurityOptions = {},
): void {
  wireAuthzDenialAuditor(serviceName, getAuditClient);
  setTokenRevocationStore(opts.tokenRevocationStore ?? createEnvRedisTokenRevocationStore());
  setApiKeyExchangeServiceName(serviceName);
}
