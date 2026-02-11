import { Duration } from 'aws-cdk-lib';
import { Algorithm } from 'jsonwebtoken';
import { AppConfig } from './config-types';
import {
  loadDatabaseConfig,
  validateDatabaseConfig,
} from './database-config';
import {
  loadRegistryConfig,
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
 * Core constants that don't change
 */
export class CoreConstants {
  static readonly NAME_PATTERN = /^[a-z0-9-]+$/;

  // Security best practices
  static readonly MIN_PASSWORD_LENGTH = parseInt(process.env.MIN_PASSWORD_LENGTH || '12');
  static readonly MAX_LOGIN_ATTEMPTS = parseInt(process.env.MAX_LOGIN_ATTEMPTS || '5');
  static readonly ACCOUNT_LOCKOUT_DURATION = Duration.minutes(15);

  // Supported JWT algorithms
  static readonly ALLOWED_JWT_ALGORITHMS: Algorithm[] = ['HS256', 'RS256', 'ES256'];

  // Custom Resource Handler configuration
  static readonly HANDLER_TIMEOUT_MS = parseInt(process.env.HANDLER_TIMEOUT_MS || '30000');
  static readonly HANDLER_DEFAULT_BASE_URL = process.env.PLATFORM_BASE_URL || 'https://localhost:8443';
}

/**
 * Configuration facade - composes domain-specific configs
 *
 * Maintains backward compatibility with existing `Config.get()` usage.
 * Delegates loading and validation to domain-specific config modules.
 */
export class Config {
  private static instance: AppConfig | null = null;

  /**
   * Get the application configuration
   * Loads from environment variables with sensible defaults
   */
  static get(): AppConfig {
    if (!this.instance) {
      this.instance = this.loadConfig();
      this.validate(this.instance);
    }
    return this.instance;
  }

  /**
   * Reset configuration (useful for testing)
   */
  static reset(): void {
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
      aws: loadAWSConfig(),
      rateLimit: loadRateLimitConfig(),
    };
  }

  /**
   * Validate infrastructure configuration (runs on every Config.get() call)
   */
  static validate(config: AppConfig): void {
    validateServerConfig(config.server);
    validateDatabaseConfig(config.database);
  }

  /**
   * Validate auth configuration (JWT secrets, algorithms, expiration)
   * Call this at server startup, not during CDK synthesis.
   */
  static validateAuth(config?: AppConfig): void {
    const cfg = config ?? this.get();
    validateAuthConfig(cfg.auth);
  }
}
