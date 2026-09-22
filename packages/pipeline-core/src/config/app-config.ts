// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { envInt, envStr, MAX_PAGE_LIMIT as SHARED_MAX_PAGE_LIMIT, DEFAULT_PAGE_LIMIT as SHARED_DEFAULT_PAGE_LIMIT } from '@pipeline-builder/api-core';
import type { AppConfig } from './config-types.js';
import * as HandlerConstants from './handler-constants.js';
import {
  loadRegistryConfig,
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

  // Custom Resource Handler configuration (must be less than Lambda timeout of 30s to allow response handling).
  // Sourced from the dependency-free `handler-constants.ts` leaf — the Lambda handler imports that module
  // directly (not this one) so its esbuild bundle never pulls in aws-cdk-lib via infrastructure-config.
  static readonly HANDLER_TIMEOUT_MS = HandlerConstants.HANDLER_TIMEOUT_MS;
  /** Default platform URL fallback when PLATFORM_BASE_URL is not set. */
  static readonly DEFAULT_PLATFORM_URL = HandlerConstants.DEFAULT_PLATFORM_URL;

  static readonly HANDLER_DEFAULT_BASE_URL = HandlerConstants.HANDLER_DEFAULT_BASE_URL;
  static readonly HANDLER_MAX_RETRIES = HandlerConstants.HANDLER_MAX_RETRIES;
  static readonly HANDLER_RETRY_DELAY_MS = HandlerConstants.HANDLER_RETRY_DELAY_MS;

  // Plugin build queue configuration.
  // NOTE: maxAttempts / backoffDelayMs / workerTimeoutMs are NOT duplicated here —
  // `loadPluginBuildConfig` (infrastructure-config.ts) is their single source of
  // truth, read via `Config.get('pluginBuild')`.
  static readonly PLUGIN_BUILD_QUEUE_NAME = envStr('PLUGIN_BUILD_QUEUE_NAME', 'plugin-build');
  static readonly PLUGIN_BUILD_COMPLETED_RETENTION_SECS = envInt('PLUGIN_BUILD_COMPLETED_RETENTION_SECS', 3_600); // 1 hr
  static readonly PLUGIN_BUILD_FAILED_RETENTION_SECS = envInt('PLUGIN_BUILD_FAILED_RETENTION_SECS', 86_400); // 24 hr

  // Pagination and limits — single source in api-core (validation/common-schemas)
  // so the validation layer, this config, and pipeline-data's CrudService never drift.
  static readonly MAX_PAGE_LIMIT = SHARED_MAX_PAGE_LIMIT;
  static readonly DEFAULT_PAGE_LIMIT = SHARED_DEFAULT_PAGE_LIMIT;
  static readonly MAX_PROMPT_LENGTH = envInt('MAX_PROMPT_LENGTH', 5_000);
  static readonly PLUGIN_MAX_UPLOAD_MB = envInt('PLUGIN_MAX_UPLOAD_MB', 4_096);
  static readonly PIPELINE_NAME_MAX_LENGTH = envInt('PIPELINE_NAME_MAX_LENGTH', 100);
  static readonly DEFAULT_PLUGIN_VERSION = envStr('DEFAULT_PLUGIN_VERSION', '1.0.0');

  // SSE stream timeout for AI generation endpoints
  static readonly SSE_STREAM_TIMEOUT_MS = envInt('SSE_STREAM_TIMEOUT_MS', 300_000); // 5 min

  // Git provider API base URLs (configurable for enterprise instances)
  static readonly GITHUB_API_BASE_URL = envStr('GITHUB_API_BASE_URL', 'https://api.github.com');
  static readonly BITBUCKET_API_BASE_URL = envStr('BITBUCKET_API_BASE_URL', 'https://api.bitbucket.org/2.0');

  // Bulk operations and event ingestion
  static readonly MAX_BULK_ITEMS = envInt('MAX_BULK_ITEMS', 100);
  static readonly MAX_EVENTS_PER_BATCH = envInt('MAX_EVENTS_PER_BATCH', 100);

  // Secrets Manager path prefix for org-scoped secrets
  static readonly SECRETS_PATH_PREFIX = envStr('SECRETS_PATH_PREFIX', 'pipeline-builder');

  /** Build a Secrets Manager path: {prefix}/{orgId}/{name} */
  static secretPath(orgId: string, name: string): string {
    return `${CoreConstants.SECRETS_PATH_PREFIX}/${orgId}/${name}`;
  }

  // Database connection
  static readonly DB_MAX_RETRIES = envInt('DB_MAX_RETRIES', 3);
  static readonly DB_RETRY_DELAY_MS = envInt('DB_RETRY_DELAY_MS', 1_000); // 1s

  // Response compression
  static readonly COMPRESSION_THRESHOLD_BYTES = envInt('COMPRESSION_THRESHOLD_BYTES', 1_024);

  // Idempotency
  static readonly IDEMPOTENCY_TTL_MS = envInt('IDEMPOTENCY_TTL_MS', 300_000); // 5 min
  // Lifetime of an IN-FLIGHT reservation (no response yet). Bounds how long a
  // key stays locked (409) when the process dies mid-handler; must exceed the
  // longest legitimate handler run, since an expired reservation lets a
  // duplicate through.
  static readonly IDEMPOTENCY_PENDING_TTL_MS = envInt('IDEMPOTENCY_PENDING_TTL_MS', 120_000); // 2 min
  static readonly IDEMPOTENCY_MAX_STORE_SIZE = envInt('IDEMPOTENCY_MAX_STORE_SIZE', 10_000);
  static readonly IDEMPOTENCY_CLEANUP_INTERVAL_MS = envInt('IDEMPOTENCY_CLEANUP_INTERVAL_MS', 60_000); // 1 min


  // Server-side cache TTLs (seconds)
  static readonly CACHE_TTL_ENTITY = envInt('CACHE_TTL_ENTITY', 60); // plugin/pipeline findById
  static readonly CACHE_TTL_MESSAGE = envInt('CACHE_TTL_MESSAGE', 300); // announcements/conversations (5 min)
  static readonly CACHE_TTL_REPORT_INVENTORY = envInt('CACHE_TTL_REPORT_INVENTORY', 300); // plugin summary/distribution (5 min)
  static readonly CACHE_TTL_REPORT_TIMESERIES = envInt('CACHE_TTL_REPORT_TIMESERIES', 120); // execution/build metrics (2 min)
  static readonly CACHE_TTL_COMPLIANCE_RULES = envInt('CACHE_TTL_COMPLIANCE_RULES', 60); // active compliance rules
  static readonly CACHE_TTL_BILLING_PLANS = envInt('CACHE_TTL_BILLING_PLANS', 14_400); // billing plans (4 hours)

  // SSE backpressure
  static readonly SSE_BACKPRESSURE_THRESHOLD = envInt('SSE_BACKPRESSURE_THRESHOLD', 10);

  // HTTP Cache-Control headers
  static readonly CACHE_CONTROL_LIST = envStr('CACHE_CONTROL_LIST', 'private, max-age=30, stale-while-revalidate=60');
  static readonly CACHE_CONTROL_DETAIL = envStr('CACHE_CONTROL_DETAIL', 'private, max-age=60, stale-while-revalidate=120');
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
  pluginBuild: loadPluginBuildConfig,
  dockerConfig: loadDockerConfig,
  observability: loadObservabilityConfig,
  compliance: loadComplianceConfig,
  aws: loadAWSConfig,
  rateLimit: loadRateLimitConfig,
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
 * server or auth config (and their env var requirements).
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
   * Like {@link override}, but scoped: snapshots the current cache state for
   * `section` and returns a restore function that reverts it. Use around a
   * single unit of work (e.g. one CDK PipelineBuilder's synth) so a per-builder
   * override does NOT leak into the process-wide cache and bleed into sibling
   * builders in a multi-pipeline CDK app. Calling the returned function restores
   * the exact prior state — the previously cached value, or an unloaded section
   * if it had not been cached yet (so the next `get()` re-loads from env).
   */
  static overrideScoped<K extends keyof AppConfig>(
    section: K,
    partial: Partial<AppConfig[K]>,
  ): () => void {
    const hadCached = this.cache.has(section);
    const previous = hadCached ? this.cache.get(section) : undefined;
    this.override(section, partial);
    return () => {
      if (hadCached) this.cache.set(section, previous);
      else this.cache.delete(section);
    };
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
