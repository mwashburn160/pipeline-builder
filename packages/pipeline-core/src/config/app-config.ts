import type { Algorithm } from 'jsonwebtoken';
import { loadBillingConfig } from './billing-config';
import type { AppConfig } from './config-types';
import {
  loadDatabaseConfig,
  validateDatabaseConfig,
} from './database-config';
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
  static readonly HANDLER_DEFAULT_BASE_URL = process.env.PLATFORM_BASE_URL || 'https://localhost:8443';
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

  // Secrets Manager path prefix for org-scoped secrets
  static readonly SECRETS_PATH_PREFIX = process.env.SECRETS_PATH_PREFIX || 'pipeline-builder';

  // Database connection
  static readonly DB_MAX_RETRIES = parseInt(process.env.DB_MAX_RETRIES || '3', 10);
  static readonly DB_RETRY_DELAY_MS = parseInt(process.env.DB_RETRY_DELAY_MS || '1000', 10); // 1s
  static readonly DB_TRANSACTION_TIMEOUT_MS = parseInt(process.env.DB_TRANSACTION_TIMEOUT_MS || '30000', 10); // 30s
  static readonly DB_CLOSE_TIMEOUT_MS = parseInt(process.env.DB_CLOSE_TIMEOUT_MS || '5000', 10); // 5s
}

/**
 * Configuration facade - composes domain-specific configs.
 * Delegates loading and validation to domain-specific config modules.
 *
 * Usage: `Config.get('server')`, `Config.get('auth')`, etc.
 */
export class Config {
  private static instance: AppConfig | null = null;

  /**
   * Get a specific configuration section.
   *
   * @param section - The configuration section key (e.g. 'server', 'auth', 'database')
   * @returns The typed configuration for that section
   *
   * @example
   * ```typescript
   * const server = Config.get('server');  // ServerConfig
   * const auth = Config.get('auth');      // AuthConfig
   * ```
   */
  static get<K extends keyof AppConfig>(section: K): AppConfig[K] {
    if (!this.instance) {
      this.instance = this.loadConfig();
      this.validate(this.instance);
    }
    return this.instance[section];
  }

  /**
   * @internal Reset configuration (for testing only)
   */
  static _resetForTesting(): void {
    this.instance = null;
  }

  /**
   * Load configuration by composing domain-specific loaders
   */
  private static loadConfig(): AppConfig {
    return {
      server: loadServerConfig(),
      auth: loadAuthConfig(),
      database: loadDatabaseConfig(),
      registry: loadRegistryConfig(),
      redis: loadRedisConfig(),
      pluginBuild: loadPluginBuildConfig(),
      aws: loadAWSConfig(),
      rateLimit: loadRateLimitConfig(),
      billing: loadBillingConfig(),
    };
  }

  /**
   * Validate infrastructure configuration (runs on first Config.get() call)
   */
  private static validate(config: AppConfig): void {
    validateServerConfig(config.server);
    validateDatabaseConfig(config.database);
    // Validate auth at startup when JWT_SECRET is set (skip during CDK synthesis)
    if (config.auth.jwt.secret) {
      validateAuthConfig(config.auth);
    }
  }

  /**
   * Validate auth configuration (JWT secrets, algorithms, expiration).
   * Call this at server startup, not during CDK synthesis.
   */
  static validateAuth(): void {
    validateAuthConfig(this.get('auth'));
  }
}
