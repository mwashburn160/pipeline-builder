// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { setApiKeyExchangeServiceName } from './api-key-exchange.js';
import { bindAuditService, getBoundAuditClient, wireAuthzDenialAuditor } from './remote-audit-client.js';
import { createEnvRedisTokenRevocationStore } from './token-revocation.js';
import { setTokenRevocationStore, type TokenRevocationStore } from '../middleware/revocation.js';

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
 * Wire the boot-security concerns every stateless service sets up identically
 * at startup:
 *   0. bind this process's service identity for `recordAudit` — the ONE place a
 *      service names itself for the central audit trail (before this runs,
 *      `recordAudit` throws "audit not initialised");
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
 * EVERY stateless service goes through here, plugin included. Plugin needs a
 * different revocation store (its pooled BullMQ Redis connection, not the
 * env-Redis one); that override is a parameter, so opting out of the env-Redis
 * store never means opting out of the wiring — a hand-rolled copy would
 * silently skip the next concern added here.
 *
 * @param serviceName short service name every `recordAudit` event (and the
 *   `authz.denied` records) is attributed to
 * @param opts per-service overrides — see {@link ServiceSecurityOptions}
 */
export function wireServiceSecurity(
  serviceName: string,
  opts: ServiceSecurityOptions = {},
): void {
  bindAuditService(serviceName);
  wireAuthzDenialAuditor(serviceName, getBoundAuditClient);
  setTokenRevocationStore(opts.tokenRevocationStore ?? createEnvRedisTokenRevocationStore());
  setApiKeyExchangeServiceName(serviceName);
}
