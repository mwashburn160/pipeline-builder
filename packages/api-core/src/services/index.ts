// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

export {
  exchangeApiKey,
  resetApiKeyExchangeCache,
  ApiKeyRejectedError,
  ApiKeyExchangeUnavailableError,
} from './api-key-exchange.js';
export {
  createRedisCacheInvalidationBus,
  createCacheService,
  type RedisCacheClient,
  type CacheInvalidationMessage,
  type CacheInvalidationBus,
  type RedisInvalidationClient,
  CacheService,
} from './cache-service.js';
export {
  closeLeaderLock,
  withLeaderLock,
  createEnvRedisLock,
  type LockRedis,
} from './leader-lock.js';
export {
  createScheduler,
  type SchedulerOptions,
  type Scheduler,
} from './scheduler.js';
export {
  pluginRunsOwnImage,
  pluginComplianceTags,
  derivePluginImageCompliance,
  createComplianceClient,
  type ComplianceCheckResult,
  type ComplianceViolation,
  type PluginComplianceAttributes,
  PLUGIN_IMAGE_COMPLIANCE_FIELDS,
  type PluginImageRow,
} from './compliance-client.js';
export * from './compliance-event-subscriber.js';
export {
  type EntityEvent,
  type EntityEventSubscriber,
  entityEvents,
} from './entity-events.js';
export {
  destroySharedHttpAgents,
  createSafeClient,
  ResponseTooLargeError,
  InternalHttpClient,
} from './http-client.js';
export {
  setPlatformJwksCache,
  JwksUnavailableError,
  UnknownKidError,
  JwksCache,
} from './jwks-cache.js';
// Service-key internals stay internal. The package surface is the verify/inspect
// side that platform's JWT options and the auth middleware need; key MATERIAL
// handling (`signServiceJwt`, the bundle, the test reset hook) is reachable only
// by deep import from inside api-core and its testing helpers.
export {
  isServiceKid,
  verifyServiceJwt,
} from './service-keys.js';
// The breaker is wired by the shared HTTP client; services consume its EFFECT,
// not the class. Only the operational surface is public.
export {
  resetCircuitBreakers,
} from './circuit-breaker.js';
export {
  createRedisDurableEventBus,
  createEnvRedisDurableEventBus,
  type EventSubscription,
  type DurableEventBus,
} from './durable-event-bus.js';
export {
  calculateBackoff,
  getRetryDecision,
  getErrorRetryDecision,
} from './retry-strategy.js';
export type {
  RetryConfig,
} from './retry-strategy.js';
export {
  nextBackoffMs,
  retryForever,
} from './retry-forever.js';
export {
  getQuotaServiceAuthHeader,
  createQuotaService,
  incrementQuota,
  reserveQuota,
  sendQuotaReserveDenied,
  decrementQuota,
  type QuotaReserveResult,
  type QuotaService,
} from './quota.js';
export {
  isRemoteAuditAction,
  createRemoteAuditClient,
  wireAuthzDenialAuditor,
  createServiceAuditClient,
  createRemoteAuditAccessor,
  REMOTE_AUDIT_ACTIONS,
  type RemoteAuditEvent,
  type RemoteAuditClient,
  type ServiceAuditClient,
} from './remote-audit-client.js';
export {
  auditSpoolKey,
  createRedisAuditSpool,
  createEnvRedisAuditSpool,
  type AuditSpool,
} from './audit-spool.js';
export {
  parseSentinels,
  resolveRedisConnection,
  describeRedisConnection,
  createRedisClient,
  createEnvRedisClient,
  whenRedisReady,
  createRedisReadyGate,
  incrWindow,
  RedisConfigError,
  type RedisEvalClient,
} from './env-redis.js';
export {
  tokenRevocationKey,
  sessionRevocationKey,
  credentialRevocationKey,
  createRedisTokenRevocationStore,
  createEnvRedisTokenRevocationStore,
  publishTokenRevocation,
  publishSessionRevocation,
  publishCredentialRevocation,
  TOKEN_REVOCATION_KEY_PREFIX,
  SESSION_REVOCATION_KEY_PREFIX,
  SET_IF_GREATER_LUA,
} from './token-revocation.js';
export {
  createMemorySseTicketStore,
  createRedisSseTicketStore,
  createEnvSseTicketStore,
  type SseTicketStore,
  type SseTicketStoreConfig,
} from './sse-ticket-store.js';
export {
  wireServiceSecurity,
} from './service-boot.js';
export {
  createWebhookChannel,
  createEmailChannel,
  createChannelRegistry,
  type NotificationPriority,
  type NotificationMessage,
  type ChannelTarget,
  type DeliveryResult,
  type NotificationChannel,
} from './notification-channels.js';
export {
  createEcosystemNotifyClient,
  ECOSYSTEM_NOTIFY_PATH,
  type EcosystemNotifyClient,
} from './ecosystem-notify-client.js';
