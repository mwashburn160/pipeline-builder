import { createLogger } from '@mwashburn160/api-core';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Algorithm } from 'jsonwebtoken';
import { AppConfig } from './config-types';
import { getComputeType } from '../core/pipeline-helpers';

const log = createLogger('Config');

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
 * Configuration loader
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
   * Load configuration from environment variables
   */
  private static loadConfig(): AppConfig {
    return {
      server: {
        port: parseInt(process.env.PORT || '3000'),
        cors: {
          credentials: process.env.CORS_CREDENTIALS !== 'false',
          origin: process.env.CORS_ORIGIN
            ? process.env.CORS_ORIGIN.split(',').map(o => o.trim())
            : [process.env.PLATFORM_BASE_URL || 'https://localhost:8443'],
        },
        trustProxy: parseInt(process.env.TRUST_PROXY || '1'),
        platformUrl: process.env.PLATFORM_BASE_URL || 'https://localhost:8443',
      },
      auth: {
        jwt: {
          secret: process.env.JWT_SECRET || 'no-secret',
          expiresIn: parseInt(process.env.JWT_EXPIRES_IN || '7200'),
          algorithm: (process.env.JWT_ALGORITHM || 'HS256') as Algorithm,
          saltRounds: parseInt(process.env.JWT_SALT_ROUNDS || '12'),
        },
        refreshToken: {
          secret: process.env.REFRESH_TOKEN_SECRET || 'no-secret',
          expiresIn: parseInt(process.env.REFRESH_TOKEN_EXPIRES_IN || '2592000'),
        },
      },
      database: {
        postgres: {
          host: process.env.DB_HOST || 'postgres',
          port: parseInt(process.env.DB_PORT || '5432'),
          database: process.env.DATABASE || 'pipeline_builder',
          user: process.env.DB_USER || 'postgres',
          password: process.env.DB_PASSWORD || 'passsword',
        },
        mongodb: {
          uri: process.env.MONGODB_URI || 'mongodb://mongo:password@mongodb:27017/platform?replicaSet=rs0&authSource=admin',
        },
        drizzle: {
          maxPoolSize: parseInt(process.env.DRIZZLE_MAX_POOL_SIZE || '20'),
          idleTimeoutMillis: parseInt(process.env.DRIZZLE_IDLE_TIMEOUT_MILLIS || '30000'),
          connectionTimeoutMillis: parseInt(process.env.DRIZZLE_CONNECTION_TIMEOUT_MILLIS || '5000'),
        },
      },
      registry: {
        host: process.env.IMAGE_REGISTRY_HOST || 'registry',
        port: parseInt(process.env.IMAGE_REGISTRY_PORT || '5000'),
        user: process.env.IMAGE_REGISTRY_USER || 'admin',
        token: process.env.IMAGE_REGISTRY_TOKEN || 'password',
        network: process.env.DOCKER_NETWORK || '',
      },
      aws: {
        lambda: {
          runtime: this.parseRuntime(process.env.LAMBDA_RUNTIME || 'nodejs22.x'),
          timeout: Duration.seconds(parseInt(process.env.LAMBDA_TIMEOUT || '900')),
          memorySize: parseInt(process.env.LAMBDA_MEMORY_SIZE || '128'),
          architecture: process.env.LAMBDA_ARCHITECTURE === 'x86_64'
            ? Architecture.X86_64
            : Architecture.ARM_64,
        },
        logging: {
          groupName: process.env.LOG_GROUP_NAME || '/pipeline-builder/logs',
          retention: this.parseRetention(process.env.LOG_RETENTION || '1'),
          removalPolicy: process.env.LOG_REMOVAL_POLICY === 'RETAIN'
            ? RemovalPolicy.RETAIN
            : RemovalPolicy.DESTROY,
        },
        codeBuild: {
          computeType: getComputeType(process.env.CODEBUILD_COMPUTE_TYPE || 'SMALL'),
        },
      },
      rateLimit: {
        max: parseInt(process.env.LIMITER_MAX || '100'),
        windowMs: parseInt(process.env.LIMITER_WINDOWMS || '900000'),
        legacyHeaders: false,
        standardHeaders: true,
      },
    };
  }

  /**
   * Parse Lambda runtime from string
   */
  private static parseRuntime(runtime: string): Runtime {
    const runtimeMap: Record<string, Runtime> = {
      'nodejs18.x': Runtime.NODEJS_18_X,
      'nodejs20.x': Runtime.NODEJS_20_X,
      'nodejs22.x': Runtime.NODEJS_22_X,
    };
    return runtimeMap[runtime] || Runtime.NODEJS_22_X;
  }

  /**
   * Parse log retention from days
   */
  private static parseRetention(days: string): RetentionDays {
    const retentionMap: Record<string, RetentionDays> = {
      1: RetentionDays.ONE_DAY,
      3: RetentionDays.THREE_DAYS,
      5: RetentionDays.FIVE_DAYS,
      7: RetentionDays.ONE_WEEK,
      14: RetentionDays.TWO_WEEKS,
      30: RetentionDays.ONE_MONTH,
      60: RetentionDays.TWO_MONTHS,
      90: RetentionDays.THREE_MONTHS,
      120: RetentionDays.FOUR_MONTHS,
      150: RetentionDays.FIVE_MONTHS,
      180: RetentionDays.SIX_MONTHS,
      365: RetentionDays.ONE_YEAR,
      400: RetentionDays.THIRTEEN_MONTHS,
      545: RetentionDays.EIGHTEEN_MONTHS,
      731: RetentionDays.TWO_YEARS,
      1827: RetentionDays.FIVE_YEARS,
      3653: RetentionDays.TEN_YEARS,
    };
    return retentionMap[days] || RetentionDays.ONE_DAY;
  }

  /**
   * Validate infrastructure configuration (runs on every Config.get() call)
   */
  static validate(config: AppConfig): void {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check CORS configuration
    const origin = config.server.cors.origin;
    if (origin === '*' || (Array.isArray(origin) && origin.includes('*'))) {
      warnings.push('CORS origin set to wildcard (*) - consider restricting to specific domains');
    }

    // Check pool size
    if (config.database.drizzle.maxPoolSize < 10) {
      warnings.push('Database pool size is less than 10 - may cause performance issues under load');
    }

    // Check platform URL uses HTTPS
    if (config.server.platformUrl.startsWith('http://') &&
      !config.server.platformUrl.includes('localhost')) {
      warnings.push('Platform URL uses HTTP instead of HTTPS - insecure for production');
    }

    // Display warnings
    if (warnings.length > 0) {
      log.warn('Configuration warnings:');
      warnings.forEach(warning => log.warn(`  - ${warning}`));
    }

    // Throw errors
    if (errors.length > 0) {
      throw new Error(
        `Configuration validation failed:\n${errors.map(e => `  - ${e}`).join('\n')}`,
      );
    }
  }

  /**
   * Validate auth configuration (JWT secrets, algorithms, expiration)
   * Call this at server startup, not during CDK synthesis.
   */
  static validateAuth(config?: AppConfig): void {
    const cfg = config ?? this.get();
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check for insecure secrets
    const insecureSecrets = [
      'secret',
      'password',
      'changeme',
      'default',
      '123456',
      'admin',
    ];

    const jwtSecretLower = cfg.auth.jwt.secret.toLowerCase();
    if (insecureSecrets.some(s => jwtSecretLower.includes(s))) {
      errors.push('JWT secret appears to be insecure or default value');
    }

    const refreshSecretLower = cfg.auth.refreshToken.secret.toLowerCase();
    if (insecureSecrets.some(s => refreshSecretLower.includes(s))) {
      errors.push('Refresh token secret appears to be insecure or default value');
    }

    // Check secret length
    if (cfg.auth.jwt.secret.length < 32) {
      errors.push('JWT secret should be at least 32 characters long');
    }

    if (cfg.auth.refreshToken.secret.length < 32) {
      errors.push('Refresh token secret should be at least 32 characters long');
    }

    // Check JWT expiration times
    if (cfg.auth.jwt.expiresIn > 7200) {
      warnings.push('JWT expiration time is greater than 2 hours - shorter expiration recommended');
    }

    // Check algorithm
    if (!CoreConstants.ALLOWED_JWT_ALGORITHMS.includes(cfg.auth.jwt.algorithm)) {
      errors.push(`JWT algorithm ${cfg.auth.jwt.algorithm} is not in the allowed list`);
    }

    // Display warnings
    if (warnings.length > 0) {
      log.warn('Auth configuration warnings:');
      warnings.forEach(warning => log.warn(`  - ${warning}`));
    }

    // Throw errors
    if (errors.length > 0) {
      throw new Error(
        `Auth configuration validation failed:\n${errors.map(e => `  - ${e}`).join('\n')}`,
      );
    }
  }
}
