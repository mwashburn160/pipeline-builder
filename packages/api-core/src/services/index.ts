// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

export {
  exchangeApiKey,
  resetApiKeyExchangeCache,
  ApiKeyRejectedError,
  ApiKeyExchangeUnavailableError,
} from './api-key-exchange.js';
export {
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
  sendSystemNotification,
  SYSTEM_NOTIFY_PATH,
  type SystemNotification,
} from './system-notification.js';
export {
  createScheduler,
  type SchedulerOptions,
  type Scheduler,
} from './scheduler.js';
export {
  createComplianceClient,
  type ComplianceCheckResult,
  type ComplianceViolation,
} from './compliance-client.js';
export {
  pluginRunsOwnImage,
  pluginComplianceTags,
  derivePluginImageCompliance,
  type PluginComplianceAttributes,
  PLUGIN_IMAGE_COMPLIANCE_FIELDS,
  type PluginImageRow,
} from '../utils/plugin-compliance.js';
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
  serviceIdentity,
  verifyServiceJwt,
} from './service-keys.js';
// The breaker is wired by the shared HTTP client; services consume its EFFECT,
// not the class. Only the operational surface is public.
export {
  resetCircuitBreakers,
} from './circuit-breaker.js';
export {
  createEnvRedisDurableEventBus,
  type EventSubscription,
  type DurableEventBus,
} from './durable-event-bus.js';
export {
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
  recordAudit,
  REMOTE_AUDIT_ACTIONS,
  type RemoteAuditEvent,
  type RemoteAuditClient,
} from './remote-audit-client.js';
export {
  auditSpoolKey,
  createEnvRedisAuditSpool,
  type AuditSpool,
} from './audit-spool.js';
export {
  resolveRedisConnection,
  describeRedisConnection,
  createRedisClient,
  createEnvRedisClient,
  createRedisReadyGate,
  incrWindow,
  RedisConfigError,
  type RedisEvalClient,
} from './env-redis.js';
export {
  createRedisTokenRevocationStore,
  createEnvRedisTokenRevocationStore,
  publishTokenRevocation,
  publishSessionRevocation,
  publishCredentialRevocation,
} from './token-revocation.js';
export {
  createMemorySseTicketStore,
  createEnvSseTicketStore,
  envSseTicketCaps,
  type EnvSseTicketStoreConfig,
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
