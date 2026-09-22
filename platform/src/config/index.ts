// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { envInt, QUOTA_TIERS, type QuotaTier, VALID_TIERS } from '@pipeline-builder/api-core';
import { assertWebAuthnConfig, resolveWebAuthnConfig } from './webauthn-validate.js';

const isDev = (process.env.NODE_ENV || 'development') === 'development';

/** Default platform URL used as fallback for PLATFORM_BASE_URL, CORS, OAuth callbacks, and service URLs. */
const DEFAULT_PLATFORM_URL = 'https://localhost:8443';

/**
 * Require an environment variable in production, allow a dev-only fallback.
 * @internal
 */
/**
 * Per-tier quota reset period, overridable via `QUOTA_TIER_<TIER>_RESET_PERIOD`
 * (a single duration string applied to every quota type). Defaults: `3days`
 * for developer/pro, `30days` for team/enterprise.
 * @internal
 */
function tierResetPeriod(tier: QuotaTier, fallback: string): { plugins: string; pipelines: string; apiCalls: string; aiCalls: string } {
  const p = process.env[`QUOTA_TIER_${tier.toUpperCase()}_RESET_PERIOD`] || fallback;
  return { plugins: p, pipelines: p, apiCalls: p, aiCalls: p };
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

/** Object-lock mode for exported chain heads. `none` = the target has no
 *  object-lock support (the export still runs, just without WORM retention). */
function auditHeadLockMode(): 'COMPLIANCE' | 'GOVERNANCE' | 'none' {
  const raw = (process.env.AUDIT_HEAD_EXPORT_LOCK_MODE || 'COMPLIANCE').toUpperCase();
  if (raw === 'COMPLIANCE' || raw === 'GOVERNANCE') return raw;
  if (raw === 'NONE') return 'none';
  throw new Error('AUDIT_HEAD_EXPORT_LOCK_MODE must be COMPLIANCE, GOVERNANCE or none');
}

/** Per-Alertmanager-instance binding for the relay webhook. */
export interface AlertWebhookInstance {
  /** Stable identifier sent by Alertmanager as `X-Alertmanager-Instance`. */
  id: string;
  /** Bearer token this instance must present. */
  token: string;
  /** Rotation only: the outgoing token, still accepted while set. An empty
   *  string (the deploy manifests' default) means "not rotating". */
  previousToken?: string;
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
      if (typeof e.previousToken === 'string' && e.previousToken) inst.previousToken = e.previousToken;
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
    port: envInt('PORT', 3000),
    frontendUrl: process.env.PLATFORM_FRONTEND_URL || DEFAULT_PLATFORM_URL,
  },

  // Deployment target (aws-ec2 | aws-eks | local | docker | minikube), surfaced by
  // the public /config endpoint so the frontend can gate target-specific UI.
  deployTarget: process.env.DEPLOY_TARGET || 'local',

  server: {
    trustProxy: envInt('TRUST_PROXY', 1),
    /** How often the readiness monitor re-checks Mongo after boot. */
    readinessMonitorIntervalMs: envInt('READINESS_MONITOR_INTERVAL_MS', 15_000),
    /** Force-exit deadline for a graceful shutdown. */
    shutdownTimeoutMs: envInt('SHUTDOWN_TIMEOUT_MS', 15_000),
  },

  cors: {
    credentials: process.env.CORS_CREDENTIALS !== 'false',
    origin: process.env.CORS_ORIGIN
      ? process.env.CORS_ORIGIN.split(',').map(o => o.trim())
      : [process.env.PLATFORM_FRONTEND_URL || DEFAULT_PLATFORM_URL],
  },

  rateLimit: {
    max: envInt('LIMITER_MAX', 100),
    windowMs: envInt('LIMITER_WINDOWMS', 900000), // 15 min
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
      team: parseFloat(process.env.LIMITER_MULT_TEAM || '25'),
      enterprise: parseFloat(process.env.LIMITER_MULT_ENTERPRISE || '50'),
      unlimited: parseFloat(process.env.LIMITER_MULT_UNLIMITED || '100'),
      // `satisfies` (not `as`): adding a QuotaTier without a multiplier here is a
      // compile error, matching the sibling `tierExpiresIn`'s VALID_TIERS derivation.
    } satisfies Record<QuotaTier, number>,
    auth: {
      max: envInt('AUTH_LIMITER_MAX', 20),
      windowMs: envInt('AUTH_LIMITER_WINDOWMS', 900000), // 15 min
    },
    // Observability endpoints (catalog query, range query, log query) hit
    // Prometheus / Loki directly. A noisy operator clicking through panels
    // can saturate upstream — keep a tighter per-org budget than the
    // general limiter. A single dashboard view fans out to one query per
    // panel (Queue Health = 9, Registry Activity = 6, …) and the client may
    // refetch on mount, so the budget must cover a couple of full page
    // loads in a window or legitimate views 429. 120 req / min default.
    observability: {
      max: envInt('OBSERVABILITY_LIMITER_MAX', 120),
      windowMs: envInt('OBSERVABILITY_LIMITER_WINDOWMS', 60000), // 1 min
    },
    /**
     * Dedicated bucket for the Alertmanager relay webhook.
     *
     * This endpoint is machine-to-machine and unauthenticated at middleware
     * time (it authenticates itself inside the handler with a per-instance
     * bearer + `X-Alertmanager-Instance` allowlist), so it used to fall into
     * the ANONYMOUS bucket of the general limiter — 100 requests per 15
     * minutes, fleet-wide, shared with every other unauthenticated caller. A
     * multi-group alert storm exhausted that and got 429s, which Alertmanager
     * treats as a failed notification: alerts were silently delayed to the
     * next `group_interval`.
     *
     * Sized for a fleet of Alertmanagers fanning out many groups at once,
     * which is exactly when throttling is most harmful.
     */
    alertWebhook: {
      max: envInt('ALERT_WEBHOOK_LIMITER_MAX', 3000),
      windowMs: envInt('ALERT_WEBHOOK_LIMITER_WINDOWMS', 60000), // 1 min
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
    passwordMinLength: envInt('PASSWORD_MIN_LENGTH', 8),
    /**
     * bcrypt cost factor for password hashing. Lives under `auth`, not
     * `auth.jwt` — it has nothing to do with JWT signing; the previous
     * placement was a copy-paste artifact.
     */
    passwordSaltRounds: envInt('BCRYPT_SALT_ROUNDS', 12),
    jwt: {
      /**
       * ES256 user-token signing (roadmap #5). `mode: 'kms'` keeps the private
       * key inside AWS KMS (asymmetric `ECC_NIST_P256`, sign-only); `mode:
       * 'local'` reads a PEM from disk — a bind mount under compose, a mounted
       * Kubernetes Secret on minikube. Rotation is by `kid`: the *_PREVIOUS
       * key is PUBLISHED in the JWKS but never signs, so tokens it minted keep
       * verifying for one overlap window.
       *
       * Prefer a KMS ALIAS over an ARN — an alias carries no AWS account id.
       */
      signing: {
        mode: (process.env.TOKEN_SIGNING_MODE || 'local') === 'kms' ? 'kms' as const : 'local' as const,
        keyFile: process.env.TOKEN_SIGNING_KEY_FILE || undefined,
        previousKeyFile: process.env.TOKEN_SIGNING_KEY_PREVIOUS_FILE || undefined,
        kmsKeyId: process.env.TOKEN_SIGNING_KMS_KEY_ID || undefined,
        kmsPreviousKeyId: process.env.TOKEN_SIGNING_KMS_KEY_PREVIOUS_ID || undefined,
      },
      // Short access-token TTL (15 min). The frontend silently refreshes off the
      // token's expiry (see frontend/src/lib/api/core.ts), so a short lifetime is
      // transparent to users. It also bounds the WORST-CASE revocation window: on
      // a privilege change we publish the user's new tokenVersion to Redis so the
      // stateless services reject stale tokens immediately, but if that publish
      // (or Redis) is unavailable, a stale token can only outlive the change by at
      // most this TTL before natural expiry forces a refresh.
      expiresIn: envInt('JWT_EXPIRES_IN', 900), // 15 min
      /** Pinned on every token platform signs and checked on every token it verifies,
       *  when set. Must match what api-core's requireAuth expects. */
      issuer: process.env.JWT_ISSUER || undefined,
      audience: process.env.JWT_AUDIENCE || undefined,
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
          const name = `JWT_EXPIRES_IN_${tier.toUpperCase()}`;
          // Sentinel-free "unset stays unset": envInt cannot express undefined,
          // so probe first, then parse through the shared reader. A SET value is
          // returned as-is (an explicit 0 stays 0) — only "absent" is undefined.
          return [tier, process.env[name]?.trim() ? envInt(name, 0) : undefined];
        }),
      ) as Record<QuotaTier, number | undefined>,
    },
    refreshToken: {
      // No secret of its own any more: a refresh token is a user token, so it is
      // signed with the SAME ES256 key (and rotated by the same `kid`) as every
      // other credential that speaks for a person. `REFRESH_TOKEN_SECRET` and
      // `REFRESH_TOKEN_SECRET_PREVIOUS` are gone.
      //
      // Also the Max-Age of the browser's refresh cookie, which reads this same
      // variable directly — see helpers/session-cookie.ts.
      expiresIn: envInt('REFRESH_TOKEN_EXPIRES_IN', 2592000), // 30 days
    },
    /**
     * Email-verification token lifetime (ms). 24 h default; tokens are
     * single-use and tied to the user record so a short TTL is mostly a
     * UX trade-off (users following a stale link have to re-request).
     * Previously read inline in services/auth-service.ts.
     */
    verificationTokenTtlMs: envInt('AUTH_VERIFICATION_TOKEN_TTL_MS', 86400000),
    /**
     * TTL (seconds) for a published session-revocation entry (Redis key
     * `authrev:tv:<userId>`). This is a CEILING/floor: the effective TTL used at
     * publish time is `max(this, jwt.expiresIn, …jwt.tierExpiresIn)` — see
     * helpers/session-revocation.ts — so a revocation entry NEVER lapses while an
     * access token minted before it could still be alive (which would let a
     * revoked token slip through the services' fail-open read). Defaults to a
     * safe 1-hour ceiling well above the 15-min base access-token lifetime.
     */
    sessionRevocationTtlSeconds: envInt('SESSION_REVOCATION_TTL_SECONDS', 3600),
    /**
     * OAuth 2.0 device authorization grant (RFC 8628) — how `pipeline-manager
     * auth login` signs in without ever holding a password.
     *
     * The defaults are the RFC's own guidance: a 10-minute code lifetime (long
     * enough to walk to a browser, short enough that an unclaimed code is
     * worthless) and a 5-second minimum poll interval. `maxPolls` is a
     * runaway/abuse ceiling on ONE device code — a well-behaved client at the
     * advertised interval spends ~120 polls over the full TTL.
     */
    device: {
      ttlMs: envInt('DEVICE_CODE_TTL_MS', 600_000), // 10 min
      intervalSeconds: envInt('DEVICE_CODE_INTERVAL_SECONDS', 5),
      maxPolls: envInt('DEVICE_CODE_MAX_POLLS', 200),
      /** Cap on the in-memory pending-state fallback (Redis-less deployments). */
      maxPending: envInt('DEVICE_MAX_PENDING', 1000),
      /** How long an approval's step-up proof stays good for the session the
       *  CLI collects on its next poll (one poll interval plus slack). */
      approvalGraceMs: envInt('DEVICE_APPROVAL_GRACE_MS', 300_000), // 5 min
    },

    /**
     * Passkeys (WebAuthn). The relying-party identity comes from
     * `PLATFORM_FRONTEND_URL` — never from the request — and is validated at
     * boot by `assertWebAuthnConfig` (see config/webauthn-validate.ts).
     *
     * A registered passkey is bound to `rpID` permanently: changing it orphans
     * every credential, so the overrides exist for deployments whose frontend
     * URL is not the origin users actually browse to (a CDN alias, a split
     * app/api hostname), not as a routine knob.
     *
     * The challenge TTL is the window between "/…/options" and "/…/verify" —
     * long enough to pick a finger/PIN, short enough that a captured challenge
     * is worthless. Ceremony state lives in the shared Redis pending-state store
     * and is consumed once.
     */
    webauthn: {
      ...resolveWebAuthnConfig(process.env, process.env.PLATFORM_FRONTEND_URL || DEFAULT_PLATFORM_URL),
      challengeTtlMs: envInt('WEBAUTHN_CHALLENGE_TTL_MS', 120_000), // 2 min
      /** Cap on the in-memory challenge fallback (Redis-less deployments). */
      maxPendingCeremonies: envInt('WEBAUTHN_MAX_PENDING_CEREMONIES', 1000),
      /**
       * FIDO Metadata Service (MDS3) — only consulted when an org sets an
       * authenticator (AAGUID) allowlist. Registration into such an org requests
       * DIRECT attestation and verifies it against MDS; without a loaded MDS
       * blob that registration is REFUSED (the policy asked for provenance we
       * could not check).
       *
       * Source order: `FIDO_MDS_BLOB_PATH` (a downloaded blob JWT on disk — the
       * air-gapped path) wins; otherwise the blob is fetched from `FIDO_MDS_URL`
       * (default the FIDO Alliance's MDS3 endpoint — platform already calls the
       * public internet for OAuth / OIDC / breach checks). `FIDO_MDS_URL=off`
       * disables fetching. Either way the blob's signature chain is verified
       * against the FIDO root before a single statement is trusted, and it is
       * cached in memory for `FIDO_MDS_REFRESH_MS`.
       */
      mds: {
        blobPath: process.env.FIDO_MDS_BLOB_PATH || undefined,
        url: (() => {
          const raw = (process.env.FIDO_MDS_URL ?? '').trim();
          if (raw.toLowerCase() === 'off') return undefined;
          return raw || 'https://mds.fidoalliance.org/';
        })(),
        fetchTimeoutMs: envInt('FIDO_MDS_FETCH_TIMEOUT_MS', 10_000),
        refreshMs: envInt('FIDO_MDS_REFRESH_MS', 86_400_000), // 24 h
      },
    },

    /**
     * Breached-password check (HIBP "Pwned Passwords" k-anonymity range API).
     * Only the first 5 hex chars of the password's SHA-1 leave the process; the
     * response is ~800 suffixes the comparison happens against locally (and is
     * padded, so its size says nothing either).
     *
     * `PASSWORD_BREACH_CHECK=hibp` (default) checks at registration, password
     * change and admin reset; `off` disables it (air-gapped installs).
     *
     * FAIL-OPEN, deliberately: an unreachable/slow range API lets the password
     * through (metered as `outcome="unavailable"`, alertable) rather than making
     * registration and password changes depend on a third party's uptime. The
     * check is defence-in-depth on top of the length/complexity rules and the
     * login throttle, not the only line — while a password reset that fails
     * during an HIBP outage would strand a locked-out person entirely.
     */
    passwordBreachCheck: {
      mode: (process.env.PASSWORD_BREACH_CHECK || 'hibp').trim().toLowerCase() === 'off' ? 'off' as const : 'hibp' as const,
      rangeUrl: process.env.PASSWORD_BREACH_CHECK_URL || 'https://api.pwnedpasswords.com/range/',
      timeoutMs: envInt('PASSWORD_BREACH_CHECK_TIMEOUT_MS', 2_000),
    },

    /**
     * Password sign-in throttling. `/auth/*` is already behind the per-IP auth
     * limiter (`AUTH_LIMITER_*`); this adds a PER-ACCOUNT bucket on
     * `/auth/login`, keyed by a hash of the normalized identifier, that counts
     * only FAILED attempts — so a credential-stuffing run spread across many IPs
     * still stalls on the account, while the owner's successful sign-ins never
     * consume it.
     */
    loginThrottle: {
      perAccountMax: envInt('LOGIN_ACCOUNT_LIMITER_MAX', 10),
      perAccountWindowMs: envInt('LOGIN_ACCOUNT_LIMITER_WINDOWMS', 900_000), // 15 min
    },

    /**
     * Authenticator-app codes (TOTP, RFC 6238). The algorithm parameters are NOT
     * configurable — SHA-1 / 6 digits / 30 s is the only combination every
     * authenticator reads reliably (see utils/totp.ts); a knob here would only
     * let an operator produce enrolments that scan and then never verify.
     *
     * What IS tunable is the abuse envelope. A 6-digit code is ~20 bits, so the
     * lockout — not the code — is what makes online guessing hopeless: after
     * `maxFailures` consecutive wrong codes the account's TOTP verification is
     * refused for `lockoutMs` whatever the next code is, on the sign-in path and
     * the step-up path alike.
     */
    totp: {
      /** Shown by the authenticator above the code, and baked into the enrolment
       *  QR. A deployment-identifying label, not a secret. */
      issuer: process.env.TOTP_ISSUER || 'Pipeline Builder',
      /** Consecutive failures before the account's TOTP is locked out. */
      maxFailures: envInt('TOTP_MAX_FAILURES', 5),
      /** How long that lockout lasts. */
      lockoutMs: envInt('TOTP_LOCKOUT_MS', 900_000), // 15 min
      /**
       * Lifetime of the sign-in MFA challenge — the handle a password sign-in
       * returns INSTEAD of a session when the account has TOTP. Long enough to
       * unlock a phone and read a code, short enough that a captured handle is
       * worthless. Held in the shared Redis pending-state store.
       */
      challengeTtlMs: envInt('TOTP_LOGIN_CHALLENGE_TTL_MS', 300_000), // 5 min
      /** Cap on the in-memory challenge fallback (Redis-less deployments). */
      maxPendingChallenges: envInt('TOTP_MAX_PENDING_CHALLENGES', 1000),
    },
  },

  mongodb: {
    // MONGODB_URI must be set via environment; no credentials in source code.
    // Example: mongodb://mongo:<password>@mongodb:27017/platform?replicaSet=rs0&authSource=admin
    uri: (() => {
      const uri = process.env.MONGODB_URI;
      if (!uri) throw new Error('MONGODB_URI environment variable is required');
      return uri;
    })(),
    // Pool sizing: bound the connection ceiling so multiple replicas don't
    // exhaust Mongo's default cap.
    maxPoolSize: envInt('MONGO_MAX_POOL', 20),
    minPoolSize: envInt('MONGO_MIN_POOL', 2),
    serverSelectionTimeoutMs: envInt('MONGO_SERVER_SELECTION_MS', 5000),
  },

  email: {
    enabled: process.env.EMAIL_ENABLED === 'true',
    from: process.env.EMAIL_FROM || 'noreply@example.com',
    fromName: process.env.EMAIL_FROM_NAME || 'Platform',
    provider: (process.env.EMAIL_PROVIDER || 'smtp') as 'smtp' | 'ses',
    smtp: {
      host: process.env.SMTP_HOST || 'localhost',
      port: envInt('SMTP_PORT', 587),
      secure: process.env.SMTP_SECURE === 'true',
      user: process.env.SMTP_USER || '',
      pass: process.env.SMTP_PASS || '',
    },
    ses: {
      region: process.env.SES_REGION || process.env.AWS_REGION || 'us-east-1',
      accessKeyId: process.env.SES_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.SES_SECRET_ACCESS_KEY || '',
      /**
       * SES configuration set applied to every send. The AWS deploy provisions
       * it (`--email`) wired to an SNS topic that tracks bounces/complaints —
       * SES enforces reputation at the account level, so this is how operators
       * see and alert on it. Empty => no config set (sends still work).
       */
      configurationSet: process.env.SES_CONFIGURATION_SET || '',
    },
  },

  invitation: {
    expirationDays: envInt('INVITATION_EXPIRATION_DAYS', 7),
    maxPendingPerOrg: envInt('INVITATION_MAX_PENDING_PER_ORG', 50),
    // How often the reaper flips stale `pending` invites (past `expiresAt`) to
    // `expired`. The capacity/roster queries already exclude stale rows at read
    // time, so this sweep is durability/hygiene — default hourly.
    sweepIntervalMs: envInt('INVITATION_SWEEP_INTERVAL_MS', 3600000),
  },

  organization: {
    // Org SOFT-DELETE retention window. `DELETE /organization/:id` no longer
    // hard-deletes: it soft-deletes (sets `deletedAt`/`purgeAfter`), snapshots
    // the org durably, and cuts access at the token chokepoint. The purge sweep
    // then runs the destructive cascade for any org whose `purgeAfter` has
    // lapsed. Default 7-day grace so an accidental delete can be restored.
    //
    // FLOOR: the effective deadline is `max(this, SOFT_DELETE_RETENTION_DAYS)`
    // — see `orgPurgeRetentionMs` in services/org-cascade-service.ts. The org
    // must outlive the rows it owns, which the cascade tombstones under the
    // shared 30-day row window; purging the org first orphaned those rows for
    // the remainder. Raising this above the row window takes effect as written.
    deletionRetentionDays: envInt('ORG_DELETION_RETENTION_DAYS', 7),
    // How often the purge sweep scans for expired soft-deleted orgs and runs the
    // fail-closed cascade. Default hourly; the sweep is idempotent and never
    // throws (log + continue), so a transient failure retries next tick.
    purgeSweepIntervalMs: envInt('ORG_PURGE_SWEEP_INTERVAL_MS', 3600000),
    // Timeout for the purge cascade's HTTP DELETEs to quota/billing/message.
    cascadeHttpTimeoutMs: envInt('ORG_CASCADE_HTTP_TIMEOUT_MS', 5000),
    // Domain-based join: how often the re-verification sweep runs (0 disables it)
    // and how long since the last successful DNS check before a domain is re-checked.
    domainReverifyIntervalMs: envInt('DOMAIN_REVERIFY_INTERVAL_MS', 24 * 60 * 60 * 1000),
    domainReverifyStaleMs: envInt('DOMAIN_REVERIFY_STALE_MS', 7 * 24 * 60 * 60 * 1000),
  },

  oauth: {
    /** Base URL for OAuth callback redirects (e.g. https://yourdomain.com) */
    callbackBaseUrl: process.env.OAUTH_CALLBACK_BASE_URL || process.env.PLATFORM_FRONTEND_URL || DEFAULT_PLATFORM_URL,
    stateTtlMs: envInt('OAUTH_STATE_TTL_MS', 600000), // 10 min
    cleanupIntervalMs: envInt('OAUTH_CLEANUP_INTERVAL_MS', 60000), // 1 min
    /** Cap on the in-memory pending-state fallback shared by the social OAuth
     *  and SSO flows (used only when Redis is not configured). */
    maxPendingStates: envInt('OAUTH_MAX_PENDING_STATES', 1000),
    /** OIDC discovery/JWKS cache TTL. Kept short so IdP key rotation is picked
     *  up quickly; a `kid` miss also forces a live JWKS refetch regardless. */
    oidcDocCacheTtlMs: envInt('OIDC_DOC_CACHE_TTL_MS', 60 * 60 * 1000),
    /** Clock skew tolerated on a SAML assertion's NotBefore / NotOnOrAfter.
     *  Small on purpose — this is the allowance for ordinary NTP drift between
     *  the IdP and this deployment, not a way to accept stale assertions. */
    samlClockSkewMs: envInt('SAML_CLOCK_SKEW_MS', 60 * 1000),
    /** How long an unanswered SAML AuthnRequest id stays valid, i.e. how long a
     *  user has to finish signing in at their IdP. */
    samlRequestTtlMs: envInt('SAML_REQUEST_TTL_MS', 10 * 60 * 1000),
    /** Floor on how long a SPENT assertion id is remembered for replay refusal.
     *  The real window is the assertion's own NotOnOrAfter when that is longer. */
    samlAssertionReplayTtlMs: envInt('SAML_ASSERTION_REPLAY_TTL_MS', 10 * 60 * 1000),
    /** How long the one-time handoff minted by the ACS stays redeemable — the
     *  few seconds it takes the browser to follow one redirect. */
    samlHandoffTtlMs: envInt('SAML_HANDOFF_TTL_MS', 2 * 60 * 1000),
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
    facebook: {
      clientId: process.env.OAUTH_FACEBOOK_CLIENT_ID || '',
      clientSecret: process.env.OAUTH_FACEBOOK_CLIENT_SECRET || '',
      enabled: !!process.env.OAUTH_FACEBOOK_CLIENT_ID,
      // Facebook Login is OAuth2 (NOT standards-OIDC): authorize on facebook.com,
      // token + Graph userinfo on graph.facebook.com. The Graph version is pinned
      // and overridable so a Facebook API deprecation is a config change, not a deploy.
      authorizeUrl: process.env.FACEBOOK_AUTHORIZE_URL || 'https://www.facebook.com/v19.0/dialog/oauth',
      tokenUrl: process.env.FACEBOOK_TOKEN_URL || 'https://graph.facebook.com/v19.0/oauth/access_token',
      userinfoUrl: process.env.FACEBOOK_USERINFO_URL || 'https://graph.facebook.com/v19.0/me',
    },
    microsoft: {
      clientId: process.env.OAUTH_MICROSOFT_CLIENT_ID || '',
      clientSecret: process.env.OAUTH_MICROSOFT_CLIENT_SECRET || '',
      enabled: !!process.env.OAUTH_MICROSOFT_CLIENT_ID,
      // Entra/Azure AD v2 (OIDC). `tenant` scopes the authority: `common` (any
      // Microsoft account — default), `organizations`, `consumers`, or a specific
      // tenant id/domain. The authorize/token URLs interpolate the tenant at
      // provider-construction time; userinfo is the tenant-agnostic Graph endpoint.
      tenant: process.env.OAUTH_MICROSOFT_TENANT || 'common',
      authorizeUrl: process.env.MICROSOFT_AUTHORIZE_URL || 'https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize',
      tokenUrl: process.env.MICROSOFT_TOKEN_URL || 'https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token',
      userinfoUrl: process.env.MICROSOFT_USERINFO_URL || 'https://graph.microsoft.com/oidc/userinfo',
    },
    gitlab: {
      clientId: process.env.OAUTH_GITLAB_CLIENT_ID || '',
      clientSecret: process.env.OAUTH_GITLAB_CLIENT_SECRET || '',
      enabled: !!process.env.OAUTH_GITLAB_CLIENT_ID,
      // GitLab OIDC. `baseUrl` points at gitlab.com by default but can target a
      // self-hosted instance; the authorize/token/userinfo endpoints are derived
      // from it at provider-construction time (overridable individually if needed).
      baseUrl: process.env.OAUTH_GITLAB_BASE_URL || 'https://gitlab.com',
      authorizeUrl: process.env.GITLAB_AUTHORIZE_URL || '',
      tokenUrl: process.env.GITLAB_TOKEN_URL || '',
      userinfoUrl: process.env.GITLAB_USERINFO_URL || '',
    },
    linkedin: {
      clientId: process.env.OAUTH_LINKEDIN_CLIENT_ID || '',
      clientSecret: process.env.OAUTH_LINKEDIN_CLIENT_SECRET || '',
      enabled: !!process.env.OAUTH_LINKEDIN_CLIENT_ID,
      // "Sign in with LinkedIn using OpenID Connect" (OIDC).
      authorizeUrl: process.env.LINKEDIN_AUTHORIZE_URL || 'https://www.linkedin.com/oauth/v2/authorization',
      tokenUrl: process.env.LINKEDIN_TOKEN_URL || 'https://www.linkedin.com/oauth/v2/accessToken',
      userinfoUrl: process.env.LINKEDIN_USERINFO_URL || 'https://api.linkedin.com/v2/userinfo',
    },
  },

  observability: {
    /** How often each replica samples the org/user count gauges. Anything under
     *  30s isn't useful since Prometheus polls every 15s. */
    scraperIntervalMs: envInt('PLATFORM_SCRAPER_INTERVAL_MS', 60_000),
    /** Default timeout for any single Alertmanager call. */
    alertmanagerTimeoutMs: envInt('ALERTMANAGER_TIMEOUT_MS', 5000),
    /** Per-destination delivery timeout for the alert relay and test sends — a
     *  slow Slack tenant shouldn't hold up the relay (Alertmanager retries). */
    alertDeliveryTimeoutMs: envInt('ALERT_DELIVERY_TIMEOUT_MS', 5000),
    /** At-least-once dedupe window for alert email: an identical (alert,
     *  recipient) email inside it is suppressed. */
    alertEmailDedupeTtlMs: envInt('ALERT_EMAIL_DEDUPE_TTL_MS', 10 * 60 * 1000),
    /** Alert destination field caps. Slack hooks are ~85 chars, but enterprise
     *  webhooks with long signed query params can be much longer. */
    alertDestinationMaxLabel: envInt('ALERT_DESTINATION_MAX_LABEL', 100),
    alertDestinationMaxTarget: envInt('ALERT_DESTINATION_MAX_TARGET', 2048),
    /** Custom dashboard size caps (defend against pathological payloads). */
    dashboardMaxName: envInt('DASHBOARD_MAX_NAME', 150),
    dashboardMaxDescription: envInt('DASHBOARD_MAX_DESCRIPTION', 1000),
    dashboardMaxPanelTitle: envInt('DASHBOARD_MAX_PANEL_TITLE', 200),
    dashboardMaxPanels: envInt('DASHBOARD_MAX_PANELS', 50),
  },

  audit: {
    // How many days to retain audit events. Read by the AuditEvent TTL
    // index; was previously parsed inline in models/audit-event.ts.
    retentionDays: envInt('AUDIT_RETENTION_DAYS', 90),
    // Platform-local audit() writes that fail are spooled (Redis) and
    // re-appended on this interval instead of being dropped.
    spoolDrainIntervalMs: envInt('AUDIT_SPOOL_DRAIN_INTERVAL_MS', 30_000),
    // Periodic HMAC-signed chain-head export to WRITE-ONCE object storage
    // (S3/MinIO bucket with Object Lock). `/audit/verify` checks each chain
    // against its published head, which is what makes TAIL truncation (deleting
    // the newest rows + rewinding the in-DB head) detectable. Disabled when the
    // endpoint/bucket/credentials are unset.
    headExport: {
      endpoint: process.env.AUDIT_HEAD_EXPORT_S3_ENDPOINT || '',
      bucket: process.env.AUDIT_HEAD_EXPORT_S3_BUCKET || 'audit-heads',
      region: process.env.AUDIT_HEAD_EXPORT_S3_REGION || 'us-east-1',
      accessKeyId: process.env.AUDIT_HEAD_EXPORT_S3_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.AUDIT_HEAD_EXPORT_S3_SECRET_ACCESS_KEY || '',
      prefix: process.env.AUDIT_HEAD_EXPORT_PREFIX || 'audit-heads',
      lockMode: auditHeadLockMode(),
      // Object-lock retain-until = export time + this many days. Defaults well
      // past the event TTL so a head outlives the rows it vouches for.
      retentionDays: envInt('AUDIT_HEAD_EXPORT_RETENTION_DAYS', 400, { min: 1 }),
      intervalMs: envInt('AUDIT_HEAD_EXPORT_INTERVAL_MS', 300_000, { min: 10_000 }),
    },
  },

  quota: {
    // Quota microservice connection
    serviceHost: process.env.QUOTA_SERVICE_HOST || 'quota',
    servicePort: envInt('QUOTA_SERVICE_PORT', 3000),
    serviceTimeout: envInt('QUOTA_SERVICE_TIMEOUT', 5000), // 5s
    // Usage-counter period, shared with the quota service (same env var). A
    // service account's OWN token-exchange budget rolls over on this period, so
    // its quota window matches every other quota in the deployment. `envInt`
    // already falls back on a malformed value, so the old NaN re-guard is gone.
    resetDays: envInt('QUOTA_RESET_DAYS', 3),
    // Quota tier presets (each tier defines its own limits and reset periods).
    // Consumed by Organization model schema defaults.
    tier: {
      developer: {
        ...QUOTA_TIERS.developer.limits,
        resetPeriod: tierResetPeriod('developer', '3days'),
      },
      pro: {
        ...QUOTA_TIERS.pro.limits,
        resetPeriod: tierResetPeriod('pro', '3days'),
      },
      team: {
        ...QUOTA_TIERS.team.limits,
        resetPeriod: tierResetPeriod('team', '30days'),
      },
      enterprise: {
        ...QUOTA_TIERS.enterprise.limits,
        resetPeriod: tierResetPeriod('enterprise', '30days'),
      },
      // Billing-disabled default tier — everything uncapped. Reset period is moot
      // (all limits -1), but the key must exist so `config.quota.tier[tier]` stays
      // indexable by every QuotaTier.
      unlimited: {
        ...QUOTA_TIERS.unlimited.limits,
        resetPeriod: tierResetPeriod('unlimited', '30days'),
      },
    },
  },

  billing: {
    enabled: (process.env.BILLING_ENABLED || 'true').toLowerCase() !== 'false',
    serviceHost: process.env.BILLING_SERVICE_HOST || 'billing',
    servicePort: envInt('BILLING_SERVICE_PORT', 3000),
    serviceTimeout: envInt('BILLING_SERVICE_TIMEOUT', 5000), // 5s
    // Paid-signup provisioning: retry the billing subscription POST a couple of
    // times with short backoff before persisting the durable pending marker.
    provisionRetryAttempts: envInt('BILLING_PROVISION_RETRY_ATTEMPTS', 3),
    provisionRetryBaseMs: envInt('BILLING_PROVISION_RETRY_BASE_MS', 200),
    // Reconcile cadence for orgs whose signup billing bootstrap failed
    // (pendingBillingPlanId marker). 0 disables the periodic pass (boot drain still runs).
    reconcileIntervalMs: envInt('BILLING_RECONCILE_INTERVAL_MS', 300000), // 5 min
    // Max orgs a single reconcile pass processes (oldest-marked first). Bounds
    // pass duration so it can't overlap the next interval; leftovers roll to the
    // following pass. The interval itself IS the retry loop.
    reconcileBatchSize: envInt('BILLING_RECONCILE_BATCH_SIZE', 50),
    // Max random per-org jitter (ms) inside a reconcile pass, so a fleet-wide
    // billing outage doesn't produce a synchronized retry thundering-herd.
    reconcileJitterMs: envInt('BILLING_RECONCILE_JITTER_MS', 250),
  },

  compliance: {
    enabled: (process.env.COMPLIANCE_ENABLED || 'true').toLowerCase() !== 'false',
    serviceHost: process.env.COMPLIANCE_SERVICE_HOST || 'compliance',
    servicePort: envInt('COMPLIANCE_SERVICE_PORT', 3000),
    serviceTimeout: envInt('COMPLIANCE_SERVICE_TIMEOUT', 5000), // 5s
  },

  // Message service — used for service-to-service in-app notifications (P2b
  // domain-join). Disabled → in-app notifications are silently skipped (email
  // still sent). Mirrors the other downstream-service blocks.
  message: {
    enabled: (process.env.MESSAGE_ENABLED || 'true').toLowerCase() !== 'false',
    serviceHost: process.env.MESSAGE_SERVICE_HOST || 'message',
    servicePort: envInt('MESSAGE_SERVICE_PORT', 3000),
    serviceTimeout: envInt('MESSAGE_SERVICE_TIMEOUT', 5000), // 5s
  },
} as const;

// Boot-time relying-party validation (see config/webauthn-validate.ts). Done
// HERE, at module load, for the same reason as `requireEncryptionKey()` above: a
// bad RP ID must stop the process, not surface as an unexplained SecurityError
// in the first person's passkey ceremony — and, worse, orphan any credential
// registered under a value that later has to be corrected.
assertWebAuthnConfig(config.auth.webauthn);

export type Config = typeof config;
