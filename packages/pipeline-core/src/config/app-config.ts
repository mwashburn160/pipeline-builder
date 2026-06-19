// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Algorithm } from 'jsonwebtoken';
import { loadBillingConfig } from './billing-config.js';
import type { AppConfig } from './config-types.js';
import * as HandlerConstants from './handler-constants.js';
import {
  loadRegistryConfig,
  loadRedisConfig,
  loadPluginBuildConfig,
  loadDockerConfig,
  loadDatabaseConfig,
  loadObservabilityConfig,
  loadComplianceConfig,
  loadAWSConfig,
} from './infrastructure-config.js';
import {
  loadServerConfig,
  loadAuthConfig,
  loadRateLimitConfig,
  validateServerConfig,
  validateAuthConfig,
} from './server-config.js';

/**
 * Core constants — configurable via environment variables with sensible defaults.
 */
export class CoreConstants {
  static readonly NAME_PATTERN = /^[a-z0-9-]+$/;

  // Supported JWT algorithms
  static readonly ALLOWED_JWT_ALGORITHMS: Algorithm[] = ['HS256', 'RS256', 'ES256'];

  // Custom Resource Handler configuration (must be less than Lambda timeout of 30s to allow response handling).
  // Sourced from the dependency-free `handler-constants.ts` leaf — the Lambda handler imports that module
  // directly (not this one) so its esbuild bundle never pulls in aws-cdk-lib via infrastructure-config.
  static readonly HANDLER_TIMEOUT_MS = HandlerConstants.HANDLER_TIMEOUT_MS;
  /** Default platform URL fallback when PLATFORM_BASE_URL is not set. */
  static readonly DEFAULT_PLATFORM_URL = HandlerConstants.DEFAULT_PLATFORM_URL;

  static readonly HANDLER_DEFAULT_BASE_URL = HandlerConstants.HANDLER_DEFAULT_BASE_URL;
  static readonly HANDLER_MAX_RETRIES = HandlerConstants.HANDLER_MAX_RETRIES;
  static readonly HANDLER_RETRY_DELAY_MS = HandlerConstants.HANDLER_RETRY_DELAY_MS;

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
  static readonly PLUGIN_MAX_UPLOAD_MB = parseInt(process.env.PLUGIN_MAX_UPLOAD_MB || '4096', 10);
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

  /** Build a Secrets Manager path: {prefix}/{orgId}/{name} */
  static secretPath(orgId: string, name: string): string {
    return `${CoreConstants.SECRETS_PATH_PREFIX}/${orgId}/${name}`;
  }

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
  database: loadDatabaseConfig,
  registry: loadRegistryConfig,
  redis: loadRedisConfig,
  pluginBuild: loadPluginBuildConfig,
  dockerConfig: loadDockerConfig,
  observability: loadObservabilityConfig,
  compliance: loadComplianceConfig,
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
   * Merge a partial override into a config section, taking precedence over the
   * env-loaded values for all subsequent `Config.get(section)` calls.
   *
   * Used at CDK synth start to inject platform-sourced infrastructure config
   * (e.g. the registry pull host derived from the platform's public URL) so the
   * synth does not silently depend on the operator's local `process.env`.
   * `undefined` fields in `partial` are ignored so they never clobber a loaded
   * value. Loads (and validates) the section first so the override merges onto
   * the real defaults.
   */
  static override<K extends keyof AppConfig>(section: K, partial: Partial<AppConfig[K]>): void {
    const current = this.get(section);
    const defined = Object.fromEntries(
      Object.entries(partial).filter(([, v]) => v !== undefined),
    ) as Partial<AppConfig[K]>;
    this.cache.set(section, { ...current, ...defined });
  }

  /**
   * Clear all cached config sections so the next `Config.get()` re-reads them
   * from the current `process.env` (re-running each section's loader + validator).
   *
   * Use when env has been mutated in-process and the cache is now stale — e.g. a
   * long-running CLI that reconfigures between operations. CDK synth runs in a
   * fresh subprocess that already reads env on first access, so it does not need
   * this. Note: this also drops any values set via {@link override}.
   */
  static reload(): void {
    this.cache.clear();
  }

  /**
   * @internal Reset configuration (for testing only). Alias for {@link reload}.
   */
  static _resetForTesting(): void {
    this.reload();
  }

  /**
   * Validate auth configuration (JWT secrets, algorithms, expiration).
   * Call this at server startup, not during CDK synthesis.
   */
  static validateAuth(): void {
    validateAuthConfig(this.get('auth'));
  }

  /**
   * Untyped config access — use when the published package types don't include a new section yet.
   * Avoids the `(Config as unknown as ...).get(...)` cast pattern in consumers.
   */
  static getAny(section: string): unknown {
    return this.get(section as keyof AppConfig);
  }
}
