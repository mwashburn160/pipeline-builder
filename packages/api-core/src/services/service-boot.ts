// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { RemoteAuditClient } from './remote-audit-client.js';
import { wireAuthzDenialAuditor } from './remote-audit-client.js';
import { createEnvRedisTokenRevocationStore } from './token-revocation.js';
import { setTokenRevocationStore } from '../middleware/auth.js';

/**
 * Wire the two boot-security concerns every stateless service sets up
 * identically at startup:
 *   1. forward denied (non-GET) authorizations to the shared `authz.denied`
 *      audit sink (`wireAuthzDenialAuditor`);
 *   2. register the env-Redis token-revocation reader (fail-open) so
 *      `requireAuth` can reject a token behind the platform-published
 *      `tokenVersion` (`setTokenRevocationStore(createEnvRedisTokenRevocationStore())`).
 *
 * Collapses the two copy-pasted lines in each service's `index.ts` into one call.
 *
 * NOTE: the PLUGIN service opts out — it shares its health-check Redis
 * connection via `createRedisTokenRevocationStore(getHealthRedisConnection())`
 * instead of the env-Redis store — so it wires these two concerns by hand.
 *
 * @param serviceName short service name minted into the `authz.denied` records
 * @param getAuditClient lazy accessor for the service's RemoteAuditClient
 */
export function wireServiceSecurity(serviceName: string, getAuditClient: () => RemoteAuditClient): void {
  wireAuthzDenialAuditor(serviceName, getAuditClient);
  setTokenRevocationStore(createEnvRedisTokenRevocationStore());
}
