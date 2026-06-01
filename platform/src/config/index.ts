// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { QUOTA_TIERS, type QuotaTier, VALID_TIERS } from '@pipeline-builder/api-core';
import { Algorithm } from 'jsonwebtoken';

const isDev = (process.env.NODE_ENV || 'development') === 'development';

/** Default platform URL used as fallback for PLATFORM_BASE_URL, CORS, OAuth callbacks, and service URLs. */
const DEFAULT_PLATFORM_URL = 'https://localhost:8443';

/**
 * Require an environment variable in production, allow a dev-only fallback.
 * @internal
 */
function requireSecret(envVar: string, name: string): string {
  const value = process.env[envVar];
  if (value) return value;
  if (isDev) return 'dev-only-insecure-secret';
  throw new Error(`${name} (${envVar}) is required in production. Generate with: openssl rand -base64 32`);
}

/**
 * Validate that `SECRET_ENCRYPTION_KEY` is set. AI provider keys and IdP
 * client secrets are encrypted at rest; the read paths no longer have a
 * clear-text fallback. Refuse to boot in production when this env is
 * missing so a misconfig surfaces immediately instead of crashing on the
 * first decrypt. In dev, fall back to a deterministic placeholder so
 * single-machine runs don't require any setup.
 */
function requireEncryptionKey(): string {
  const value = process.env.SECRET_ENCRYPTION_KEY;
  if (value) return value;
  if (isDev) {
    // 32-byte deterministic dev key (hex). Operators MUST set the env in
    // any deploy that handles real customer keys — this dev value is
    // documented as insecure in deploy/*.env.example.
    return '0000000000000000000000000000000000000000000000000000000000000000';
  }
  throw new Error(
    'SECRET_ENCRYPTION_KEY is required in production. '
    + 'Generate with: head -c 32 /dev/urandom | base64',
  );
}

/** Per-Alertmanager-instance binding for the relay webhook. */
export interface AlertWebhookInstance {
  /** Stable identifier sent by Alertmanager as `X-Alertmanager-Instance`. */
  id: string;
  /** Bearer token this instance must present. */
  token: string;
  /** When set, every alert in the payload must have its `labels.org_id`
   *  within this list. Missing → no org-scope restriction (legacy mode). */
  allowedOrgIds?: string[];
}

/**
 * Parse the per-instance JSON config from env. Tolerates missing / malformed
 * input: returns [] so the relay returns 503 (Alert relay not configured)
 * at request time rather than crashing the service at startup. Invalid
 * entries log to stderr (no logger available at config-load time).
 */
function parseAlertWebhookInstances(raw: string | undefined): AlertWebhookInstance[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry: unknown) => {
      if (!entry || typeof entry !== 'object') return [];
      const e = entry as Record<string, unknown>;
      if (typeof e.id !== 'string' || !e.id) return [];
      if (typeof e.token !== 'string' || !e.token) return [];
      const inst: AlertWebhookInstance = { id: e.id, token: e.token };
      if (Array.isArray(e.allowedOrgIds) && e.allowedOrgIds.every((x) => typeof x === 'string')) {
        inst.allowedOrgIds = e.allowedOrgIds as string[];
      }
      return [inst];
    });
  } catch {
    // Bad JSON; fall back to legacy mode. Service stays up; misconfig is
    // surfaced via the eventual 401/403 on incoming webhook calls.
    return [];
  }
}

/**
 * Application configuration object.
 * All values are loaded from environment variables with defaults.
 */
// Boot-time required-env validation. Calling requireEncryptionKey()
// during module load means a misconfigured production deploy throws
// here, before any HTTP handler can hit the encryption code path.
// The returned value isn't used (secret-encryption reads process.env
// directly).
requireEncryptionKey();

export const config = {
  app: {
    port: parseInt(process.env.PORT || '3000', 10),
    frontendUrl: process.env.PLATFORM_FRONTEND_URL || DEFAULT_PLATFORM_URL,
  },

  server: {
    trustProxy: parseInt(process.env.TRUST_PROXY || '1', 10),
  },

  cors: {
    credentials: process.env.CORS_CREDENTIALS !== 'false',
    origin: process.env.CORS_ORIGIN
      ? process.env.CORS_ORIGIN.split(',').map(o => o.trim())
      : [process.env.PLATFORM_FRONTEND_URL || DEFAULT_PLATFORM_URL],
  },

  rateLimit: {
    max: parseInt(process.env.LIMITER_MAX || '100', 10),
    windowMs: parseInt(process.env.LIMITER_WINDOWMS || '900000', 10), // 15 min
    /**
     * Per-tier multipliers on top of `rateLimit.max`. A premium-plan org
     * gets its baseline budget multiplied; free/unauthenticated callers
     * stay at the baseline. The JWT carries `tier` (set at issuance time
     * from the org's `planId`), so dispatch is request-local with no
     * extra DB lookup. Sysadmins bypass entirely via the `skip` predicate.
     */
    tierMultipliers: {
      developer: parseFloat(process.env.LIMITER_MULT_DEVELOPER || '1'),
      pro: parseFloat(process.env.LIMITER_MULT_PRO || '10'),
      unlimited: parseFloat(process.env.LIMITER_MULT_UNLIMITED || '50'),
    } as Record<QuotaTier, number>,
    auth: {
      max: parseInt(process.env.AUTH_LIMITER_MAX || '20', 10),
      windowMs: parseInt(process.env.AUTH_LIMITER_WINDOWMS || '900000', 10), // 15 min
    },
    // Observability endpoints (catalog query, range query, log query) hit
    // Prometheus / Loki directly. A noisy operator clicking through panels
    // can saturate upstream — keep a tighter per-org budget than the
    // general limiter. A single dashboard view fans out to one query per
    // panel (Queue Health = 9, Registry Activity = 6, …) and the client may
    // refetch on mount, so the budget must cover a couple of full page
    // loads in a window or legitimate views 429. 120 req / min default.
    observability: {
      max: parseInt(process.env.OBSERVABILITY_LIMITER_MAX || '120', 10),
      windowMs: parseInt(process.env.OBSERVABILITY_LIMITER_WINDOWMS || '60000', 10), // 1 min
    },
  },
  /**
   * Multi-tenant alerting: Alertmanager POSTs to /api/observability/alert-webhook
   * with a bearer token in the Authorization header. The platform relay
   * validates it via constant-time compare. Unset / empty → endpoint returns
   * 503, which is the right failure mode in dev (the in-app /alerts page
   * still works via the read API even if the relay is offline).
   *
   * Configuration: `ALERT_WEBHOOK_INSTANCES='[{"id":"am-0","token":"...",
   * "allowedOrgIds":["org-a","org-b"]}]'`. Each Alertmanager sends
   * `X-Alertmanager-Instance: <id>` alongside its bearer; the relay looks
   * up the matching entry and rejects (a) wrong token, (b) any alert whose
   * `labels.org_id` is outside the instance's `allowedOrgIds` (when set).
   * Omit `allowedOrgIds` to allow any org for that instance.
   */
  alertWebhook: {
    instances: parseAlertWebhookInstances(process.env.ALERT_WEBHOOK_INSTANCES),
  },
  auth: {
    passwordMinLength: parseInt(process.env.PASSWORD_MIN_LENGTH || '8', 10),
    /**
     * bcrypt cost factor for password hashing. Lives under `auth`, not
     * `auth.jwt` — it has nothing to do with JWT signing; the previous
     * placement was a copy-paste artifact. `JWT_SALT_ROUNDS` is honored
     * as a deprecation fallback for one release so existing deploys keep
     * working; prefer `BCRYPT_SALT_ROUNDS` going forward.
     */
    passwordSaltRounds: parseInt(
      process.env.BCRYPT_SALT_ROUNDS || process.env.JWT_SALT_ROUNDS || '12',
      10,
    ),
    jwt: {
      secret: requireSecret('JWT_SECRET', 'JWT secret'),
      expiresIn: parseInt(process.env.JWT_EXPIRES_IN || '7200', 10), // 2 hr
      algorithm: (process.env.JWT_ALGORITHM || 'HS256') as Algorithm,
      /**
       * Per-tier access-token TTL overrides (seconds). When a tier's
       * override is unset, falls back to `expiresIn`. Enterprise/
       * compliance-driven customers typically want SHORTER TTLs (e.g.
       * 30 minutes) so a stolen token's blast window is smaller;
       * developer tier keeps the default for convenience. The actual
       * lookup happens at token issuance — see `resolveTokenExpiresIn`.
       */
      // Built from VALID_TIERS so adding a tier in api-core surfaces a
      // compile error here.
      tierExpiresIn: Object.fromEntries(
        VALID_TIERS.map((tier) => {
          const raw = process.env[`JWT_EXPIRES_IN_${tier.toUpperCase()}`];
          return [tier, raw ? parseInt(raw, 10) : undefined];
        }),
      ) as Record<QuotaTier, number | undefined>,
    },
    refreshToken: {
      secret: requireSecret('REFRESH_TOKEN_SECRET', 'Refresh token secret'),
      expiresIn: parseInt(process.env.REFRESH_TOKEN_EXPIRES_IN || '2592000', 10), // 30 days
    },
    cookie: {
      sameSite: (process.env.COOKIE_SAME_SITE || 'lax') as 'lax' | 'strict' | 'none',
      secure: process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production',
    },
    /**
     * Email-verification token lifetime (ms). 24 h default; tokens are
     * single-use and tied to the user record so a short TTL is mostly a
     * UX trade-off (users following a stale link have to re-request).
     * Previously read inline in services/auth-service.ts.
     */
    verificationTokenTtlMs: parseInt(process.env.AUTH_VERIFICATION_TOKEN_TTL_MS || '86400000', 10),
  },

  mongodb: {
    // MONGODB_URI must be set via environment; no credentials in source code.
    // Example: mongodb://mongo:<password>@mongodb:27017/platform?replicaSet=rs0&authSource=admin
    uri: (() => {
      const uri = process.env.MONGODB_URI;
      if (!uri) throw new Error('MONGODB_URI environment variable is required');
      return uri;
    })(),
  },

  email: {
    enabled: process.env.EMAIL_ENABLED === 'true',
    from: process.env.EMAIL_FROM || 'noreply@example.com',
    fromName: process.env.EMAIL_FROM_NAME || 'Platform',
    provider: (process.env.EMAIL_PROVIDER || 'smtp') as 'smtp' | 'ses',
    smtp: {
      host: process.env.SMTP_HOST || 'localhost',
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: process.env.SMTP_SECURE === 'true',
      user: process.env.SMTP_USER || '',
      pass: process.env.SMTP_PASS || '',
    },
    ses: {
      region: process.env.SES_REGION || process.env.AWS_REGION || 'us-east-1',
      accessKeyId: process.env.SES_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.SES_SECRET_ACCESS_KEY || '',
    },
  },

  invitation: {
    expirationDays: parseInt(process.env.INVITATION_EXPIRATION_DAYS || '7', 10),
    maxPendingPerOrg: parseInt(process.env.INVITATION_MAX_PENDING_PER_ORG || '50', 10),
  },

  oauth: {
    /** Base URL for OAuth callback redirects (e.g. https://yourdomain.com) */
    callbackBaseUrl: process.env.OAUTH_CALLBACK_BASE_URL || process.env.PLATFORM_FRONTEND_URL || DEFAULT_PLATFORM_URL,
    stateTtlMs: parseInt(process.env.OAUTH_STATE_TTL_MS || '600000', 10), // 10 min
    cleanupIntervalMs: parseInt(process.env.OAUTH_CLEANUP_INTERVAL_MS || '60000', 10), // 1 min
    google: {
      clientId: process.env.OAUTH_GOOGLE_CLIENT_ID || '',
      clientSecret: process.env.OAUTH_GOOGLE_CLIENT_SECRET || '',
      enabled: !!process.env.OAUTH_GOOGLE_CLIENT_ID,
      authorizeUrl: process.env.GOOGLE_AUTHORIZE_URL || 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token',
      userinfoUrl: process.env.GOOGLE_USERINFO_URL || 'https://www.googleapis.com/oauth2/v2/userinfo',
    },
    github: {
      clientId: process.env.OAUTH_GITHUB_CLIENT_ID || '',
      clientSecret: process.env.OAUTH_GITHUB_CLIENT_SECRET || '',
      enabled: !!process.env.OAUTH_GITHUB_CLIENT_ID,
      authorizeUrl: process.env.GITHUB_AUTHORIZE_URL || 'https://github.com/login/oauth/authorize',
      tokenUrl: process.env.GITHUB_TOKEN_URL || 'https://github.com/login/oauth/access_token',
      userinfoUrl: process.env.GITHUB_USERINFO_URL || 'https://api.github.com/user',
    },
  },

  audit: {
    // How many days to retain audit events. Read by the AuditEvent TTL
    // index; was previously parsed inline in models/audit-event.ts.
    retentionDays: parseInt(process.env.AUDIT_RETENTION_DAYS || '90', 10),
  },

  quota: {
    // Quota microservice connection
    serviceHost: process.env.QUOTA_SERVICE_HOST || 'quota',
    servicePort: parseInt(process.env.QUOTA_SERVICE_PORT || '3000', 10),
    serviceTimeout: parseInt(process.env.QUOTA_SERVICE_TIMEOUT || '5000', 10), // 5s
    // Quota tier presets (each tier defines its own limits and reset periods).
    // Consumed by Organization model schema defaults.
    tier: {
      developer: {
        ...QUOTA_TIERS.developer.limits,
        resetPeriod: { plugins: '3days', pipelines: '3days', apiCalls: '3days', aiCalls: '3days' },
      },
      pro: {
        ...QUOTA_TIERS.pro.limits,
        resetPeriod: { plugins: '3days', pipelines: '3days', apiCalls: '3days', aiCalls: '3days' },
      },
      unlimited: {
        ...QUOTA_TIERS.unlimited.limits,
        resetPeriod: { plugins: '30days', pipelines: '30days', apiCalls: '30days', aiCalls: '30days' },
      },
    },
  },

  billing: {
    enabled: (process.env.BILLING_ENABLED || 'true').toLowerCase() !== 'false',
    serviceHost: process.env.BILLING_SERVICE_HOST || 'billing',
    servicePort: parseInt(process.env.BILLING_SERVICE_PORT || '3000', 10),
    serviceTimeout: parseInt(process.env.BILLING_SERVICE_TIMEOUT || '5000', 10), // 5s
  },

  compliance: {
    enabled: (process.env.COMPLIANCE_ENABLED || 'true').toLowerCase() !== 'false',
    serviceHost: process.env.COMPLIANCE_SERVICE_HOST || 'compliance',
    servicePort: parseInt(process.env.COMPLIANCE_SERVICE_PORT || '3000', 10),
    serviceTimeout: parseInt(process.env.COMPLIANCE_SERVICE_TIMEOUT || '5000', 10), // 5s
  },

  loki: {
    url: process.env.LOKI_URL || 'http://loki:3100',
    timeout: parseInt(process.env.LOKI_TIMEOUT || '10000', 10), // 10s
  },

  logs: {
    defaultLimit: parseInt(process.env.LOG_DEFAULT_LIMIT || '100', 10),
    maxLimit: parseInt(process.env.LOG_MAX_LIMIT || '1000', 10),
    defaultLookbackMs: parseInt(process.env.LOG_DEFAULT_LOOKBACK_MS || '3600000', 10), // 1 hr
  },

  pagination: {
    defaultLimit: parseInt(process.env.PLATFORM_LIST_DEFAULT || '20', 10),
    maxLimit: parseInt(process.env.PLATFORM_LIST_MAX || '100', 10),
  },
} as const;

export type Config = typeof config;
