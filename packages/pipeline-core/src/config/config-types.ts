// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0


/**
 * Type-safe configuration interface
 */
export interface AppConfig {
  readonly server: ServerConfig;
  readonly auth: AuthConfig;
  readonly database: DatabaseConfig;
  readonly registry: RegistryConfig;
  readonly pluginBuild: PluginBuildConfig;
  readonly dockerConfig: BuildConfig;
  readonly observability: ObservabilityConfig;
  readonly compliance: ComplianceConfig;
  readonly aws: AWSConfig;
  readonly rateLimit: RateLimitConfig;
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
  /** Sibling-service addresses, resolved by api-core's `serviceEndpoint`
   *  (`<NAME>_SERVICE_HOST` / `<NAME>_SERVICE_PORT`). */
  readonly services: {
    readonly pluginHost: string;
    readonly pluginPort: number;
    readonly pipelineHost: string;
    readonly pipelinePort: number;
    readonly messageHost: string;
    readonly messagePort: number;
    readonly platformHost: string;
    readonly platformPort: number;
    readonly complianceHost: string;
    readonly compliancePort: number;
    readonly billingHost: string;
    readonly billingPort: number;
    readonly billingTimeout: number;
    /** image-registry service — the plugin worker asks it to sign pushed images (env: `IMAGE_REGISTRY_SERVICE_HOST`). */
    readonly imageRegistryHost: string;
    /** env: `IMAGE_REGISTRY_SERVICE_PORT` */
    readonly imageRegistryPort: number;
    readonly quotaHost: string;
    readonly quotaPort: number;
    readonly reportingHost: string;
    readonly reportingPort: number;
    readonly askHost: string;
    readonly askPort: number;
  };
}

/** Authentication configuration for the generic service scaffold. */
export interface AuthConfig {
  readonly jwt: {
    /**
     * Token lifetime in seconds (env: `JWT_EXPIRES_IN`).
     *
     * There is no JWT SECRET here any more. Every token is asymmetric: a user
     * token is ES256 signed by platform alone (`services/token-signing`), and an
     * internal service token is ES256 signed by the CALLING service with its own
     * key (#14, `SERVICE_SIGNING_KEY_FILE` / `SERVICE_KEY_BUNDLE_FILE`).
     */
    readonly expiresIn: number;
    /** bcrypt salt rounds for password hashing (env: `BCRYPT_SALT_ROUNDS`). */
    readonly saltRounds: number;
  };
  readonly refreshToken: {
    /**
     * Token lifetime in seconds (env: `REFRESH_TOKEN_EXPIRES_IN`). There is no
     * refresh-token SECRET any more: a refresh token is a user token, signed
     * with platform's ES256 key like every other credential a person holds.
     */
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
  /**
   * Host/port an OUT-OF-CLUSTER client (notably AWS CodeBuild) uses to pull
   * plugin images, when it differs from the in-cluster `host`/`port`. The
   * in-cluster `registry:5000` ClusterIP isn't resolvable from the VPC, so the
   * synthesized CodeBuild image URI must point at the public gateway instead.
   * Env: `IMAGE_REGISTRY_PULL_HOST` / `IMAGE_REGISTRY_PULL_PORT`. Optional;
   * consumers fall back to `host`/`port` when unset (single-host /
   * in-cluster-only deploys). `loadRegistryConfig` always populates them.
   */
  readonly pullHost?: string;
  readonly pullPort?: number;
  /** Docker network for build/push (empty string = default). */
  readonly network: string;
  /**
   * BuildKit talks to the registry over plain HTTP when true; HTTPS with the
   * system CA bundle otherwise. Env: `IMAGE_REGISTRY_HTTP` (defaults true —
   * the in-cluster registry has no TLS).
   */
  readonly http: boolean;
}

export interface PluginBuildConfig {
  readonly concurrency: number;
  readonly maxAttempts: number;
  readonly backoffDelayMs: number;
  readonly workerTimeoutMs: number;
  readonly tempDirMaxAgeMs: number;
  readonly dlqMaxAttempts: number;
  readonly dlqBackoffBaseMs: number;
  readonly dlqMaxSize: number;
}

export interface BuildConfig {
  /** Root directory for build temp files. */
  readonly tempRoot: string;
  /** Build timeout in milliseconds. */
  readonly timeoutMs: number;
  /** Push timeout in milliseconds. */
  readonly pushTimeoutMs: number;
  /**
   * Path to the buildkitd socket the plugin's `buildctl` connects to. In k8s
   * and compose this is a shared emptyDir/tmpfs volume mounted from the
   * buildkitd sidecar.
   */
  readonly buildkitAddr: string;
  /**
   * PEM public key plugin images are verified against (env:
   * `PLUGIN_SIGNING_PUBLIC_KEY_FILE`). The PRIVATE half lives only in the
   * image-registry service, which signs every pushed plugin image — never in the
   * plugin pod, whose network namespace is shared with untrusted builds.
   */
  readonly signingPublicKeyFile: string;
}

export interface ObservabilityConfig {
  readonly logLevel: string;
  readonly logFormat: string;
  readonly serviceName: string;
  readonly tracing: {
    readonly enabled: boolean;
    readonly endpoint: string;
  };
}

export interface ComplianceConfig {
  readonly scanSchedulerIntervalMs: number;
  /** When false, the scheduler skips scans/schedules for the system org. Default: false. */
  readonly systemOrgScansEnabled: boolean;
  /** Cross-pod leader-lock TTL for the scan scheduler (ms). Default: 300000. */
  readonly scanLockTtlMs: number;
  /** How often the digest scheduler checks for due digests (ms). Default: 3600000. */
  readonly digestSchedulerIntervalMs: number;
  /** Cross-pod leader-lock TTL for the digest scheduler (ms). Default: 300000. */
  readonly digestLockTtlMs: number;
}

/**
 * AWS infrastructure configuration.
 *
 * Deliberately expressed in PLAIN DATA (numbers, strings, string unions) rather
 * than CDK value objects (`Duration`, `Runtime`, `RetentionDays`, ...). Config is
 * loaded by every service, but only the CDK entry point (`@pipeline-builder/
 * pipeline-core/cdk`) builds stacks  typing this block with CDK classes put
 * `aws-cdk-lib` on the import graph of `Config`, and therefore of every API
 * service that reads so much as a port number. Conversion to CDK objects happens
 * at the construct boundary in `config/aws-config-cdk.ts`.
 */
export interface AWSConfig {
  readonly lambda: {
    /** Lambda runtime identifier, e.g. `'nodejs24.x'` (env: `LAMBDA_RUNTIME`). */
    readonly runtime: string;
    /** Function timeout in seconds (env: `LAMBDA_TIMEOUT`). */
    readonly timeoutSeconds: number;
    readonly memorySize: number;
    /** Lambda CPU architecture (env: `LAMBDA_ARCHITECTURE`, `ARM_64` or `x86_64`). */
    readonly architecture: 'arm64' | 'x86_64';
    readonly reservedConcurrentExecutions?: number;
  };
  readonly logging: {
    readonly groupName: string;
  };
  readonly codeBuild: {
    /** CodeBuild compute type name, e.g. `'SMALL'` (env: `CODEBUILD_COMPUTE_TYPE`). */
    readonly computeType: string;
    /**
     * Image used for CodeBuild steps that don't have a plugin-baked image
     * (cold-start synth bootstrap, ShellSteps with no registry, and
     * `metadata_only` plugins). env: `CODEBUILD_DEFAULT_IMAGE`. Default
     * `pipeline-bootstrap:1.0` — the local tag built by
     * `deploy/codebuild/bootstrap/Dockerfile`, with `pipeline-manager`
     * baked in.
     *
     * Contract: the image MUST have `pipeline-manager` on PATH. The
     * bootstrap synth path does not self-heal via `npm install -g`;
     * pointing this at an image without the tool gets exit 127 on the
     * first cold-start build.
     *
     * Resolution:
     * - Bare tag (no `/`) → auto-prefixed to
     *   `<registry-host>:<port>/library/<tag>` using the registry config,
     *   with the per-org platform Secret as Basic auth (same flow as
     *   plugin images).
     * - Fully-qualified registry URI (contains `/`) → used as-is, no
     *   auth wired (operator owns making it pullable).
     * - When the registry isn't configured or per-org auth isn't
     *   available at the call site, falls back to
     *   `aws/codebuild/standard:8.0` with a warning — cold-start synth
     *   will then fail on `pipeline-manager: not found`, surfacing the
     *   misconfiguration loudly instead of silently swapping images.
     */
    readonly defaultImage: string;
  };
}

/** Express rate limiting configuration. */
export interface RateLimitConfig {
  /** Maximum requests per window (env: `LIMITER_MAX`). */
  readonly max: number;
  /** Rate limit window in milliseconds (env: `LIMITER_WINDOWMS`). */
  readonly windowMs: number;
}
