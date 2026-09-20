// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

export * from './api-key-exchange.js';
export * from './cache-service.js';
export * from './leader-lock.js';
export * from './scheduler.js';
export * from './compliance-client.js';
export * from './compliance-event-subscriber.js';
export * from './entity-events.js';
export * from './http-client.js';
export * from './jwks-cache.js';
// Service-key internals stay internal. The package surface is the verify/inspect
// side that platform's JWT options and the auth middleware need; key MATERIAL
// handling (`signServiceJwt`, the bundle, the test reset hook) is reachable only
// by deep import from inside api-core and its testing helpers.
export {
  SERVICE_TOKEN_ALGORITHM,
  SERVICE_SUBJECT_PREFIX,
  ServiceKeyError,
  serviceIdentity,
  serviceKeyMode,
  isServiceKid,
  knownServiceNames,
  verifyServiceJwt,
  isRetiringServiceKeyPublished,
} from './service-keys.js';
export type { ServiceKeyEntry } from './service-keys.js';
// The breaker is wired by the shared HTTP client; services consume its EFFECT,
// not the class. Only the operational surface is public.
export { CircuitOpenError, resetCircuitBreakers } from './circuit-breaker.js';
export type { CircuitState } from './circuit-breaker.js';
export * from './durable-event-bus.js';
export {
  DEFAULT_MAX_RETRIES,
  DEFAULT_RETRY_DELAY_MS,
  DEFAULT_MAX_RATE_LIMIT_RETRIES,
  calculateBackoff,
  getRetryDecision,
  getErrorRetryDecision,
} from './retry-strategy.js';
export type { RetryConfig, RetryDecision } from './retry-strategy.js';
export * from './retry-forever.js';
export * from './quota.js';
export * from './remote-audit-client.js';
export * from './audit-spool.js';
export * from './env-redis.js';
export * from './token-revocation.js';
export * from './sse-ticket-store.js';
export * from './service-boot.js';
export * from './notification-channels.js';
