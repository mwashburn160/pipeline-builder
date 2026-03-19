import type { Algorithm } from 'jsonwebtoken';
import { loadBillingConfig } from './billing-config';
import type { AppConfig } from './config-types';
import {
  loadRegistryConfig,
  loadRedisConfig,
  loadPluginBuildConfig,
  loadAWSConfig,
} from './infrastructure-config';
import {
  loadServerConfig,
  loadAuthConfig,
  loadRateLimitConfig,
  validateServerConfig,
  validateAuthConfig,
} from './server-config';

/**
 * Core constants — configurable via environment variables with sensible defaults.
 */
export class CoreConstants {
  static readonly NAME_PATTERN = /^[a-z0-9-]+$/;

  // Supported JWT algorithms
  static readonly ALLOWED_JWT_ALGORITHMS: Algorithm[] = ['HS256', 'RS256', 'ES256'];

  // Custom Resource Handler configuration (must be less than Lambda timeout of 30s to allow response handling)
  static readonly HANDLER_TIMEOUT_MS = parseInt(process.env.HANDLER_TIMEOUT_MS || '25000', 10); // 25s
  /** Default platform URL fallback when PLATFORM_BASE_URL is not set. */
  static readonly DEFAULT_PLATFORM_URL = 'https://localhost:8443';

  static readonly HANDLER_DEFAULT_BASE_URL = process.env.PLATFORM_BASE_URL || CoreConstants.DEFAULT_PLATFORM_URL;
  static readonly HANDLER_MAX_RETRIES = parseInt(process.env.HANDLER_MAX_RETRIES || '2', 10);
  static readonly HANDLER_RETRY_DELAY_MS = parseInt(process.env.HANDLER_RETRY_DELAY_MS || '1000', 10); // 1s

  // Docker build configuration
  static readonly DOCKER_BUILD_TIMEOUT_MS = parseInt(process.env.DOCKER_BUILD_TIMEOUT_MS || '900000', 10); // 15 min
  static readonly DOCKER_BUILDER_NAME = process.env.DOCKER_BUILDER_NAME || 'plugin-builder';
  static readonly PLUGIN_IMAGE_PREFIX = process.env.PLUGIN_IMAGE_PREFIX || 'p-';

  // Plugin build queue configuration
  static readonly PLUGIN_BUILD_QUEUE_NAME = process.env.PLUGIN_BUILD_QUEUE_NAME || 'plugin-build';
  static readonly PLUGIN_BUILD_MAX_ATTEMPTS = parseInt(process.env.PLUGIN_BUILD_MAX_ATTEMPTS || '2', 10);
  static readonly PLUGIN_BUILD_BACKOFF_DELAY_MS = parseInt(process.env.PLUGIN_BUILD_BACKOFF_DELAY_MS || '5000', 10); // 5s
  static readonly PLUGIN_BUILD_COMPLETED_RETENTION_SECS = parseInt(process.env.PLUGIN_BUILD_COMPLETED_RETENTION_SECS || '3600', 10); // 1 hr
  static readonly PLUGIN_BUILD_FAILED_RETENTION_SECS = parseInt(process.env.PLUGIN_BUILD_FAILED_RETENTION_SECS || '86400', 10); // 24 hr
  static readonly PLUGIN_BUILD_WORKER_TIMEOUT_MS = parseInt(process.env.PLUGIN_BUILD_WORKER_TIMEOUT_MS || '10000', 10); // 10s

  // Pagination and limits
  static readonly MAX_PAGE_LIMIT = parseInt(process.env.MAX_PAGE_LIMIT || '1000', 10);
  static readonly DEFAULT_PAGE_LIMIT = parseInt(process.env.DEFAULT_PAGE_LIMIT || '100', 10);
  static readonly MAX_PROMPT_LENGTH = parseInt(process.env.MAX_PROMPT_LENGTH || '5000', 10);
  static readonly PLUGIN_MAX_UPLOAD_MB = parseInt(process.env.PLUGIN_MAX_UPLOAD_MB || '50', 10);
  static readonly PIPELINE_NAME_MAX_LENGTH = parseInt(process.env.PIPELINE_NAME_MAX_LENGTH || '100', 10);
  static readonly DEFAULT_PLUGIN_VERSION = process.env.DEFAULT_PLUGIN_VERSION || '1.0.0';

  // SSE stream timeout for AI generation endpoints
  static readonly SSE_STREAM_TIMEOUT_MS = parseInt(process.env.SSE_STREAM_TIMEOUT_MS || '300000', 10); // 5 min

  // Git provider API base URLs (configurable for enterprise instances)
  static readonly GITHUB_API_BASE_URL = process.env.GITHUB_API_BASE_URL || 'https://api.github.com';
  static readonly BITBUCKET_API_BASE_URL = process.env.BITBUCKET_API_BASE_URL || 'https://api.bitbucket.org/2.0';

  // Bulk operations and event ingestion
  static readonly MAX_BULK_ITEMS = parseInt(process.env.MAX_BULK_ITEMS || '100', 10);
  static readonly MAX_EVENTS_PER_BATCH = parseInt(process.env.MAX_EVENTS_PER_BATCH || '100', 10);
  static readonly DEFAULT_REPORT_RANGE_DAYS = parseInt(process.env.DEFAULT_REPORT_RANGE_DAYS || '30', 10);

  // Secrets Manager path prefix for org-scoped secrets
  static readonly SECRETS_PATH_PREFIX = process.env.SECRETS_PATH_PREFIX || 'pipeline-builder';

  // Database connection
  static readonly DB_MAX_RETRIES = parseInt(process.env.DB_MAX_RETRIES || '3', 10);
  static readonly DB_RETRY_DELAY_MS = parseInt(process.env.DB_RETRY_DELAY_MS || '1000', 10); // 1s
  static readonly DB_TRANSACTION_TIMEOUT_MS = parseInt(process.env.DB_TRANSACTION_TIMEOUT_MS || '30000', 10); // 30s
  static readonly DB_CLOSE_TIMEOUT_MS = parseInt(process.env.DB_CLOSE_TIMEOUT_MS || '5000', 10); // 5s

  // Response compression
  static readonly COMPRESSION_THRESHOLD_BYTES = parseInt(process.env.COMPRESSION_THRESHOLD_BYTES || '1024', 10);

  // Idempotency
  static readonly IDEMPOTENCY_TTL_MS = parseInt(process.env.IDEMPOTENCY_TTL_MS || '300000', 10); // 5 min
  static readonly IDEMPOTENCY_MAX_STORE_SIZE = parseInt(process.env.IDEMPOTENCY_MAX_STORE_SIZE || '10000', 10);
  static readonly IDEMPOTENCY_CLEANUP_INTERVAL_MS = parseInt(process.env.IDEMPOTENCY_CLEANUP_INTERVAL_MS || '60000', 10); // 1 min

  // Cache
  static readonly CACHE_CLEANUP_INTERVAL_MS = parseInt(process.env.CACHE_CLEANUP_INTERVAL_MS || '30000', 10); // 30s

  // Server-side cache TTLs (seconds)
  static readonly CACHE_TTL_ENTITY = parseInt(process.env.CACHE_TTL_ENTITY || '60', 10); // plugin/pipeline findById
  static readonly CACHE_TTL_MESSAGE = parseInt(process.env.CACHE_TTL_MESSAGE || '300', 10); // announcements/conversations (5 min)
  static readonly CACHE_TTL_REPORT_INVENTORY = parseInt(process.env.CACHE_TTL_REPORT_INVENTORY || '300', 10); // plugin summary/distribution (5 min)
  static readonly CACHE_TTL_REPORT_TIMESERIES = parseInt(process.env.CACHE_TTL_REPORT_TIMESERIES || '120', 10); // execution/build metrics (2 min)
  static readonly CACHE_TTL_COMPLIANCE_RULES = parseInt(process.env.CACHE_TTL_COMPLIANCE_RULES || '60', 10); // active compliance rules
  static readonly CACHE_TTL_BILLING_PLANS = parseInt(process.env.CACHE_TTL_BILLING_PLANS || '14400', 10); // billing plans (4 hours)

  // SSE backpressure
  static readonly SSE_BACKPRESSURE_THRESHOLD = parseInt(process.env.SSE_BACKPRESSURE_THRESHOLD || '10', 10);

  // HTTP Cache-Control headers
  static readonly CACHE_CONTROL_LIST = process.env.CACHE_CONTROL_LIST || 'private, max-age=30, stale-while-revalidate=60';
  static readonly CACHE_CONTROL_DETAIL = process.env.CACHE_CONTROL_DETAIL || 'private, max-age=60, stale-while-revalidate=120';
}

/**
 * Per-section loader map — each section is loaded lazily on first access.
 * This avoids loading all config sections (and their required env vars)
 * when only one section is needed (e.g. CDK synthesis only needs 'aws').
 */
const sectionLoaders: { [K in keyof AppConfig]: () => AppConfig[K] } = {
  server: loadServerConfig,
  auth: loadAuthConfig,
  registry: loadRegistryConfig,
  redis: loadRedisConfig,
  pluginBuild: loadPluginBuildConfig,
  aws: loadAWSConfig,
  rateLimit: loadRateLimitConfig,
  billing: loadBillingConfig,
};

/** Per-section validators — only run for sections that have validation logic. */
const sectionValidators: Partial<{ [K in keyof AppConfig]: (config: AppConfig[K]) => void }> = {
  server: validateServerConfig,
};

/**
 * Configuration facade with lazy per-section loading.
 *
 * Each section is loaded and validated independently on first access,
 * so requesting `Config.get('aws')` does not trigger loading of
 * server, auth, or billing config (and their env var requirements).
 *
 * Usage: `Config.get('server')`, `Config.get('auth')`, etc.
 */
export class Config {
  private static cache = new Map<keyof AppConfig, unknown>();

  /**
   * Get a specific configuration section (loaded lazily on first access).
   */
  static get<K extends keyof AppConfig>(section: K): AppConfig[K] {
    if (!this.cache.has(section)) {
      const loader = sectionLoaders[section];
      const value = loader();
      const validator = sectionValidators[section];
      if (validator) (validator as (v: AppConfig[K]) => void)(value);
      this.cache.set(section, value);
    }
    return this.cache.get(section) as AppConfig[K];
  }

  /**
   * @internal Reset configuration (for testing only)
   */
  static _resetForTesting(): void {
    this.cache.clear();
  }

  /**
   * Validate auth configuration (JWT secrets, algorithms, expiration).
   * Call this at server startup, not during CDK synthesis.
   */
  static validateAuth(): void {
    validateAuthConfig(this.get('auth'));
  }
}
