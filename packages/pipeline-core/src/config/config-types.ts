import type { QuotaTier } from '@mwashburn160/api-core';
import type { Duration, RemovalPolicy } from 'aws-cdk-lib';
import type { ComputeType } from 'aws-cdk-lib/aws-codebuild';
import type { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import type { RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { Algorithm } from 'jsonwebtoken';

/**
 * Type-safe configuration interface
 */
export interface AppConfig {
  readonly server: ServerConfig;
  readonly auth: AuthConfig;
  readonly database: DatabaseConfig;
  readonly registry: RegistryConfig;
  readonly redis: RedisConfig;
  readonly pluginBuild: PluginBuildConfig;
  readonly aws: AWSConfig;
  readonly rateLimit: RateLimitConfig;
  readonly billing: BillingConfig;
}

/** Express server configuration. */
export interface ServerConfig {
  /** HTTP listen port (env: `PORT`). */
  readonly port: number;
  readonly cors: {
    /** Whether to include credentials in CORS responses (env: `CORS_CREDENTIALS`). */
    readonly credentials: boolean;
    /** Allowed origin(s) — single string, array, or `'*'` (env: `CORS_ORIGIN`). */
    readonly origin: string | string[];
  };
  /** Number of reverse proxy hops to trust (env: `TRUST_PROXY`). */
  readonly trustProxy: number;
  /** Frontend base URL, used as CORS fallback (env: `PLATFORM_BASE_URL`). */
  readonly platformUrl: string;
  readonly httpClient: {
    /** Default HTTP request timeout in ms (env: `HTTP_CLIENT_TIMEOUT`). */
    readonly timeout: number;
    /** Maximum retry attempts for failed requests (env: `HTTP_CLIENT_MAX_RETRIES`). */
    readonly maxRetries: number;
    /** Base delay between retries in ms (env: `HTTP_CLIENT_RETRY_DELAY_MS`). */
    readonly retryDelayMs: number;
  };
  readonly sse: {
    /** Max SSE clients per request (env: `SSE_MAX_CLIENTS_PER_REQUEST`). */
    readonly maxClientsPerRequest: number;
    /** SSE client timeout in ms (env: `SSE_CLIENT_TIMEOUT_MS`). */
    readonly clientTimeoutMs: number;
    /** SSE cleanup interval in ms (env: `SSE_CLEANUP_INTERVAL_MS`). */
    readonly cleanupIntervalMs: number;
  };
  readonly services: {
    /** Plugin service hostname (env: `PLUGIN_SERVICE_HOST`). */
    readonly pluginHost: string;
    /** Plugin service port (env: `PLUGIN_SERVICE_PORT`). */
    readonly pluginPort: number;
  };
}

/** JWT and refresh token authentication configuration. */
export interface AuthConfig {
  readonly jwt: {
    /** Signing secret for access tokens (env: `JWT_SECRET`). */
    readonly secret: string;
    /** Token lifetime in seconds (env: `JWT_EXPIRES_IN`). */
    readonly expiresIn: number;
    /** Signing algorithm, e.g. `'HS256'` (env: `JWT_ALGORITHM`). */
    readonly algorithm: Algorithm;
    /** bcrypt salt rounds for password hashing (env: `JWT_SALT_ROUNDS`). */
    readonly saltRounds: number;
  };
  readonly refreshToken: {
    /** Signing secret for refresh tokens (env: `REFRESH_TOKEN_SECRET`). */
    readonly secret: string;
    /** Token lifetime in seconds (env: `REFRESH_TOKEN_EXPIRES_IN`). */
    readonly expiresIn: number;
  };
}

/** PostgreSQL and Drizzle ORM database configuration. */
export interface DatabaseConfig {
  readonly postgres: {
    /** PostgreSQL host (env: `DB_HOST`). */
    readonly host: string;
    /** PostgreSQL port (env: `DB_PORT`). */
    readonly port: number;
    /** Database name (env: `DATABASE`). */
    readonly database: string;
    /** Database user (env: `DB_USER`). */
    readonly user: string;
    /** Database password (env: `DB_PASSWORD`). */
    readonly password: string;
  };
  readonly drizzle: {
    /** Maximum connection pool size (env: `DRIZZLE_MAX_POOL_SIZE`). */
    readonly maxPoolSize: number;
    /** Idle connection timeout in ms (env: `DRIZZLE_IDLE_TIMEOUT_MILLIS`). */
    readonly idleTimeoutMillis: number;
    /** New connection timeout in ms (env: `DRIZZLE_CONNECTION_TIMEOUT_MILLIS`). */
    readonly connectionTimeoutMillis: number;
  };
}

export interface RegistryConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly token: string;
  /** Docker network for build/push (empty string = default). */
  readonly network: string;
  /** Allow insecure (self-signed TLS) registry connections (env: `DOCKER_REGISTRY_INSECURE`). */
  readonly insecure: boolean;
}

export interface RedisConfig {
  readonly host: string;
  readonly port: number;
}

export interface PluginBuildConfig {
  /** Max concurrent Docker plugin builds (BullMQ worker concurrency). */
  readonly concurrency: number;
}

export interface AWSConfig {
  readonly lambda: {
    readonly runtime: Runtime;
    readonly timeout: Duration;
    readonly memorySize: number;
    readonly architecture: Architecture;
    readonly reservedConcurrentExecutions: number;
  };
  readonly logging: {
    readonly groupName: string;
    readonly retention: RetentionDays;
    readonly removalPolicy: RemovalPolicy;
  };
  readonly codeBuild: {
    readonly computeType: ComputeType;
  };
}

/** Express rate limiting configuration. */
export interface RateLimitConfig {
  /** Maximum requests per window (env: `LIMITER_MAX`). */
  readonly max: number;
  /** Rate limit window in milliseconds (env: `LIMITER_WINDOWMS`). */
  readonly windowMs: number;
  /** Include legacy `X-RateLimit-*` headers. */
  readonly legacyHeaders: boolean;
  /** Include standard `RateLimit-*` headers (RFC 6585). */
  readonly standardHeaders: boolean;
}

/** Price configuration for a single billing plan (in cents). */
export interface BillingPlanPrices {
  readonly monthly: number;
  readonly annual: number;
}

/** Full billing plan definition used for seeding and runtime configuration. */
export interface BillingPlanConfig {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly tier: QuotaTier;
  readonly prices: BillingPlanPrices;
  readonly features: readonly string[];
  readonly isActive: boolean;
  readonly isDefault: boolean;
  readonly sortOrder: number;
}

/** Billing plans configuration. */
export interface BillingConfig {
  readonly plans: readonly BillingPlanConfig[];
}
