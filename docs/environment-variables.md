---
layout: default
title: Environment Variables
---

# Environment Variables

Complete reference for all environment variables used across Pipeline Builder services. Each variable can be set in your `.env` file or passed directly via your deployment configuration (Docker Compose, Kubernetes ConfigMap, ECS task definition).

**Quick setup:** Each deploy target ships its own template (`deploy/local/docker/.env.example`, `deploy/local/minikube/.env.example`, `deploy/aws/ec2/.env.example`, `deploy/aws/eks/.env.example`). Copy the one for your target to `.env` and fill in the required secrets.

> **Security:** Generate JWT secrets with `openssl rand -base64 32`. Never commit `.env` files to version control.

**Related docs:** [AWS Deployment](aws-deployment.md) | [API Reference](api-reference.md)

---

## Overview

This reference documents every environment variable across the Pipeline Builder services, grouped by concern (core, authentication, databases, plugin builds, quotas, compliance, email, billing, AWS/Lambda, timeouts, caching, and more) with each variable's default and effect. It's for anyone deploying or operating the platform; pair it with the per-target `.env.example` templates noted above and set only what your target needs. Defaults mirror the code, and feature switches are called out where they interact — for example the billing master switch `BILLING_DISCOUNTS_ENABLED` and the per-tier `QUOTA_TIER_*` / `JWT_EXPIRES_IN_*` overrides. Use the [Table of Contents](#table-of-contents) below to jump to a section.

---

## Table of Contents

- [Core](#core) -- Server basics (port, logging, URLs)
- [Authentication](#authentication) -- JWT, OAuth, passkeys, password policy
- [Databases](#databases) -- PostgreSQL, MongoDB, Redis
- [Docker Registry](#docker-registry) -- Image registry for plugin builds
- [Plugin Builds](#plugin-builds) -- buildkit sidecar, queue config
- [Quotas & Rate Limiting](#quotas--rate-limiting) -- Per-org resource limits
- [Plugin Ecosystem](#plugin-ecosystem) -- Public directory, publishing, reviews, submissions (flags)
- [Service Discovery](#service-discovery) -- Inter-service hostnames and ports
- [Compliance](#compliance) -- Compliance bypass and scan scheduling
- [Email](#email) -- SMTP and SES configuration
- [Billing](#billing) -- Subscription billing provider
- [Reporting & DORA](#reporting--dora) -- Event reporting, DORA metrics, retention
- [AWS CDK / Lambda](#aws-cdk--lambda) -- Lambda runtime, CodeBuild compute
- [Timeouts](#timeouts) -- Request, build, and connection timeouts
- [Caching](#caching) -- Response and entity cache TTLs
- [SSE](#server-sent-events) -- Server-sent events configuration
- [Admin UIs](#admin-uis-infrastructure) -- pgAdmin, Mongo Express credentials
- [Pagination & Limits](#pagination--limits) -- API response limits
- [AI Providers](#ai-providers-optional) -- API keys for AI-powered generation

---

## Core

| Variable | Default | Description |
|----------|---------|-------------|
| `PLATFORM_BASE_URL` | `https://localhost:8443` | API gateway URL |
| `PLATFORM_FRONTEND_URL` | `https://localhost:8443` | Frontend URL (email links, OAuth redirects) |
| `DEPLOY_TARGET` | `local` | Deployment target (`aws-ec2`, `aws-eks`, `local`, `docker`, `minikube`). Served by the platform `/config` endpoint at runtime (the frontend is one shared prebuilt image, so this is NOT a `NEXT_PUBLIC_*` build-time inline); the onboarding CLI-setup step shows the AWS-only `store-token`/`setup-events` section only on the AWS targets |
| `PORT` | `3000` | Service listen port |
| `TRUST_PROXY` | `1` | Reverse-proxy hops Express trusts for `req.ip`. `1` on every target: nginx is the only hop a service sees, and it OVERWRITES `X-Forwarded-For` with the client address (on AWS that address comes from nginx `real_ip`, which trusts `X-Forwarded-For` only from the load balancer CIDRs the setup script derives — `PB_TRUSTED_PROXY_CIDRS`). |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info`, `debug` |
| `LOG_FORMAT` | `json` | `json` (structured) or `text` (human-readable) |
| `SERVICE_NAME` | `api` | Service name in logs |
| `CORS_CREDENTIALS` | `true` | Allow credentials in CORS requests |
| `CORS_ORIGIN` | — | CORS allowed origins (optional) |
| `SYSTEM_ORG_ID` | `000000000000000000000001` | ObjectId of the well-known system tenant (the org with `slug:'system'` + `isSystem:true`). Lowercased at module load and compared case-insensitively. **If you override it, you must mirror the new value in the Postgres RLS policy** (`deploy/**/postgres-init.sql` hardcodes `000000000000000000000001` as the always-visible system org), or system-org content becomes invisible to other orgs. |

---

## Authentication

| Variable | Default | Description |
|----------|---------|-------------|
| `SERVICE_SIGNING_KEY_FILE` | — | **Required.** Path to THIS service's EC P-256 private key (PKCS#8 PEM) for INTERNAL service-to-service tokens. **Different on every service** — mounted read-only into that service alone, which is what stops a compromised workload signing as another. Generated by `deploy/bin/service-signing-keys.sh`; a service refuses to start without it. |
| `SERVICE_KEY_BUNDLE_FILE` | — | **Required.** Path to the PUBLIC per-service key bundle (`{"services": {"<name>": {"keys": [<jwk>…]}}}`), used to verify peers' tokens. **Identical on every service** and public — it holds no private material. A token's `kid` selects the key AND names its owner, and the token's `sub` must agree, so one service can never speak for another. Re-read on change (mtime) and at least every 5 minutes, so a key rotation needs no restart. |
| `SERVICE_TOKEN_DENYLIST` | — | Comma-separated service names (the `<name>` in `sub: service:<name>`) whose internal tokens every service rejects. Read at process start: cuts off a compromised service without rotating any key or invalidating other services' tokens |
| `JWT_EXPIRES_IN` | `900` | Access-token TTL in seconds (15 min) at the platform auth issuer — deliberately short so privilege changes take effect quickly (paired with `tokenVersion` revocation). Per-tier overrides take precedence. (The generic pipeline-core server scaffold falls back to `7200` where it isn't the token issuer.) |
| `JWT_EXPIRES_IN_DEVELOPER` | (inherits `JWT_EXPIRES_IN`) | Developer-tier access-token TTL override |
| `JWT_EXPIRES_IN_PRO` | (inherits `JWT_EXPIRES_IN`) | Pro-tier override — commonly shorter for compliance |
| `JWT_EXPIRES_IN_TEAM` | (inherits `JWT_EXPIRES_IN`) | Team-tier override |
| `JWT_EXPIRES_IN_ENTERPRISE` | (inherits `JWT_EXPIRES_IN`) | Enterprise-tier override (e.g. `1800` = 30 min) |
| `JWT_EXPIRES_IN_UNLIMITED` | (inherits `JWT_EXPIRES_IN`) | Unlimited-tier override (billing-disabled default tier) |
| `JWT_ISSUER` | — | When set, platform stamps it on every token it signs and every service rejects tokens without it. Applies to both chains. Set on all services at once. |
| `JWT_AUDIENCE` | — | Same as `JWT_ISSUER`, for the `aud` claim. |
| `BCRYPT_SALT_ROUNDS` | `12` | bcrypt cost factor for password hashing (10-12 recommended). |
| `REFRESH_TOKEN_EXPIRES_IN` | `2592000` | Refresh token TTL (30d). Also the `Max-Age` of the browser's `pb_refresh` cookie. |
| `AUTH_REFRESH_COOKIE_PATH` | `/api/auth/refresh` | Path the browser's refresh cookie is scoped to, as the **browser** sees it (nginx strips `/api` before proxying, so this is the public path). Change only when the UI is served under a different public prefix. |
| `AUTH_COOKIE_SECURE` | `true` | `Secure` on the refresh cookie. Every shipped target terminates TLS in front of the gateway and browsers accept `Secure` on `http://localhost`, so leave this on. Set `false` **only** for a plain-http deployment on a non-localhost hostname, where the browser would otherwise drop the cookie and no session could refresh. |
| `PASSWORD_MIN_LENGTH` | `8` | Platform minimum password length — the floor every org's own minimum sits on (an org can raise it for its members, up to 128; see [Org password policy](authentication.md#org-password-policy)) |
| `PASSWORD_BREACH_CHECK` | `hibp` | Breached-password check at registration, password change and admin reset. `hibp` queries the Have I Been Pwned "Pwned Passwords" range API with only the first 5 hex characters of the password's SHA-1 (k-anonymity, padded responses); `off` disables it (air-gapped installs). **Fail-open**: a timeout or error lets the password through and is metered as `platform_password_breach_checks_total{outcome="unavailable"}` |
| `PASSWORD_BREACH_CHECK_URL` | `https://api.pwnedpasswords.com/range/` | Range API base (the 5-char prefix is appended). Point at an internal mirror to keep the check without public egress |
| `PASSWORD_BREACH_CHECK_TIMEOUT_MS` | `2000` | Per-check timeout; past it the check fails open |
| `LOGIN_ACCOUNT_LIMITER_MAX` | `10` | Per-**account** failed password sign-ins allowed per window on `POST /auth/login` (keyed on a SHA-256 of the normalized identifier; successful sign-ins are not counted). The per-IP limit is `AUTH_LIMITER_*` |
| `LOGIN_ACCOUNT_LIMITER_WINDOWMS` | `900000` | Per-account sign-in throttle window (15 min) |
| `BOOTSTRAP_SUPERADMIN_EMAILS` | — | Comma-separated user emails auto-promoted to `isSuperAdmin=true` at platform boot. **Required for fresh installs** — the first sysadmin can only be granted through this env or a direct DB update. Idempotent. Also names who the **bootstrap-admin MFA exception** applies to (#8): until one of these accounts enrols a passkey or an authenticator app, its password sign-in yields a limited session that can reach only enrolment, sign-out and the setup routes, and SSO enforcement never applies to it. Read live, so changing it needs no redeploy. See [Assurance levels and required MFA](authentication.md#assurance-levels-and-required-mfa). |
| `BOOTSTRAP_SETUP_WINDOW_MS` | `86400000` | How long (ms, measured from the system org's creation — the install time) a password-only bootstrap-admin session may still mint the `setup` service account and its key through the MFA exception. Past it those two routes demand a real second factor; enrolment, sign-out and refresh stay open forever, so a late admin is never locked out. Raise it only for an install that legitimately takes longer than a day to finish; unset / non-positive = the 24h default |
| `MFA_RECOVER_OPERATOR` | — | Default `--operator` for the `scripts/mfa-recover.js` factor-reset command — who is running it, recorded as the audit actor. Only read by that command; the flag wins when both are given, and the command refuses to run with neither (an audit row for a factor reset is worth little without a name). |

### User-token signing (ES256) — platform only

Every token that speaks for a person — access, refresh, step-up and the
short-lived token an opaque access key is exchanged for — is signed by **platform
alone** with an EC P-256 key and a `kid`, and verified by everyone else against
the public keys platform publishes at `/.well-known/jwks.json`. No other service
holds a key that can mint one.

| Variable | Default | Description |
|----------|---------|-------------|
| `TOKEN_SIGNING_MODE` | `local` | `local` reads a PEM from disk; `kms` keeps the private key inside AWS KMS (asymmetric `ECC_NIST_P256`, `SIGN_VERIFY`). Platform only. |
| `TOKEN_SIGNING_KEY_FILE` | — | **Required in `local` mode.** Path to the EC P-256 private key (PKCS#8 PEM), generated by `deploy/bin/token-signing-keys.sh` and mounted from the `token-signing-key` Kubernetes Secret. Platform refuses to start if it cannot be read. |
| `TOKEN_SIGNING_KEY_PREVIOUS_FILE` | — | Rotation: the RETIRING key. It is PUBLISHED in the JWKS (so tokens it signed keep verifying) but never signs anything new. Clear it once every token signed with the old `kid` has expired — including refresh tokens, which live `REFRESH_TOKEN_EXPIRES_IN`. |
| `TOKEN_SIGNING_KMS_KEY_ID` | — | **Required in `kms` mode.** The KMS key, **by alias** (`alias/pipeline-builder-token-signing`) — an ARN embeds the AWS account id and must not be used. Platform needs `kms:Sign` + `kms:GetPublicKey`. |
| `TOKEN_SIGNING_KMS_KEY_PREVIOUS_ID` | — | Rotation counterpart of `TOKEN_SIGNING_KEY_PREVIOUS_FILE`, in `kms` mode. |
| `PLATFORM_JWKS_URL` | derived | Absolute URL of the key set, for verifiers OUTSIDE the cluster (the pipeline-manager CLI, the pipeline-events Lambda). In-cluster services derive it from `PLATFORM_SERVICE_HOST`/`PLATFORM_SERVICE_PORT`; the CLI and the Lambda derive it from `PLATFORM_BASE_URL`. |
| `JWKS_FETCH_TIMEOUT_MS` | `3000` | Timeout on one JWKS fetch. Verifiers keep serving a key set they already hold if a refresh fails, and FAIL CLOSED (503) if they never obtained one. |

### Multi-team secret encryption

AI provider keys and IdP client secrets are encrypted at rest. `SECRET_ENCRYPTION_KEY` is **required at platform boot** — the read paths do not fall back to clear text; a non-encrypted value throws on read. Rotating an org's KMS config re-encrypts that org's secrets under the new key (see the org KMS-config admin endpoint).

| Variable | Default | Description |
|----------|---------|-------------|
| `SECRET_ENCRYPTION_KEY` | — | **Required.** 32-byte master key (hex or base64). Generate with `head -c 32 /dev/urandom \| base64`. Platform aborts startup when this is unset in production. |
| `SECRET_ENCRYPTION_KEY_PREVIOUS` | — | Rotation: **decrypt-only** fallback for rows still wrapped under the outgoing master key (never used to encrypt, and never applied to a per-org-KMS blob). Clear it after `node scripts/reencrypt-secrets.js` reports 0 failures inside a platform container — see [Secret Rotation](runbooks/secret-rotation.md). |
| `SECRET_ENCRYPTION_PER_ORG_KMS` | `false` | When `true`, each org's secrets are wrapped under its own KMS CMK (see `Organization.kmsConfig`). Orgs without an entry fall through to the shared master. Recommended for SOC2 / compliance deploys. |
| `SECRET_ENCRYPTION_KMS_KEY_ID` | — | (Single-master KMS mode) KMS CMK alias / ARN used to wrap the shared master. |
| `SECRET_ENCRYPTION_KMS_CIPHERTEXT` | — | (Single-master KMS mode) Base64 KMS-wrapped 32-byte master. |

### Audit tamper evidence

| Variable | Default | Description |
|----------|---------|-------------|
| `AUDIT_CHAIN_HMAC_KEY` | — | **Required in production** (platform refuses to boot without it; ≥ 32 chars). HMAC-SHA256 key of the audit hash chain. Lives outside the database on purpose — someone with Mongo write access but not this key cannot rebuild a consistent chain after editing or deleting events. Generated by `deploy/bin/gen-env-secrets.sh` (secret; k8s: `app-secrets`). |
| `AUDIT_HEAD_EXPORT_S3_ENDPOINT` | — | S3 endpoint for the signed chain-head export. `http://rustfs:9000` on every target; unset = export off (`/audit/verify` then cannot detect tail truncation). |
| `AUDIT_HEAD_EXPORT_S3_BUCKET` | `audit-heads` | Bucket — created **with Object Lock** by the `rustfs-init` bootstrap Job on every target, verified live at bootstrap by a WORM smoke test. |
| `AUDIT_HEAD_EXPORT_S3_REGION` | `us-east-1` | Region used for request signing. |
| `AUDIT_HEAD_EXPORT_S3_ACCESS_KEY_ID` | — | Bucket-scoped user (`audit-heads-svc`): Put (with lock headers) / Get / List on `audit-heads` only — no delete, the same fine-grained IAM policy MinIO's `mc admin policy` used (RustFS's `rc` is `mc` renamed almost verbatim, same JSON policy syntax). |
| `AUDIT_HEAD_EXPORT_S3_SECRET_ACCESS_KEY` | — | Its secret; generated by `gen-env-secrets.sh`. |
| `AUDIT_HEAD_EXPORT_PREFIX` | `audit-heads` | Key prefix inside the bucket. |
| `AUDIT_HEAD_EXPORT_LOCK_MODE` | `COMPLIANCE` | `COMPLIANCE`, `GOVERNANCE` or `none` (only for storage without Object Lock). |
| `AUDIT_HEAD_EXPORT_RETENTION_DAYS` | `400` | Retention stamped on each exported head. |
| `AUDIT_HEAD_EXPORT_INTERVAL_MS` | `300000` | Export period (min 10000). |
| `AUDIT_SPOOL_DRAIN_INTERVAL_MS` | `30000` | How often platform drains the durable Redis audit spool into Mongo. |

### Multi-team RLS context

| Variable | Default | Description |
|----------|---------|-------------|
| `RLS_CONTEXT_MODE` | `warn` | Behavior when `withTenantTx` is called outside any tenant scope. `warn` logs a stack-traced warning, `strict` throws, `silent` is no-op (tests / migration only). Recommended production rollout: `warn` for ≥7 days, then flip to `strict` after the logs show zero spurious warnings. |

### Multi-team alert webhook relay

| Variable | Default | Description |
|----------|---------|-------------|
| `ALERT_WEBHOOK_INSTANCES` | — | JSON array of `{ id, token, previousToken?, allowedOrgIds? }` entries. `previousToken` is the rotation overlap: while non-empty, either bearer is accepted. **Required** to enable the relay; unset / empty returns 503 at the webhook endpoint. Each Alertmanager sends `X-Alertmanager-Instance: <id>` + `Authorization: Bearer <token>`. `allowedOrgIds` restricts which orgs that instance can relay alerts for. |
| `ALERT_WEBHOOK_INSTANCE_TOKEN` | — | Deploy input: the bundled Alertmanager's relay token. Setup generates it, builds platform's `ALERT_WEBHOOK_INSTANCES` entry (id `alertmanager`) from it, and mounts it for Alertmanager. |
| `ALERT_WEBHOOK_INSTANCE_TOKEN_PREVIOUS` | — | Deploy input: rotation overlap for the above. Rendered into the instance entry's `previousToken`, so platform accepts the outgoing bearer until Alertmanager has restarted with the new one. |

### Ops-team Slack alert delivery

Deploy inputs only — **platform never reads these**. They are the destinations for
PLATFORM-WIDE alerts (`severity=critical` / `warning`), which is a different path
from the per-org relay above: the relay fans out to each tenant's own configured
destinations, these two are the operator's channels.

Alertmanager does not expand environment variables in its config, so the deploy
writes each URL into the `alertmanager-slack` Secret (k8s) / a compose secret
(docker) and mounts it as a **file** that
the target's `config/alertmanager/alertmanager.yml` reads with `api_url_file`. The URLs
therefore never land in a ConfigMap, and rotating one is a Secret update plus a
pod restart with no config change.

| Variable | Default | Description |
|----------|---------|-------------|
| `SLACK_CRITICAL_WEBHOOK_URL` | — | Slack incoming-webhook URL for the paging channel (`#ops-pager` in the shipped config). **A credential** — anyone holding it can post to that channel. |
| `SLACK_WARNING_WEBHOOK_URL` | — | Slack incoming-webhook URL for the non-paging channel (`#ops-warnings`). |

**Every target's setup refuses to deploy while either is still `CHANGE_ME`**
(`pb_check_alert_delivery` in `deploy/bin/gen-env-secrets.sh`). Alerting that
404s into nothing is indistinguishable from healthy alerting, so this is a hard
gate rather than a runtime warning. To run deliberately without ops-team Slack —
local dev, or a site that only uses per-org destinations — set **both** to an
**empty** value: setup then prints a banner saying platform-wide alerts will be
visible only in Alertmanager's own UI/API, and continues. Setting one and not the
other is refused.

The same pre-flight also rejects `alertmanager.yml` if a webhook URL is ever
pasted back into it inline.

### OAuth / social login (Optional)

Platform-wide "Sign in with…" providers. A provider is **enabled iff its
`OAUTH_<P>_CLIENT_ID` is set** (fail-soft — an unconfigured provider is hidden,
never an error); the login page renders its buttons data-driven from the enabled
set. Credentials are **global / one app registration per provider** for the whole
deployment. The redirect URI to register in each provider's console is
`<OAUTH_CALLBACK_BASE_URL>/auth/callback/<provider>`. Per-org enterprise SSO
(OIDC / Cognito) is configured **in the app**, not here — see
[Authentication & SSO](authentication.md).

**Shared:**

| Variable | Default | Description |
|----------|---------|-------------|
| `OAUTH_CALLBACK_BASE_URL` | `${PLATFORM_FRONTEND_URL}` | OAuth redirect origin (each handler appends `/auth/callback/<provider>`) |
| `OAUTH_STATE_TTL_MS` | `600000` | OAuth state (CSRF) token TTL (10 min) |
| `OAUTH_CLEANUP_INTERVAL_MS` | `60000` | Stale state cleanup interval |
| `OAUTH_MAX_PENDING_STATES` | `1000` | Cap on the in-memory pending-state fallback (used only when Redis is unset) |
| `OIDC_DOC_CACHE_TTL_MS` | `3600000` | OIDC discovery / JWKS document cache TTL |
| `SAML_CLOCK_SKEW_MS` | `60000` | Skew tolerated on a SAML assertion's `NotBefore` / `NotOnOrAfter`. Sized for ordinary NTP drift between the IdP and this deployment — raising it accepts staler assertions |
| `SAML_REQUEST_TTL_MS` | `600000` | How long an unanswered SAML `AuthnRequest` stays valid — i.e. how long a person has to finish signing in at their IdP |
| `SAML_ASSERTION_REPLAY_TTL_MS` | `600000` | Floor on how long a **spent** assertion id is remembered for replay refusal. The real window is the assertion's own `NotOnOrAfter` when that is longer (capped at 12 h) |
| `SAML_HANDOFF_TTL_MS` | `120000` | Lifetime of the one-time handoff the SAML ACS hands the browser — the few seconds it takes to follow one redirect |

### Device authorization (CLI sign-in)

`pipeline-manager auth login` uses the OAuth 2.0 device authorization grant, so
the CLI never holds a password — see
[Authentication → CLI sign-in](authentication.md#cli-sign-in-by-device-authorization-rfc-8628).
Every value below has a working default; none needs to be set.

| Variable | Default | Description |
|----------|---------|-------------|
| `DEVICE_CODE_TTL_MS` | `600000` | How long a device code and its short user code stay valid (10 min) |
| `DEVICE_CODE_INTERVAL_SECONDS` | `5` | Minimum seconds between polls. A client polling faster gets `slow_down` and this flow's interval widens by 5 s |
| `DEVICE_CODE_MAX_POLLS` | `200` | Hard ceiling on polls per device code (a conforming client spends ~120 over the full TTL) |
| `DEVICE_APPROVAL_GRACE_MS` | `300000` | How long an approval's step-up proof remains good for the step-up token `auth pat` collects on its next poll |
| `DEVICE_MAX_PENDING` | `1000` | Cap on the in-memory pending-state fallback, used only when no Redis is configured |

### Passkeys (WebAuthn)

The relying party is **derived from `PLATFORM_FRONTEND_URL`** and is never read
from the request: the RP ID is its exact hostname (no scheme, no port) and the
default origin is its scheme + host + port. Nothing below needs to be set.

> **The RP ID is permanent.** Every passkey is bound to the value in force when
> it was registered. Changing `WEBAUTHN_RP_ID` — or the hostname in
> `PLATFORM_FRONTEND_URL` — orphans every credential already enrolled: there is
> no migration, and affected users must enrol again. Platform **refuses to boot**
> when the RP ID is an IP address, when an origin is not the RP ID or a subdomain
> of it, or when an origin is plain `http` (`http://localhost` excepted).

| Variable | Default | Description |
|----------|---------|-------------|
| `WEBAUTHN_RP_ID` | hostname of `PLATFORM_FRONTEND_URL` | Relying-party id. Override only when the origin people browse to differs from the frontend URL (a CDN alias, a split app/api hostname). Permanent — see the warning above |
| `WEBAUTHN_ORIGINS` | origin of `PLATFORM_FRONTEND_URL` | Comma-separated origins a ceremony may come from (scheme + host + port). Each must be the RP ID or a subdomain of it |
| `WEBAUTHN_RP_NAME` | `Pipeline Builder` | Name shown in the device's passkey prompt |
| `WEBAUTHN_CHALLENGE_TTL_MS` | `120000` | How long a ceremony may take between `/options` and `/verify` (2 min). Challenges are single-use and held in the shared Redis |
| `WEBAUTHN_MAX_PENDING_CEREMONIES` | `1000` | Cap on the in-memory ceremony fallback, used only when no Redis is configured |
| `FIDO_MDS_BLOB_PATH` | — | Path to a downloaded FIDO Metadata Service (MDS3) blob JWT. Consulted only for orgs with an approved-authenticator (AAGUID) allowlist; wins over `FIDO_MDS_URL` (the air-gapped option). Its signature chain is verified against the FIDO root before any statement is trusted |
| `FIDO_MDS_URL` | `https://mds.fidoalliance.org/` | Where to fetch the MDS blob when no path is set; `off` disables fetching. With no metadata loaded, passkey registrations into an allowlisted org are **refused** (fail closed) |
| `FIDO_MDS_FETCH_TIMEOUT_MS` | `10000` | Blob fetch timeout. After a failed load, loads are not retried for 5 minutes (a stale snapshot, if any, keeps serving) |
| `FIDO_MDS_REFRESH_MS` | `86400000` | How long a loaded blob is cached before it is re-read (24 h) |

The browser also needs `publickey-credentials-get` / `publickey-credentials-create`
in `Permissions-Policy`; every shipped nginx config and `frontend/next.config.js`
declares them explicitly.

### Authenticator app (TOTP)

Nothing below needs to be set. The algorithm parameters are deliberately **not**
configurable — SHA-1 / 6 digits / 30 seconds is the only combination every
authenticator reads reliably from an `otpauth://` URI, and a knob there would only
let an operator produce enrolments that scan cleanly and then never verify.

Secrets are encrypted at rest under `SECRET_ENCRYPTION_KEY`, HKDF-bound to the
owning user, so the master-key rotation notes above apply to them too.

| Variable | Default | Description |
|----------|---------|-------------|
| `TOTP_ISSUER` | `Pipeline Builder` | Name the authenticator app shows above the code, and the `issuer` baked into the enrolment QR. Purely a label — changing it does not invalidate existing enrolments, though already-scanned entries keep the old name |
| `TOTP_MAX_FAILURES` | `5` | Consecutive wrong codes before the account's TOTP verification is locked out. A 6-digit code is ~20 bits, so this — not the code — is what makes online guessing hopeless |
| `TOTP_LOCKOUT_MS` | `900000` | How long that lockout lasts (15 min). Applies to sign-in and step-up alike, and to recovery codes |
| `TOTP_LOGIN_CHALLENGE_TTL_MS` | `300000` | Lifetime of the sign-in MFA challenge — the handle a password sign-in returns instead of a session (5 min). Held in the shared Redis |
| `TOTP_MAX_PENDING_CHALLENGES` | `1000` | Cap on the in-memory challenge fallback, used only when no Redis is configured |

> **Operator note.** A person who loses both their authenticator and their
> recovery codes cannot self-serve back in: deleting their `usertotps` row (with
> database access) is the recovery, and it should be treated as the privileged,
> out-of-band action it is.

**Per provider** (`CLIENT_ID` empty = disabled):

| Variable | Default | Description |
|----------|---------|-------------|
| `OAUTH_GOOGLE_CLIENT_ID` | — | Google client ID ([Google Cloud Console](https://console.cloud.google.com/apis/credentials)) |
| `OAUTH_GOOGLE_CLIENT_SECRET` | — | Google client secret |
| `OAUTH_GITHUB_CLIENT_ID` | — | GitHub client ID ([GitHub OAuth Apps](https://github.com/settings/developers)) |
| `OAUTH_GITHUB_CLIENT_SECRET` | — | GitHub client secret |
| `OAUTH_FACEBOOK_CLIENT_ID` | — | Facebook app ID ([Meta for Developers](https://developers.facebook.com/apps)) |
| `OAUTH_FACEBOOK_CLIENT_SECRET` | — | Facebook app secret |
| `OAUTH_MICROSOFT_CLIENT_ID` | — | Microsoft/Entra client ID ([Entra admin center](https://entra.microsoft.com) → App registrations) |
| `OAUTH_MICROSOFT_CLIENT_SECRET` | — | Microsoft/Entra client secret |
| `OAUTH_MICROSOFT_TENANT` | `common` | Entra tenant: `common` (any account) or a specific tenant id/domain |
| `OAUTH_GITLAB_CLIENT_ID` | — | GitLab application ID ([GitLab Applications](https://gitlab.com/-/profile/applications)) |
| `OAUTH_GITLAB_CLIENT_SECRET` | — | GitLab application secret |
| `OAUTH_GITLAB_BASE_URL` | `https://gitlab.com` | GitLab base URL (point at a self-hosted instance to use it) |
| `OAUTH_LINKEDIN_CLIENT_ID` | — | LinkedIn client ID ([LinkedIn Developers](https://www.linkedin.com/developers/apps), "Sign in with LinkedIn using OpenID Connect") |
| `OAUTH_LINKEDIN_CLIENT_SECRET` | — | LinkedIn client secret |

---

## Databases

### PostgreSQL

| Variable | Default | Description |
|----------|---------|-------------|
| `POSTGRES_USER` | `postgres` | Superuser (container init) |
| `POSTGRES_PASSWORD` | — | Superuser password |
| `POSTGRES_DB` | `pipeline_builder` | Database name (container init) |
| `DB_HOST` | `postgres` | Host for services |
| `DB_PORT` | `5432` | Port |
| `DB_USER` | `postgres` | User for services |
| `DB_PASSWORD` | — | Password for services |
| `DRIZZLE_MAX_POOL_SIZE` | `20` | Connection pool size |
| `DRIZZLE_IDLE_TIMEOUT_MILLIS` | `30000` | Idle connection timeout (ms) |
| `DRIZZLE_CONNECTION_TIMEOUT_MILLIS` | `10000` | Connection timeout (ms) |
| `DB_MAX_RETRIES` | `3` | Connection retry attempts |
| `DB_RETRY_DELAY_MS` | `1000` | Retry delay (ms) |
| `DATABASE` | `pipeline_builder` | Database name for services |
| `DB_CLOSE_TIMEOUT_MS` | `5000` | Pool close timeout on shutdown (ms) |
| `DB_STATEMENT_TIMEOUT_MS` | `30000` | Per-transaction `statement_timeout` set with the RLS context; a runaway query is cancelled instead of pinning a pooled connection |
| `DB_SSL` | — | `true`/`1` forces TLS to Postgres on, `false`/`0` off. Unset → Postgres' `PGSSLMODE` (`disable` = off), else ON in production and OFF elsewhere |
| `DB_SSL_REJECT_UNAUTHORIZED` | `false` | With TLS on, verify the server certificate. Set `true` once the RDS CA bundle is mounted; the channel is encrypted either way |
| `SOFT_DELETE_RETENTION_DAYS` | `30` | How long a soft-deleted pipeline/plugin/template stays restorable before the purge sweep hard-deletes it |
| `SOFT_DELETE_PURGE_ENABLED` | `true` | Run the soft-delete purge sweep. `false` keeps tombstones indefinitely |
| `SOFT_DELETE_PURGE_INTERVAL_HOURS` | `6` | Interval between purge sweeps (min 1) |
| `SOFT_DELETE_PURGE_STARTUP_DELAY_MS` | `120000` | Delay before the first sweep after boot |
| `SOFT_DELETE_PURGE_LOCK_TTL_MS` | `900000` | Purge-sweep leader-lock TTL; only one replica sweeps at a time |
| `ECOSYSTEM_PUBLIC_READER_PASSWORD` | — (generated by `gen-env-secrets.sh`) | Password of `ecosystem_public_reader`, the **view-only** login behind the anonymous public plugin directory (`SELECT` on the `public_listings` / `public_listed_versions` views, nothing else). Read by `postgres-init.sql` (creates the role), by pgbouncer (adds it to its userlist) and by the plugin service. Empty → the role isn't created and the directory stays off. |
| `PUBLIC_DIRECTORY_DB_NAME` | `pipeline_builder_public` | pgbouncer database alias the plugin service's directory reads use: a separate `pool_size=5` pool, and `ecosystem_public_reader` is capped at 5 server connections across **every** pool (`[users] max_user_connections`), so unauthenticated traffic can't exhaust the tenant pools |

**Every Postgres client goes through pgbouncer** (`DB_HOST=pgbouncer`, `DB_PORT=6432`
on every target). No service connects to Postgres directly, including the public
directory's reader login. pgbouncer's userlist carries exactly two logins: the
`DB_USER` application role and `ecosystem_public_reader`. The superuser is never
reachable through the pooler.

### MongoDB

| Variable | Default | Description |
|----------|---------|-------------|
| `MONGO_INITDB_ROOT_USERNAME` | `mongo` | Root username |
| `MONGO_INITDB_ROOT_PASSWORD` | — | Root password |
| `MONGO_INITDB_DATABASE` | `platform` | Initial database |
| `MONGODB_URI` | — | Full connection URI with replica set |

### Redis

| Variable | Default | Description |
|----------|---------|-------------|
| `REDIS_URL` | — | **Standalone:** `redis://<host>:<port>[/db]`, or `rediss://` for TLS |
| `REDIS_PASSWORD` | — | Data-node AUTH password (optional, either mode) |
| `REDIS_SENTINELS` | — | **HA:** comma-separated `host:port` Sentinel list. The app connects via Sentinel and follows the promoted primary after a failover. Also the shape a managed ElastiCache (cluster-mode-disabled) uses. See [`deploy/aws/*/k8s/redis-sentinel.yaml`](https://github.com/mwashburn160/pipeline-builder/blob/main/deploy/aws/eks/k8s/redis-sentinel.yaml) |
| `REDIS_SENTINEL_MASTER` | `mymaster` | Sentinel monitored-primary name (Sentinel mode) |
| `REDIS_SENTINEL_PASSWORD` | — | Sentinel AUTH password (Sentinel mode, optional) |

> Redis must use `maxmemory-policy noeviction` for BullMQ. `allkeys-lru` causes silent job data loss.
> **HA:** the AWS targets (ec2 and eks) ship **Sentinel HA by default** (`redis-sentinel.yaml` — 3 Redis + 3 Sentinel, reached via `REDIS_SENTINELS`). The docker and minikube targets run a single instance with no failover. For a managed path, point it at **ElastiCache (Multi-AZ, cluster-mode-disabled)**.
>
> **Set exactly one of `REDIS_URL` or `REDIS_SENTINELS`.** Setting both, or setting the retired `REDIS_HOST`, stops every service at startup with a configuration error, as does a malformed `REDIS_URL` or Sentinel entry. Neither set means Redis is off. `REDIS_PORT` is ignored — Kubernetes injects `REDIS_PORT=tcp://…` into pods next to a Service named `redis`.
>
> **Every service resolves Redis the same way**, including the platform. Configure Redis for **platform** as well as the other services: it uses Redis to publish session revocations and to share OAuth/SSO login state, step-up single-use, and the background-sweep lock across replicas. Without it those fall back to per-replica memory, which breaks once platform scales past one replica.
>
> **Impersonation needs Redis on every service.** A service that cannot read Redis rejects impersonation tokens, because it could not tell whether the session was ended. Ordinary sessions are unaffected.

---

## Docker Registry

| Variable | Default | Description |
|----------|---------|-------------|
| `IMAGE_REGISTRY_HOST` | `registry` | Registry hostname |
| `IMAGE_REGISTRY_PORT` | `5000` | Registry port |
| `IMAGE_REGISTRY_USER` | `admin` | Registry username |
| `IMAGE_REGISTRY_TOKEN` | — | Registry password/token |
| `IMAGE_REGISTRY_PULL_HOST` | host of `PLATFORM_BASE_URL`, else `IMAGE_REGISTRY_HOST` | Registry host CodeBuild pulls plugin images from (must be publicly resolvable) |
| `IMAGE_REGISTRY_PULL_PORT` | port of `PLATFORM_BASE_URL`, else `IMAGE_REGISTRY_PORT` | Registry port for those pulls |
| `DOCKER_NETWORK` | — | Docker network the plugin build containers join (docker-compose targets) |
| `REGISTRY_TOKEN_RATE_LIMIT_MAX` | `60` | image-registry `/token`: requests per window per (source IP, username) |
| `REGISTRY_TOKEN_RATE_LIMIT_IP_MAX` | `300` | image-registry `/token`: requests per window per source IP across all usernames (stops password spraying) |
| `REGISTRY_TOKEN_RATE_LIMIT_WINDOW_MS` | `60000` | image-registry `/token` rate-limit window (ms) |
| `REGISTRY_TOKEN_RATE_LIMIT_MAX_BUCKETS` | `10000` | Cap on distinct in-memory `/token` rate-limit buckets — only used on the no-Redis fallback path, so short-lived identities can't grow it unbounded |
| `REGISTRY_TOKEN_EXPIRES_IN` | `300` | Lifetime (seconds) of the registry bearer token `/token` issues (the `expires_in` in its response) |
| `REGISTRY_BLOB_STREAM_TIMEOUT_MS` | `30000` | Read timeout (ms) for image-registry's blob streaming from the upstream registry — short so a stuck upstream connection fails fast |
| `REGISTRY_MAX_BLOB_PROXY_BYTES` | `5242880` | Max blob size (bytes, 5 MiB) the registry UI's blob-preview proxy will serve; larger blobs (layers, attestations) get `413` so a multi-GB layer can't be buffered |
| `REGISTRY_COPY_PARALLEL_CHILDREN` | `3` | Cross-repo image copy: child manifests (of a multi-arch index) copied concurrently |
| `REGISTRY_COPY_PARALLEL_BLOBS` | `8` | Cross-repo image copy (and repo delete): blobs mounted/deleted concurrently per manifest — `CHILDREN × BLOBS` bounds in-flight registry calls (24 by default) |
| `REGISTRY_STORAGE_CACHE_TTL_MS` | `60000` | Per-org registry storage-usage rollup cache (ms) — short enough that a cleanup shows freed bytes promptly, long enough that a dashboard auto-refresh doesn't walk the registry each time |
| `REGISTRY_PUBLICATION_CACHE_TTL_MS` | `60000` | Cache (ms) of the `public/*` repository → billed-org publication-record rollup used for storage attribution and the push gate |
| `PUBLIC_VERIFY_CACHE_TTL_MS` | `60000` | Per-pod cache (ms) of POSITIVE signature/trust-tier verification results for public plugin images. A resign/yank/GC (or `POST …/verify-cache/invalidate`) clears the pod it runs on; this TTL bounds how long another replica can serve stale annotations |
| `REGISTRY_HTTP_SECRET` | — | k8s targets: the registry replicas' shared upload-session signing secret (a chunked push must survive landing on another replica or a rollout). Generated by `gen-env-secrets.sh`; lives only in `registry-token-secret`, never `app-secrets`. |
| `IMAGE_REGISTRY_HTTP` | `true` | Plugin builds talk to the in-cluster registry over plain HTTP. Set `false` only if the registry is exposed via a TLS-terminating proxy with a publicly trusted cert. |
| `IMAGE_REGISTRY_TOKEN_REALM` | `${PLATFORM_BASE_URL}/image-registry/token` | Bearer-token realm the plugin keys its registry credential under. **Must match the registry's `REGISTRY_AUTH_TOKEN_REALM`** (e.g. `http://image-registry:3000/token` in-cluster) — when the registry redirects a push to a different host than the push target, the plugin only sends Basic auth if it has a credential keyed under that realm host. Set on every target's plugin so pushes don't 401 / `insufficient_scope`. |

### Registry garbage collection

Image-registry's scheduled GC prunes old manifests from every org namespace. **Off by default** — an operator opts in.

| Variable | Default | Description |
|----------|---------|-------------|
| `REGISTRY_GC_ENABLED` | `false` | Run the scheduled, destructive GC sweep. One replica sweeps per window (leader lock — see `REGISTRY_GC_LOCK_TTL_MS` under [Scaling & multi-replica](#scaling--multi-replica-optional)) |
| `REGISTRY_GC_INTERVAL_HOURS` | `24` | Hours between full sweeps |
| `REGISTRY_GC_MAX_AGE_DAYS` | `30` | Manifests older than this many days are pruned |
| `REGISTRY_GC_STARTUP_DELAY_MS` | `300000` | Delay (ms, 5 min) before the first sweep after boot, so the registry settles first (`0` = sweep immediately) |

### Plugin-image signing (cosign) — image-registry signs, plugin verifies

Every plugin image the plugin service pushes is signed with cosign (key-based,
transparency log off) and gets a signed SPDX SBOM attestation; synth pins
CodeBuild to the verified digest. The **private** key lives only in
**image-registry**, which signs at `POST /internal/plugin-signatures` (service
token; the caller must be `plugin`). The plugin service holds only the
**public** key: its pod shares a network namespace with the buildkitd sidecar
that runs untrusted tenant Dockerfile `RUN` steps, so it must never hold the
private key or be able to reach AWS credentials. Keys come from
`deploy/bin/plugin-signing-keys.sh`; rotation invalidates every existing
signature — see [Plugin-signing key](runbooks/secret-rotation.md#plugin-signing-key).

**image-registry**

| Variable | Default | Description |
|----------|---------|-------------|
| `PLUGIN_SIGNING_MODE` | `local` | `local` signs with a PEM from disk; `kms` keeps the private key inside AWS KMS (asymmetric `ECC_NIST_P256`, `SIGN_VERIFY`). |
| `PLUGIN_SIGNING_KEY_FILE` | `/etc/pipeline-builder/plugin-signing/plugin-signing.key` | `local` mode: the EC P-256 private key (PKCS#8 PEM), mounted from the `plugin-signing-key` Kubernetes Secret (image-registry only). Imported into cosign's own format once per process, under a random in-memory password. |
| `PLUGIN_SIGNING_KMS_KEY_ID` | — | **Required in `kms` mode.** The KMS key, **by alias** (`alias/pipeline-builder-plugin-signing`) — an ARN embeds the AWS account id and is refused. image-registry's role (not plugin's) needs `kms:Sign` + `kms:GetPublicKey`. |
| `PLUGIN_SIGNING_TIMEOUT_MS` | `120000` | Upper bound on one cosign invocation (`sign` / `attest`). |
| `TMPDIR` | `/tmp` | cosign writes its TUF cache, the imported key and each SBOM predicate under the temp dir — a writable `scratch-tmp` emptyDir on the k8s targets (the root filesystem is read-only). |

**plugin**

| Variable | Default | Description |
|----------|---------|-------------|
| `PLUGIN_SIGNING_PUBLIC_KEY_FILE` | `/etc/pipeline-builder/plugin-signing/plugin-signing.pub` | PEM public key plugin images are verified against (`cosign verify`), mounted from the `plugin-signing-public-key` Secret. In `kms` mode it is exported from KMS by the deploy script. |

---

## Plugin Builds

Every deploy target (EKS, EC2, minikube, local docker-compose) runs
plugin builds against a **rootless `moby/buildkit` sidecar (`buildkitd`)**. The
plugin service's `buildctl` connects via the Unix socket exposed by the sidecar —
there is no docker daemon, no privileged build sidecar, and no strategy switch.

| Variable | Default | Description |
|----------|---------|-------------|
| `BUILDKIT_HOST` | `unix:///run/buildkit/buildkitd.sock` | buildctl `--addr` for the buildkitd sidecar |
| `DOCKER_BUILD_TIMEOUT_MS` | `900000` | Build timeout (15 min) |
| `DOCKER_PUSH_TIMEOUT_MS` | `300000` | Push timeout (5 min) |
| `PLUGIN_UPLOAD_TIMEOUT_MS` | `300000` | Upload HTTP timeout (5 min) — overrides `HANDLER_TIMEOUT_MS` for the upload route |
| `PLUGIN_MAX_UPLOAD_MB` | `4096` | Max plugin ZIP upload size in MB (supports prebuilt image.tar) |
| `GRYPE_DB_CACHE_DIR` | `$TMPDIR/grype-db` (deploys set `/var/cache/grype`) | grype's vulnerability DB for the build-time scan and the nightly rescan. Every deploy mounts a volume here (compose: the `grype-db` named volume; k8s: a 2 Gi `emptyDir`) — the plugin container's root filesystem is read-only, and a fresh DB is hundreds of MB |
| `PLUGIN_GRYPE_DB_AUTO_UPDATE` | `true` | Refresh the vulnerability DB (at most every `PLUGIN_GRYPE_DB_UPDATE_INTERVAL_MS` before a build scan, and always before the nightly rescan). `false` = an operator maintains the DB (air-gapped installs) |
| `PLUGIN_GRYPE_DB_UPDATE_INTERVAL_MS` | `3600000` | Minimum time between DB refreshes before a build scan (1 h) |
| `PLUGIN_GRYPE_DB_UPDATE_TIMEOUT_MS` | `600000` | Bound on one DB refresh (10 min) |
| `PLUGIN_RESCAN_ENABLED` | `true` | Nightly vulnerability rescan of every active image plugin's signed SBOM (leader-locked, one pod per pass). `false` switches it off |
| `PLUGIN_RESCAN_INTERVAL_MS` | `86400000` | Time between completed rescan passes (24 h); pods tick hourly and run a pass only when this has elapsed |
| `PLUGIN_RESCAN_LOCK_TTL_MS` | `21600000` | Rescan leader-lock TTL (6 h) — must outlast one pass |
| `PLUGIN_RESCAN_STARTUP_DELAY_MS` | `120000` | Delay before the first rescan tick after boot |
| `PLUGIN_VULN_MAX_CRITICAL` | `0` | The platform vulnerability floor: a build whose image has MORE **fixable** Critical findings (grype reports a fixed version) fails permanently with `PLUGIN_VULN_GATE` (the message lists the CVEs and their fixed versions) — every build path (upload, prebuilt, AI deploy, bulk, catalog loader) and the anonymous-submission quarantine gates. The nightly rescan **flags** a stored version that exceeds it. `-1` disables the floor and the flag. Org compliance rules can still be stricter |
| `PLUGIN_ALLOW_UNSCANNED` | `false` | Operator escape hatch. By default a build whose image could not be vulnerability-scanned is retried (BullMQ attempts/backoff) and, on its last attempt, fails with `IMAGE_SCAN_UNAVAILABLE` — nothing is persisted and the quota slot is released. `true` persists the version **unscanned** instead (audited `plugin.scan.skipped`; the UI shows "Unscanned") |
| `PLUGIN_BLOCK_ON_NEW_CRITICAL` | `false` | What resolution does with a version the nightly rescan flagged (fixable Criticals over `PLUGIN_VULN_MAX_CRITICAL`). `false`: it resolves, and the lookup carries a `VULN_FLAGGED` warning (synth / the CLI print it). `true`: ranges and the default skip flagged versions (the newest unflagged satisfying version wins, like advisory-blocked skipping), and an exact version / id pin to one is refused `409 PLUGIN_VERSION_VULN_BLOCKED` naming the fix. Applies to org plugins and to installed listings; set it on the plugin service **and** the pipeline service (its create-time contract check resolves listings too) |

The plugin image is published with a single tag (`plugin:<version>`) — one
builder, one path, no per-builder target suffixes.

### How the build runs

- **Build from source** (`buildType: build_image`): `buildctl build --frontend dockerfile.v0 --local context=<dir> --local dockerfile=<dir> --output type=image,name=<image>,push=true[,registry.insecure=true]`. buildkitd handles the Dockerfile parse, layer cache, registry push, and bearer-token negotiation.
- **Prebuilt tarball** (`buildType: prebuilt`): `crane push <tar> <image>`. buildctl can build but cannot push pre-existing `docker save` tarballs; the plugin image bundles `crane` for this path only.

### Why rootless BuildKit

- **Rootless, no privileged containers**: `moby/buildkit:rootless` runs as uid 1000 with no `SYS_ADMIN` and no `privileged: true` — it builds full OCI images from a Dockerfile **without a Docker daemon and without a docker socket mount**, removing the classic dind/socket attack surface.
- **Builds and pushes directly**: buildkitd parses the Dockerfile, runs the build with native **layer caching**, and **pushes straight to the registry** (`--output type=image,push=true`) — no intermediate `docker save`/`docker push` round-trip.
- **No CA-trust workarounds**: buildkitd carries the system CA bundle and follows realm-URL bearer challenges with the host's trust store — no per-container cert mounts, no `update-ca-certificates` shell wrappers.
- **One code path everywhere**: the same `docker-build.ts` runs on EKS, EC2, minikube, and local. Deploy target only changes the sidecar's hosting (k8s pod / compose service).

### Build Queue

| Variable | Default | Description |
|----------|---------|-------------|
| `PLUGIN_BUILD_CONCURRENCY` | `1` | Max concurrent builds per container — the default for every tier's worker below |
| `PLUGIN_BUILD_CONCURRENCY_DEVELOPER` | `PLUGIN_BUILD_CONCURRENCY` | Concurrent builds per container on the `developer` tier's queue |
| `PLUGIN_BUILD_CONCURRENCY_PRO` | `PLUGIN_BUILD_CONCURRENCY` | Concurrent builds per container on the `pro` tier's queue |
| `PLUGIN_BUILD_CONCURRENCY_TEAM` | `PLUGIN_BUILD_CONCURRENCY` | Concurrent builds per container on the `team` tier's queue |
| `PLUGIN_BUILD_CONCURRENCY_ENTERPRISE` | `PLUGIN_BUILD_CONCURRENCY` | Concurrent builds per container on the `enterprise` tier's queue |
| `PLUGIN_BUILD_CONCURRENCY_UNLIMITED` | `PLUGIN_BUILD_CONCURRENCY` | Concurrent builds per container on the `unlimited` tier's queue |
| `PLUGIN_MAX_BUILDS_PER_ORG` | `3` | Max in-flight builds per org across all workers (Redis semaphore) — an org over the cap has its job re-delayed so another org's build takes the worker slot |
| `PLUGIN_ORG_SLOT_DELAY_MS` | `10000` | How long (ms) a job that couldn't get an org slot waits before retrying |
| `PLUGIN_ORG_SLOT_TTL_SEC` | `900` | Defensive expiry (seconds) of a held org build slot, so a crashed worker can't leak one forever |
| `PLUGIN_TIER_CACHE_TTL_MS` | `300000` | Per-pod cache (ms) of each org's tier, used to route a build to its tier queue; a stale entry only misroutes to a neighbouring queue until expiry |
| `PLUGIN_BUILD_QUEUE_NAME` | `plugin-build` | BullMQ queue name |
| `PLUGIN_BUILD_MAX_ATTEMPTS` | `2` | Max build attempts before moving to DLQ |
| `PLUGIN_BUILD_BACKOFF_DELAY_MS` | `5000` | Backoff delay between retries (ms) |
| `PLUGIN_BUILD_COMPLETED_RETENTION_SECS` | `3600` | Completed job retention (1 hour) |
| `PLUGIN_BUILD_FAILED_RETENTION_SECS` | `86400` | Failed job retention (24 hours) |
| `PLUGIN_BUILD_WORKER_TIMEOUT_MS` | `10000` | Worker ready timeout (ms) |
| `PLUGIN_DLQ_MAX_ATTEMPTS` | `3` | Max DLQ retry attempts (exponential backoff) |
| `PLUGIN_DLQ_BACKOFF_BASE_MS` | `300000` | DLQ backoff base delay (5 min; scales 5m, 15m, 45m) |
| `PLUGIN_DLQ_MAX_SIZE` | `20` | Max DLQ jobs before oldest are purged |
| `PLUGIN_DLQ_SCAN_INTERVAL_MS` | `5000` | Minimum interval (ms) between DLQ max-size enforcement scans |
| `PLUGIN_QUEUE_METRICS_INTERVAL_MS` | `15000` | How often (ms) the build-queue job counts are scraped into Prometheus metrics |
| `PLUGIN_QUEUE_MAX_PAGE_DEPTH` | `5000` | Deepest row a caller may page to on the queue `GET /failed` and `GET /dlq` views (each page reads `offset + limit` entries from every queue, so this bounds the Redis range read) |
| `PLUGIN_TRIAGE_CACHE_TTL_MS` | `5000` | Memo TTL (ms) for the queue `GET /triage` aggregate, collapsing a dashboard's repeated polls into one scan |
| `PLUGIN_TRIAGE_CACHE_MAX_ENTRIES` | `500` | Cap on distinct `/triage` memo keys (keyed per org), oldest evicted first |
| `TEMP_DIR_MAX_AGE_MS` | `14400000` | Stale temp dir cleanup threshold (4 hours) |

---

## Quotas & Rate Limiting

| Variable | Default | Description |
|----------|---------|-------------|
| `QUOTA_DEFAULT_PLUGINS` | `100` | Fallback-read plugin cap (see note) |
| `QUOTA_DEFAULT_PIPELINES` | `10` | Fallback-read pipeline cap (see note) |
| `QUOTA_DEFAULT_API_CALLS` | `-1` | Fallback-read API-call cap, `-1` = unlimited (see note) |
| `QUOTA_DEFAULT_AI_CALLS` | `100` | Fallback-read AI-call cap, sized smaller than `apiCalls` because each call has external $ cost (see note) |
| `QUOTA_RESET_DAYS` | `3` | Reset period (days) for every quota type, shared by the quota and platform services |
| `QUOTA_RESERVE_FAIL_OPEN` | `false` | When a quota reservation can't be CONFIRMED (quota service unreachable, timed out, errored, or a non-quota 429), `false` denies the request; `true` lets it through. Both emit `quota_fail_closed_total` / `quota_fail_open_total` |
| `QUOTA_SERVICE_HOST` | `quota` | Quota service host |
| `QUOTA_SERVICE_PORT` | `3000` | Quota service port |
| `LIMITER_MAX` | `100` | Global rate limit (requests/window) |
| `LIMITER_WINDOWMS` | `900000` | Global rate limit window (15 min) |
| `REGISTRY_TOKEN_RATE_LIMIT_MAX` | `60` | image-registry `/token`: requests per window per (source IP, username) — also listed under [Docker Registry](#docker-registry) |
| `REGISTRY_TOKEN_RATE_LIMIT_IP_MAX` | `300` | image-registry `/token`: requests per window per source IP across all usernames |
| `REGISTRY_TOKEN_RATE_LIMIT_WINDOW_MS` | `60000` | image-registry `/token` rate-limit window (ms) |
| `AUTH_LIMITER_MAX` | `20` | Auth endpoint rate limit |
| `AUTH_LIMITER_WINDOWMS` | `900000` | Auth rate limit window (15 min) |
| `MESSAGE_SEND_RATE_MAX` | `60` | Per-**org** message send + reply limit (post-auth; complements the global per-IP limiter). Verified service principals exempt |
| `MESSAGE_SEND_RATE_WINDOW_MS` | `60000` | Per-org message-send window (1 min) |
| `MESSAGE_ATTACHMENT_RATE_MAX` | `30` | Per-**org** attachment-upload limit (rejected before multipart buffering) |
| `MESSAGE_ATTACHMENT_RATE_WINDOW_MS` | `60000` | Per-org attachment-upload window (1 min) |
| `MESSAGE_THUMBNAIL_MAX_DIM` | `320` | Long-edge (px) of generated image thumbnails (pure-JS jimp; served via `?thumb=1`, falls back to the original) |
| `LIMITER_MULT_DEVELOPER` | `1` | Developer-tier rate-limit multiplier (budget = `LIMITER_MAX` × mult) |
| `LIMITER_MULT_PRO` | `10` | Pro-tier rate-limit multiplier |
| `LIMITER_MULT_TEAM` | `25` | Team-tier rate-limit multiplier |
| `LIMITER_MULT_ENTERPRISE` | `50` | Enterprise-tier rate-limit multiplier |
| `LIMITER_MULT_UNLIMITED` | `100` | Unlimited-tier rate-limit multiplier (billing-disabled default tier) |
| `ASK_RATE_LIMIT_PER_MIN` | `30` | Per-org ceiling on the Ask agent's routes. These run an LLM per request, so the cap is about model spend and latency, not abuse |
| `PIPELINE_GENERATE_RATE_LIMIT_PER_MIN` | `20` | Per-org ceiling on AI pipeline generation (`POST /pipelines/generate`) |
| `PLUGIN_GENERATE_RATE_LIMIT_PER_MIN` | `20` | Per-org ceiling on AI plugin generation. `POST /plugins/generate` and `/generate/stream` share ONE limiter instance, so this is the combined allowance across both, not per route |

> **SCIM has no rate-limit env vars.** The `/scim/v2/*` limiter is fixed at 600
> requests / 60 s from the `SCIM_RATE_LIMIT_MAX` / `SCIM_RATE_LIMIT_WINDOW_MS`
> constants in `platform/src/constants/scim.ts` — changing it is a code change,
> not configuration.

| Variable | Default | Description |
|----------|---------|-------------|
| `SCIM_DOCUMENTATION_URL` | `https://docs.pipeline-builder.com/docs/authentication.html` | The `documentationUri` served in the SCIM `ServiceProviderConfig` — the first document an IdP fetches. Override it for an air-gapped install that republishes the docs internally |

> **These are not the caps a new org gets.** The platform service is the sole authority for org lifecycle: it seeds each org's stored limits from its **tier** (see `QUOTA_TIERS` below) at creation time, and enforcement reserves against those stored values. The `QUOTA_DEFAULT_*` values govern only the *fallback read* for an org that has no document yet — so the dashboard renders something instead of erroring. Changing them does not raise or lower any real org's limit.

Tier presets ship in `@pipeline-builder/api-core` (`QUOTA_TIERS` in `quota-tiers.ts`):

| Tier | plugins | pipelines | apiCalls | aiCalls | listings | seats |
|------|---------|-----------|----------|---------|----------|-------|
| developer | 25 | 2 | 25,000 | 25 | 3 | 1 |
| pro | 50 | 5 | 250,000 | 1,000 | 10 | 1 |
| team | 75 | 6 | 500,000 | 2,500 | 25 | 3 |
| enterprise | 150 | 30 | 900,000 | 9,000 | 100 | 15 |
| unlimited | -1 | -1 | -1 | -1 | -1 | -1 |

Any preset can be overridden per-environment via `QUOTA_TIER_<DEVELOPER|PRO|TEAM|ENTERPRISE|UNLIMITED>_<LIMIT>` (e.g. `QUOTA_TIER_TEAM_SEATS=20`, `QUOTA_TIER_PRO_LISTINGS=15`), and `DEFAULT_QUOTA_TIER` sets the tier assigned to newly created orgs (`developer` by default). `seats` is a tier limit, not a tracked counter — it is enforced live at invite time against active org membership.

**`unlimited` tier.** Every limit is `-1` (uncapped) and every gated feature is on. It is the automatic default when **billing is disabled** (`BILLING_ENABLED=false`) — `DEFAULT_QUOTA_TIER` is ignored in that case and new orgs get `unlimited`. When billing is **enabled** it is never displayed, selectable, or purchasable (excluded from the plans list and tier pickers), and `DEFAULT_QUOTA_TIER=unlimited` is rejected in favour of `developer`. Its label is overridable via `QUOTA_TIER_UNLIMITED_LABEL` (default `Unlimited`).

Every quota counter rolls over on one shared period, `QUOTA_RESET_DAYS` (default `3`), read by both the quota service (which resets counters) and platform (which seeds a new org's counters).

Per-call increments to `/quotas/:orgId/increment` cap `amount` at 1000 — bounds the per-request blast radius from a buggy or malicious caller.

---

## Plugin Ecosystem

Feature flags and kill switches for the plugin ecosystem
([kill switches](runbooks/ecosystem-moderation.md#kill-switches)). Read by the plugin service; set in `.env`
(k8s: the `app-env` ConfigMap).

| Variable | Default | Description |
|----------|---------|-------------|
| `PUBLIC_DIRECTORY_ENABLED` | `true` | Public, searchable plugin directory (`/plugins`, `/api/public/plugins*`). Needs `ECOSYSTEM_PUBLIC_READER_PASSWORD`. Off → both return 404 |
| `PLUGIN_PUBLISHING_ENABLED` | `false` in the shipped `.env.example` files; unset → on when billing is on (hosted), off when it is off (self-hosted) | Tenant orgs may **submit** publish requests. Every listing and version is still approved by the system org's Ecosystem Managers. Off → tenant requests answer 403 `PLUGIN_PUBLISHING_DISABLED`; existing listings still resolve. The system org's Official catalog is never affected. The hosted hub sets it `true` |
| `PLUGIN_REVIEWS_ENABLED` | `true` | Ratings and reviews. Off → read-only |
| `ANONYMOUS_SUBMISSIONS_ENABLED` | `false` | Not-logged-in plugin submissions (quarantine → isolated build → moderation). Stays unavailable without outbound email (magic-link verification) |
| `SUBMISSION_POW_SECRET` | `CHANGE_ME` (generated by `gen-env-secrets.sh`) | HMAC key that signs the self-hosted proof-of-work challenges (`GET /api/public/plugin-submissions/challenge`). Required while `ANONYMOUS_SUBMISSIONS_ENABLED=true` — the service fails closed without it. k8s: lands in `app-secrets` |
| `SUBMISSION_POW_DIFFICULTY` | `20` | Leading zero **bits** a PoW solution must have (20 ≈ 1M SHA-256 hashes, about a second in a browser Web Worker). Raise during a flood |
| `SUBMISSION_EMAIL_HASH_SECRET` | `CHANGE_ME` (generated) | HMAC key the submitter's normalized email is hashed under (`email_hash`: per-email rate limit, update ownership, claim matching). Rotating it orphans existing submissions' ownership. k8s: `app-secrets` |
| `SUBMISSION_BUILD_TIMEOUT_SECONDS` | `900` | Wall-clock cap on one quarantine build on the isolated buildkitd |
| `SUBMISSION_MAX_ZIP_BYTES` | `52428800` (50 MiB) | Largest accepted submission zip. nginx caps the POST body at `50m` on `/api/public/plugin-submissions` and `/inspect` — keep the two in step |
| `SUBMISSION_EXTRACT_DIR` | `<os tmpdir>/pb-submission-extract` | Scratch directory the plugin service unpacks submission zips into for inspection (bounded, cleaned per submission) |
| `SUBMISSION_MAX_CONCURRENT_EXTRACTS` | `2` | How many submission zips may be extracted at once (1–64) — bounds the disk/CPU an anonymous flood can claim |
| `PLUGIN_QUARANTINE_BUCKET` | `plugin-quarantine` | Object-storage bucket submission zips wait in (`submissions/<id>.zip`). Created by the bootstrap Job with a 30-day expiry; the plugin service's own bucket-scoped object-store user (`PLUGIN_S3_*`) is granted it |
| `PLUGIN_QUARANTINE_BUILDKIT_ADDR` | `tcp://buildkitd-quarantine:1234` (docker) / `tcp://plugin-quarantine-builder:1234` (k8s) | The **isolated** buildkitd quarantine builds run on: no credentials, its own network/NodePool, egress to package mirrors + the registry only. No fallback to the tenant `BUILDKIT_HOST` — unset means submissions fail closed |
| `OFFICIAL_AUTO_APPROVAL_ENABLED` | `true` | The seeded rule that auto-approves routine, gate-green patch/minor updates of existing Official listings submitted by the catalog loader. Off → every Official update waits for two-person approval |
| `PUBLISHER_TERMS_VERSION` | `2026-09-21` | The publisher terms version in force. Bumping it makes every publisher re-accept before its next request (`PUBLISHER_TERMS_REQUIRED`); existing listings are unaffected |
| `ECOSYSTEM_BOOTSTRAP_WINDOW_HOURS` | `24` | How long the one-time bootstrap exception stays open after the first Official request of an empty instance, so the initial catalog load (whose builds finish in parallel) is approved automatically. It closes for good when it elapses or when any manager decides a request |
| `ECOSYSTEM_VULN_GATE_MAX_CRITICAL` | `0` | The vulnerability gate a version must pass to be requested (and an anonymous submission to reach moderation): at most this many **fixable** CRITICAL findings (grype reports a fixed version) in its scan. Unfixable findings are shown but don't block |
| `REVIEW_WRITE_RATE_LIMIT_PER_MIN` | `30` | Plugin review writes per minute, per user |
| `REVIEW_ORG_WRITE_RATE_LIMIT_PER_MIN` | `120` | Plugin review writes per minute, per org |
| `REVIEW_IP_DAILY_LIMIT` | `20` | Plugin review writes per day, per source IP |
| `REVIEW_ORG_DAILY_LIMIT` | `20` | Reviews one org may post per day |
| `REVIEW_AUTO_HOLD_REPORTS` | `3` | Distinct abuse reports that automatically hold a review for moderation |

Public directory API tuning (plugin service; all optional):

| Variable | Default | Description |
|----------|---------|-------------|
| `PUBLIC_DIRECTORY_RATE_LIMIT_PER_MIN` | `120` | Requests per minute per trusted client IP on `/api/public/*`. The frontend's server-rendered directory pages call the API from the frontend server, so they share that server's bucket; CDN caching of the pages absorbs most of it. Raise it for a busy self-hosted directory without a CDN |
| `PUBLIC_DIRECTORY_POOL_SIZE` | `4` | Connections per plugin replica in the view-only reader pool. Keep it below pgbouncer's per-user cap for `ecosystem_public_reader` (5) |
| `PUBLIC_DIRECTORY_QUERY_TIMEOUT_MS` | `5000` | Client-side bound on one directory query (pgbouncer's transaction mode can't carry `statement_timeout`) |

## Service Discovery

| Variable | Default | Description |
|----------|---------|-------------|
| `PLUGIN_SERVICE_HOST` | `plugin` | Plugin service hostname |
| `PLUGIN_SERVICE_PORT` | `3000` | Plugin service port |
| `PIPELINE_SERVICE_HOST` | `pipeline` | Pipeline service hostname |
| `PIPELINE_SERVICE_PORT` | `3000` | Pipeline service port |
| `MESSAGE_SERVICE_HOST` | `message` | Message service hostname |
| `MESSAGE_SERVICE_PORT` | `3000` | Message service port |
| `PLATFORM_SERVICE_HOST` | `platform` | Platform service hostname (compliance → email delivery; **every** service → the [access-key exchange](authentication.md#access-keys-opaque-verified-by-exchange)) |
| `PLATFORM_SERVICE_PORT` | `3000` | Platform service port |
| `API_KEY_EXCHANGE_TIMEOUT_MS` | `3000` | Per-request timeout when a service trades an opaque access key for a short-lived token. A timeout answers `503` (never a pass) and increments `api_key_exchange_failures_total{reason="unavailable"}` |
| `COMPLIANCE_SERVICE_HOST` | `compliance` | Compliance service hostname (also billing → compliance entitlement sync) |
| `COMPLIANCE_SERVICE_PORT` | `3000` | Compliance service port |
| `BILLING_SERVICE_HOST` | `billing` | Billing service hostname |
| `BILLING_SERVICE_PORT` | `3000` | Billing service port |
| `QUOTA_SERVICE_HOST` | `quota` | Quota service hostname |
| `QUOTA_SERVICE_PORT` | `3000` | Quota service port |
| `IMAGE_REGISTRY_SERVICE_HOST` | `image-registry` | image-registry API hostname — the plugin worker asks it to sign pushed images (`POST /internal/plugin-signatures`). Not the registry itself (`IMAGE_REGISTRY_HOST`). |
| `IMAGE_REGISTRY_SERVICE_PORT` | `3000` | image-registry API port |
| `REPORTING_SERVICE_HOST` | `reporting` | Reporting service hostname |
| `REPORTING_SERVICE_PORT` | `3000` | Reporting service port |
| `ASK_SERVICE_HOST` | `ask` | Ask (AI assistant) service hostname |
| `ASK_SERVICE_PORT` | `3000` | Ask service port |

Every `<NAME>_SERVICE_HOST` / `<NAME>_SERVICE_PORT` pair follows the same rule: the host defaults to the service name and the port to `3000`.

| Variable | Default | Description |
|----------|---------|-------------|
| `GITHUB_API_BASE_URL` | `https://api.github.com` | GitHub API base for repository analysis (point at a GitHub Enterprise Server `/api/v3`) |
| `BITBUCKET_API_BASE_URL` | `https://api.bitbucket.org/2.0` | Bitbucket API base for repository analysis |

---

## Messaging & Attachments

The message service backs in-app messaging: system announcements (broadcast to every org), org-to-org conversations, support threads, and **per-user direct messages** (a conversation targeted at a single user within the recipient org via `recipientUserId` — only that user, plus the sender org and system org, can see it). Messages may carry file/image **attachments**, stored in S3-compatible object storage (RustFS by default).

| Variable | Default | Description |
|----------|---------|-------------|
| `SUPPORT_ALIASES` | `support@pipeline-builder,help@pipeline-builder` | Comma-separated support inbox aliases. Any of them resolves to the system support org on send; the compose recipient picker lists **all** of them as suggestions (the first is the primary, prefilled default). |
| `S3_ENDPOINT` | `http://rustfs:9000` | S3-compatible endpoint for attachment storage. Empty ⇒ default AWS S3 (no custom endpoint). |
| `S3_BUCKET` | `message-attachments` | Bucket for attachment blobs (auto-created on first upload). |
| `S3_REGION` | `us-east-1` | S3 region. |
| `S3_ACCESS_KEY_ID` | `message-svc` | Per-service, bucket-scoped access key (created by the bootstrap Job — not the object store's root creds). |
| `S3_SECRET_ACCESS_KEY` | `message-svc-secret` | Secret key. **Change for any real deployment.** |
| `S3_FORCE_PATH_STYLE` | `true` | Path-style addressing (required by RustFS; harmless for real S3). |
| `MESSAGE_ATTACHMENT_MAX_MB` | `10` | Max attachment size (MiB). Uploads over this are rejected `413`. |
| `MESSAGE_ATTACHMENT_PENDING_TTL_HOURS` | `24` | Age after which a pending attachment (uploaded but never linked to a message) is reaped with its blob by the retention sweep. Minimum 1. |

> The object store backs more than attachments now: the **container registry** (S3 storage driver), **Loki** (log chunks + index), and **Thanos** (Prometheus long-term blocks) each use their own bucket + a per-service, bucket-scoped key (`registry-svc` / `loki-svc` / `thanos-svc`), all created by the `rustfs-init` bootstrap Job. See **[Deploy Operations → Object storage (RustFS)](deploy-operations.md#object-storage-rustfs)** for the bucket table + HA topology (distributed StatefulSet on EKS, single-node on ec2/minikube/docker).

Attachments are validated against a MIME allow-list (common images + documents; no executables/scripts/HTML). Downloads are auth-gated and inherit the parent message's visibility, so a per-user targeted message's attachment stays private to its target. Blobs are reclaimed when a message is hard-purged by the retention sweep.

---

## Compliance

| Variable | Default | Description |
|----------|---------|-------------|
| `COMPLIANCE_BYPASS` | `false` | Bypass compliance checks when service is unavailable (dev/DR only) |
| `COMPLIANCE_ENABLED` | `true` | Enable compliance enforcement |
| `SCAN_SCHEDULER_INTERVAL_MS` | `60000` | Compliance scan scheduler interval (ms) |
| `SYSTEM_ORG_SCANS_ENABLED` | `false` | Run scheduled scans for the system org too |
| `SCAN_LOCK_TTL_MS` | `300000` | Scan scheduler cross-pod leader-lock TTL (ms); only one replica sweeps per tick |
| `COMPLIANCE_SCAN_STALE_TIMEOUT_MS` | `7200000` | Mark a scan `failed` once it has been `running` this long (min 60000) |
| `DIGEST_SCHEDULER_INTERVAL_MS` | `3600000` | How often the notification digest scheduler checks for due daily/weekly digests (ms) |
| `DIGEST_LOCK_TTL_MS` | `300000` | Digest scheduler cross-pod leader-lock TTL (ms) |

---

## Email

| Variable | Default | Description |
|----------|---------|-------------|
| `EMAIL_ENABLED` | `false` | Enable email sending |
| `EMAIL_FROM` | `noreply@example.com` | Sender address |
| `EMAIL_FROM_NAME` | `pipeline-builder` | Sender display name |
| `EMAIL_PROVIDER` | `smtp` | `smtp` or `ses` |
| `SMTP_HOST` | `localhost` | SMTP host |
| `SMTP_PORT` | `587` | SMTP port |
| `SMTP_SECURE` | `false` | Use TLS |
| `SMTP_USER` | — | SMTP username |
| `SMTP_PASS` | — | SMTP password |

For AWS SES: set `EMAIL_PROVIDER=ses` with `SES_REGION`, `SES_ACCESS_KEY_ID`, `SES_SECRET_ACCESS_KEY`.

---

## Billing

| Variable | Default | Description |
|----------|---------|-------------|
| `BILLING_ENABLED` | `true` | Enable billing (opt-out — on unless set to `false`). When `false`, new orgs default to the uncapped `unlimited` tier and no plans/tiers are offered; when `true`, `unlimited` is hidden and orgs get `DEFAULT_QUOTA_TIER` (default `developer`). |
| `BILLING_PROVIDER` | `stub` | `stub`, `aws-marketplace`, or `stripe` |
| `BILLING_SERVICE_HOST` | `billing` | Service hostname |
| `BILLING_SERVICE_PORT` | `3000` | Service port |
| `BILLING_LIFECYCLE_CHECK_INTERVAL_MS` | `3600000` | Subscription lifecycle check interval (1 hour) |
| `BILLING_USAGE_FALLBACK_DAYS` | `30` | Usage-rollup period for an org with no active subscription (free / unsubscribed): the window spans this many days either side of now, so usage still shows against the tier caps |
| `PAYMENT_GRACE_PERIOD_DAYS` | `7` | Grace period for overdue payments |
| `RENEWAL_REMINDER_DAYS` | `7` | Days before expiry to send renewal reminder |
| `BILLING_BUNDLES_ENABLED` | `false` | Master switch for purchasable [add-on bundles](billing-bundles.md) — hidden unless set |

Plan pricing (`BILLING_PLAN_{TIER}_MONTHLY` / `BILLING_PLAN_{TIER}_ANNUAL`, where `{TIER}` is `DEVELOPER`, `PRO`, `TEAM`, or `ENTERPRISE`) is in cents. Defaults: Developer free, Pro $39/mo ($390/yr), Team $79/mo ($790/yr), Enterprise $599/mo ($5,990/yr). Per-plan `_NAME` (display name), `_DESCRIPTION` (string), and `_FEATURES` (JSON array) can also be overridden.

An `UNLIMITED` plan (free, `BILLING_PLAN_UNLIMITED_NAME` default `Unlimited`) is also seeded so the billing store has a row for orgs on the billing-disabled default tier, but it is filtered out of the customer-facing plans list — it is never sold or shown when billing is enabled.

Add-on bundles are env-tunable (see [Billing Add-on Bundles → Overrides](billing-bundles.md#configuration--overrides)): `BILLING_BUNDLE_<ID>_MONTHLY` / `_ANNUAL` (price, cents), `BILLING_BUNDLE_<ID>_GRANT` (single-dimension grant amount), `BILLING_BUNDLE_<ID>_TIERS` (JSON array of purchasable tiers), and `BILLING_BUNDLE_<ID>_VOLUME_TIERS` (JSON array of `{minQuantity, discountPercent}` for a per-unit volume discount — used by `SEAT`), where `<ID>` is the bundle id upper-cased (`SEAT`, `PIPELINE_PACK`, `PLUGIN_PACK`, `API_PACK`, `AI_PACK`, `STORAGE_PACK`, `RETENTION_PACK`, `DORA_HISTORY_PACK`, `ADVANCED_REPORTING`, `TEAM_USAGE_ANALYTICS`, `COMPLIANCE_STANDARD`, `COMPLIANCE_ADVANCED`). Combo prices are `BILLING_COMBO_<COMBO>_MONTHLY` / `_ANNUAL` where `<COMBO>` is `ANALYTICS_SUITE`, `TEAM_GROWTH`, `COMPLIANCE_SUITE`, or `SCALE_BUNDLE`. The retention packs default to $15/mo ($150/yr, `RETENTION_PACK`) and $30/mo ($300/yr, `DORA_HISTORY_PACK`); under AWS Marketplace they meter as the `RetentionPack` / `DoraHistoryPack` dimensions (see `AWS_MARKETPLACE_BUNDLE_DIMENSION_MAP`).

The compliance content add-ons default to $29.90/mo ($299/yr, `COMPLIANCE_STANDARD`) and $99.90/mo ($999/yr, `COMPLIANCE_ADVANCED`, which requires Standard), with the `COMPLIANCE_SUITE` combo (both, 30% off) at $90.86/mo ($908.60/yr) — see [Compliance → Curated content add-ons](compliance.md#curated-content-add-ons-standard--advanced). On every entitlement change (purchase/cancel/renewal) billing pushes the org's entitled content sets to the compliance service (`PUT /api/compliance/entitlements/:orgId`, which auto-subscribes/activates on gain and deactivates on loss), reaching it via `COMPLIANCE_SERVICE_HOST` / `COMPLIANCE_SERVICE_PORT` (Service Discovery, above).

### Stripe (`BILLING_PROVIDER=stripe`)

Direct SaaS billing through Stripe. For the full setup walkthrough (creating Products/Prices, registering the webhook, testing with the Stripe CLI, going live) see **[Billing Providers → Stripe](billing-providers.md#stripe)**.

| Variable | Default | Description |
|----------|---------|-------------|
| `STRIPE_SECRET_KEY` | — | **Secret.** Stripe API secret key (`sk_test_…` / `sk_live_…`). Required when `BILLING_PROVIDER=stripe` |
| `STRIPE_WEBHOOK_SECRET` | — | **Secret.** Signing secret (`whsec_…`) for `POST /billing/stripe/webhook`; every delivery is signature-verified against it over the raw body |
| `STRIPE_PRICE_MAP` | `{}` | JSON map of `<id>_<interval>` → Stripe Price id, where `<id>` is a plan id **or** an add-on bundle id, e.g. `{"pro_monthly":"price_…","seat_annual":"price_…"}`. A plan/interval absent here cannot be subscribed (creation fails fast); a bundle absent here is granted but its line item is skipped (not charged). Provision every plan + bundle Price once (Stripe Prices are immutable) with `STRIPE_SECRET_KEY=… node api/billing/scripts/provision-stripe-prices.mjs` (add `--dry-run` to preview), then paste its JSON here |

Stripe subscription statuses map to internal statuses via a fixed table (not env-configurable): `unpaid` ⇒ `canceled` (set only after the grace period), unknown ⇒ `incomplete`.

### Discounts

Discount codes + usage credits ([docs/billing-discounts.md](billing-discounts.md)) — Stripe only, on by default.

| Variable | Default | Description |
|----------|---------|-------------|
| `BILLING_DISCOUNTS_ENABLED` | `true` | Master switch — set `false` to 404 the discount routes. Also governs Marketplace metered-credit realization (same value for both providers) |
| `BILLING_DISCOUNT_KEYS` | — | **Secret.** AES-256-GCM signing keys for discount tokens, `v1:<base64-32B>,v2:…`; the highest version mints, older keys still decode (rotation). Required to issue Mode-B tokens |
| `BILLING_DISCOUNT_MAX_PERCENT` | `100` | Mint-time ceiling on a percent discount (1-100) |
| `BILLING_DISCOUNT_MAX_CENTS` | `10000000` | Mint-time ceiling on a dollar/credit discount, in cents ($100k) |
| `BILLING_PROMOTIONS_ENABLED` | `true` | Master switch for [promotions](billing-discounts.md#promotions) (rule-driven auto-grant campaigns). Same opt-out default as `BILLING_DISCOUNTS_ENABLED` (on unless set to `false`). Additionally requires `BILLING_DISCOUNTS_ENABLED` (shared usage-credit machinery), so discounts off ⇒ promotions off; the routes 404 and the auto-grant engine no-ops when off |
| `BILLING_PROMOTION_BACKFILL_INTERVAL_MS` | `3600000` | Backfill-cron cadence (1h). Re-scans eligible-but-ungranted orgs so a transient failure or a late-activated campaign still lands. Leader-locked; idempotent |
| `BILLING_PROMOTION_CLAWBACK_WINDOW_MS` | `604800000` | Clawback window (7d). A promotion grant is reversed (ledger row pulled, balance reduced, budget released) if the subscription cancels within this window of the grant — defuses signup-grab-churn |

`BILLING_DISCOUNT_KEYS` is a secret — provision it via a sealed secret / SSM, never commit a real value. Losing it makes previously issued Mode-B tokens undecodable (already-applied discounts on subscriptions are unaffected).

### AWS Marketplace metering & credit realization

For `BILLING_PROVIDER=aws-marketplace`: add-on charges are reported as metered usage, and usage-credit discounts realize by **withholding** metered units (see [docs/billing-discounts.md](billing-discounts.md#aws-marketplace--private-offers-handled-in-aws-not-in-app)). Metering is **default-off** and the two switches (`BILLING_DISCOUNTS_ENABLED` + `BILLING_METERING_ENABLED`) must both be on before a Marketplace credit is accepted — otherwise a credit would bank but never reduce the AWS bill. For the full listing/fulfillment/SNS/IAM setup walkthrough see **[Billing Providers → AWS Marketplace](billing-providers.md#aws-marketplace)**.

| Variable | Default | Description |
|----------|---------|-------------|
| `BILLING_METERING_ENABLED` | `false` | Run the metering cycle (report add-on usage + realize credits). Off = no metering, and Marketplace credits are rejected |
| `BILLING_METERING_INTERVAL_MS` | `3600000` | Metering cycle cadence (1 hour). AWS `BatchMeterUsage` dedupes by (customer, dimension, hour) |
| `BILLING_METERING_DRAWDOWN_DRYRUN` | `false` | Shadow mode — compute + log the intended credit withholding but report FULL quantities and leave the balance untouched. Validate the price map before going live |
| `AWS_MARKETPLACE_PRODUCT_CODE` | — | The Marketplace product code |
| `AWS_MARKETPLACE_REGION` | `AWS_REGION` or `us-east-1` | Region for the Metering/Entitlement clients |
| `AWS_MARKETPLACE_SNS_TOPIC_ARN` | — | Comma-separated SNS topic ARNs accepted by the webhook — set both the subscription and entitlement topics |
| `AWS_MARKETPLACE_DIMENSION_MAP` | identity | JSON map of Marketplace dimension → local plan id |
| `AWS_MARKETPLACE_BUNDLE_DIMENSION_MAP` | identity | JSON map of add-on bundle id → metered dimension key |
| `AWS_MARKETPLACE_DIMENSION_PRICE_MAP` | `{}` | JSON map of metered dimension → local list price in **cents per metered unit per metering cycle** (cycle = `BILLING_METERING_INTERVAL_MS`). Drives the credit drawdown; an unpriced dimension is never drawn against (reported in full). **A wrong value directly mis-draws credit** — mirror it to your AWS listing and cadence |

> **Money-movement caution:** the credit drawdown is real billing behavior. Keep `BILLING_METERING_ENABLED=false` until `AWS_MARKETPLACE_DIMENSION_PRICE_MAP` is validated (use the dry-run), and note that withholding offsets **metered add-on usage only** — plan-level reductions belong to AWS Marketplace private offers.

---

## Reporting & DORA

Event reporting (`setup-events` → the reporting service) and DORA metrics. All are **optional** — the platform runs on the defaults. DORA metrics sit behind the `advanced_reporting` entitlement; see [DORA Metrics](dora-metrics.md). Retention windows are **tier-aware and bundle-extendable** (effective window = tier baseline + Σ retention-pack grant, computed by billing and synced into `dora_settings`) and additionally **per-organization** overridable via the org's reporting settings; the `REPORTING_*` values below are the deployment-wide fallback used when neither a tier baseline nor an org override applies. The per-tier baselines are set by `QUOTA_TIER_<TIER>_EVENT_RETENTION_DAYS` / `QUOTA_TIER_<TIER>_DORA_RETENTION_DAYS` (see below).

| Variable | Default | Description |
|----------|---------|-------------|
| `PLATFORM_ACCESS_KEY` | — | Set on the **event-ingestion Lambda** (not a service var) to hand it the `reporting:ingest` service-account key directly, skipping the Secrets Manager read. Normally unset: `setup-events` points the Lambda at `PLATFORM_SECRET_NAME` instead, which is also the only form the key ROTATOR can replace — an env-provided key cannot change without a redeploy. A JWT here is refused at startup with the fix named. |
| `PLATFORM_SECRET_NAME` | — | Set on the **event-ingestion Lambda** and the **key-rotation Lambda** (not a service var) to the Secrets Manager secret holding the service-account key in its `password` field (`pipeline-builder/{orgId}/reporting-ingest`). Written by `pipeline-manager infra store-token`; wired by `infra setup-events --scoped-ingest`. |
| `DORA_ENABLED` | `false` | Set on the **event-ingestion Lambda** (not a service var) to enable DORA **lead-time** commit-range resolution in your AWS account (SCM calls + `github-token` read). Toggle via `pipeline-manager infra setup-events --with-dora`, not by hand. Off ⇒ standard reporting still works and DORA lead time reports `unknown`. |
| `DORA_INCIDENT_WINDOW_HOURS` | `24` | Reporting service. Window in which a production **incident** correlates to the most recent deploy (feeds post-deploy CFR / MTTR). Per-org override via `dora_settings`. |
| `REPORTING_RETENTION_ENABLED` | `true` | Master switch for the retention purge sweep. **Set `false` to keep all reporting history forever** — recommended for self-hosted / unlimited-tier deployments that want unbounded retention. |
| `REPORTING_EVENT_RETENTION_DAYS` | `30` | Retention (days) for **standard** pipeline events (non-deploy STAGE / ACTION / build). Older rows are purged by the sweep. Per-org override via `dora_settings`. |
| `REPORTING_DORA_RETENTION_DAYS` | `180` | Retention (days) for **DORA-source** records (deploy-stage events + deployment outcomes + incidents) — ~2 quarters. Per-org override via `dora_settings`. |
| `REPORTING_RETENTION_INTERVAL_HOURS` | `12` | How often the leader-locked retention sweep runs. |
| `ORG_SCORECARD_MAX_PIPELINES` | `50` | Pipeline service. Max pipelines graded in the org-wide scorecard roll-up (`GET /pipelines/scorecard`); the response flags `truncated` past it. Bounds the per-pipeline compliance + DORA cost of one request |
| `ORG_SCORECARD_CONCURRENCY` | `4` | Pipeline service. Per-pipeline scorecard computations run in parallel within one roll-up (bounds load on the compliance service) |

The retention window is a **tier baseline** that add-on retention packs extend. Each tier's baseline is overridable per-environment:

| Variable | Default | Description |
|----------|---------|-------------|
| `QUOTA_TIER_<TIER>_EVENT_RETENTION_DAYS` | `30` (paid tiers) / unlimited on `unlimited` | Per-tier baseline retention (days) for **standard** pipeline events, where `<TIER>` is `DEVELOPER`, `PRO`, `TEAM`, `ENTERPRISE`, or `UNLIMITED`. The `unlimited` tier derives `-1` (unlimited — the sweep skips the org and keeps all history). The **Standard Retention Pack** add-on adds +90 days on top. |
| `QUOTA_TIER_<TIER>_DORA_RETENTION_DAYS` | `180` (paid tiers) / unlimited on `unlimited` | Per-tier baseline retention (days) for **DORA-source** records. The `unlimited` tier derives `-1`. The **DORA History Pack** add-on adds +365 days on top (and widens the report-query window to match). |

Billing computes the effective window (`tierBase + Σ pack grant`, `-1` = unlimited passthrough) and pushes it to the reporting service (`PUT /api/reports/retention-sync/:orgId`, writing `dora_settings`). The per-org report-query window tracks this effective retention (`min(730, orgRetentionDays)`, absolute ceiling **730 days**); an unlimited-tier org queries up to the 730-day ceiling.

---

## AWS CDK / Lambda

| Variable | Default | Description |
|----------|---------|-------------|
| `LAMBDA_RUNTIME` | `nodejs24.x` | Lambda runtime |
| `LAMBDA_TIMEOUT` | `900` | Timeout (seconds) |
| `LAMBDA_MEMORY_SIZE` | `512` | Memory (MB) |
| `LAMBDA_ARCHITECTURE` | `ARM_64` | Plugin-lookup Lambda architecture: `ARM_64` or `x86_64` |
| `LAMBDA_RESERVED_CONCURRENCY` | — | Reserved concurrency for the plugin-lookup Lambda; unset → unreserved |
| `CODEBUILD_COMPUTE_TYPE` | `SMALL` | `SMALL`, `MEDIUM`, `LARGE`, `X2_LARGE` |
| `CODEBUILD_DEFAULT_IMAGE` | `pipeline-bootstrap:1.0` | Image for the synth (bootstrap) CodeBuild step; must have `pipeline-manager` on PATH |
| `LOG_GROUP_NAME` | `/pipeline-builder/logs` | CloudWatch log group |
| `SECRETS_PATH_PREFIX` | `pipeline-builder` | AWS Secrets Manager path prefix |

---

## Scaling & multi-replica (Optional)

All optional (defaults shown). They tune behavior that matters only under horizontal scaling (>1 replica) or high load.

> **Redis is required for multi-replica correctness.** OAuth/SSO login CSRF `state` + nonce, SSE build-log delivery, the message service's SSE notification tickets (minted on one pod, redeemed on another), keyed-mutation idempotency (e.g. `POST /messages`), step-up single-use tokens, and the background sweep leader locks (org-purge, invitation-reaper, billing-reconcile, registry GC) all use the shared Redis when running with more than one replica. Without Redis they degrade to **per-pod** behavior, which is correct only on a single replica — e.g. round-robin between replicas would fail OAuth/SSO logins (`state`/`nonce` minted on one pod, validated on another), reject valid message-notification SSE connections (ticket minted on pod A, redeemed on pod B), and drop live build-log lines.

| Variable | Default | Description |
|----------|---------|-------------|
| `PIPELINE_EXEC_IDEMPOTENCY_WINDOW_SECONDS` | `60` | Window for the execution-trigger idempotency guard — a duplicate `POST /pipelines/:id/executions` within it is a no-op, not a second CodePipeline run |
| `BILLING_WEBHOOK_INPROGRESS_TTL_SECONDS` | `300` | Webhook in-progress lock TTL — a crash mid-processing releases the claim after this so the provider's retry re-runs the event's side-effects (not dropped as a duplicate) |
| `COMPLIANCE_VALIDATE_TIMEOUT_MS` | `4000` | Per-attempt timeout for the fail-closed compliance validate call (now retried, so a transient blip doesn't reject a legit upload/create) |
| `HTTP_CLIENT_MAX_SOCKETS` | `64` | Max sockets per internal HTTP keep-alive agent (was unbounded) |
| `HTTP_CLIENT_MAX_RESPONSE_BYTES` | `10485760` | Cap on an internal HTTP response body (10 MiB); a larger body aborts the call instead of being buffered |
| `IDEMPOTENCY_TTL_MS` | `300000` | How long a completed `Idempotency-Key` response is replayed |
| `IDEMPOTENCY_MAX_STORE_SIZE` | `10000` | Max keys in the per-process (no-Redis) idempotency store |
| `IDEMPOTENCY_CLEANUP_INTERVAL_MS` | `60000` | Sweep interval for expired keys in the per-process idempotency store |
| `IDEMPOTENCY_PENDING_TTL_MS` | `120000` | How long an in-flight `Idempotency-Key` reservation holds the key if the process dies mid-request (retries get 409 until then). Must exceed the slowest handler; a client disconnect no longer releases the key — the handler's own result settles it |
| `REGISTRY_GC_LOCK_TTL_MS` | `900000` | Image-registry GC leader-lock TTL (ms); only one replica runs the destructive GC sweep at a time |

---

## Timeouts

| Variable | Default | Description |
|----------|---------|-------------|
| `HANDLER_TIMEOUT_MS` | `25000` | Global HTTP request timeout (25s) |
| `PLUGIN_UPLOAD_TIMEOUT_MS` | `300000` | Upload route timeout override (5 min) |
| `DOCKER_BUILD_TIMEOUT_MS` | `900000` | Docker build timeout (15 min) |
| `DOCKER_PUSH_TIMEOUT_MS` | `300000` | Docker push timeout (5 min) |
| `HTTP_CLIENT_TIMEOUT` | `5000` | Internal HTTP client timeout — a TOTAL deadline for the whole exchange (connect, send, full body), not just socket idle |
| `HTTP_CLIENT_MAX_RETRIES` | `2` | Internal HTTP client retries |
| `HTTP_CLIENT_RETRY_DELAY_MS` | `200` | Internal HTTP client retry delay |
| `REPORTING_HTTP_TIMEOUT` | `3000` | Timeout (ms) for reporting's outbound org-hierarchy lookups to platform. Deliberately TIGHTER than `HTTP_CLIENT_TIMEOUT`: a report that degrades fast beats a dashboard that hangs |
| `REGISTRY_HTTP_TIMEOUT` | `30000` | Timeout (ms) for image-registry's management calls to the upstream OCI registry. Deliberately LONGER than `HTTP_CLIENT_TIMEOUT` because catalog, manifest and blob operations are slow |
| `QUOTA_SERVICE_TIMEOUT` | `5000` | Quota service call timeout |
| `BILLING_SERVICE_TIMEOUT` | `5000` | Billing service call timeout |
| `PIPELINE_PLUGIN_SERVICE_TIMEOUT_MS` | `30000` | Timeout (ms) for the pipeline service's calls into the plugin service — long because a plugin upload response includes build-queue results |

### Plugin Upload Timeout Chain

When uploading a large plugin ZIP (up to 4GB with prebuilt image.tar), the request passes through multiple timeout layers. Each layer must allow enough time for the upload to complete:

```
Client (curl)                    UPLOAD_TIMEOUT = 900s (15 min)
  └─ nginx proxy_read_timeout    900s (shipped configs); nginx's own default is 60s
      └─ Express route           PLUGIN_UPLOAD_TIMEOUT_MS = 300s (5 min)
          └─ Express global      HANDLER_TIMEOUT_MS = 25s (overridden by route)
              └─ Build queue     DOCKER_BUILD_TIMEOUT_MS = 900s (15 min, async)
                  └─ Push        DOCKER_PUSH_TIMEOUT_MS = 300s (5 min, async)
```

The upload request returns `202 Accepted` after the ZIP is parsed and the build job is enqueued. The Docker build and push happen asynchronously in the build queue — their timeouts do not affect the upload response.

**If uploads fail with 503 (timeout):** Increase `PLUGIN_UPLOAD_TIMEOUT_MS` and ensure nginx `proxy_read_timeout` is at least as long (the shipped nginx configs already set it to `900s` for the upload route). Do not increase `HANDLER_TIMEOUT_MS` — it applies globally to all routes.

---

## Caching

| Variable | Default | Description |
|----------|---------|-------------|
| `CACHE_TTL_ENTITY` | `60` | Entity cache TTL (seconds) |
| `CACHE_TTL_MESSAGE` | `300` | Message cache TTL (seconds) |
| `CACHE_TTL_REPORT_INVENTORY` | `300` | Report inventory cache TTL (seconds) |
| `CACHE_TTL_REPORT_TIMESERIES` | `120` | Report timeseries cache TTL (seconds) |
| `CACHE_TTL_COMPLIANCE_RULES` | `60` | Compliance rules cache TTL (seconds) |
| `CACHE_TTL_BILLING_PLANS` | `14400` | Billing plans cache TTL (4 hours) |
| `CACHE_CONTROL_LIST` | `private, max-age=30, stale-while-revalidate=60` | `Cache-Control` header on list responses |
| `CACHE_CONTROL_DETAIL` | `private, max-age=60, stale-while-revalidate=120` | `Cache-Control` header on single-entity responses |
| `COMPRESSION_THRESHOLD_BYTES` | `1024` | Responses smaller than this are sent uncompressed |

---

## Server-Sent Events

| Variable | Default | Description |
|----------|---------|-------------|
| `SSE_MAX_CLIENTS_PER_REQUEST` | `10` | Max SSE clients per request ID |
| `SSE_CLIENT_TIMEOUT_MS` | `1800000` | SSE client timeout (30 min) |
| `SSE_CLEANUP_INTERVAL_MS` | `300000` | SSE cleanup interval (5 min) |
| `SSE_STREAM_TIMEOUT_MS` | `300000` | SSE stream timeout (5 min) |
| `SSE_BACKPRESSURE_THRESHOLD` | `10` | SSE backpressure threshold |
| `SSE_MAX_TOTAL_TICKETS` | `1000` | Cap on live SSE tickets across all orgs, per ticket channel (message notifications, reporting execution status, build-log streams; Redis-backed when configured; abuse bound) |
| `SSE_MAX_TICKETS_PER_ORG` | `10` | Per-org cap on live SSE tickets, per ticket channel |
| `SSE_MAX_TOTAL_CLIENTS` | `1000` | Per-process cap on live SSE connections; new connections beyond it get 429 |
| `SSE_MAX_CLIENTS_PER_ORG` | `50` | Per-process, per-org cap on live SSE connections, so one noisy org can't consume the whole pool |

---

## Observability & Logs

| Variable | Default | Description |
|----------|---------|-------------|
| `PROMETHEUS_URL` | `http://prometheus:9090` | Metrics backend for the native dashboards |
| `LOKI_URL` | `http://loki:3100` | Log backend for **Deliver → Logs**. Platform sends `X-Scope-OrgID` per request, derived from the caller's verified token |
| `LOKI_BASE_SELECTOR` | `service_name=~".+"` | Anchor matcher used when a log query constrains no label. Override on a deployment whose non-JSON producers people need to browse |
| `METRICS_SCRAPE_TOKEN` | — | When set, every service's `/metrics` requires `Authorization: Bearer <token>` (Prometheus `bearer_token_file`). Unset → `/metrics` is ungated |
| `HTTP_METRICS_ORG_SAMPLE_RATE` | `0` | Sample rate (0–1) for the per-org `http_requests_by_org_total` counter. Off by default: `org_id` is an unbounded, tenant-identifying label, so enable it deliberately and set `METRICS_SCRAPE_TOKEN` too |
| `OTEL_TRACING_ENABLED` | `false` | Export OpenTelemetry traces |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318/v1/traces` | OTLP/HTTP trace collector endpoint |

Loki itself runs with `auth_enabled: true` so each organization is a tenant —
see [Logs: Operating](observability-logs.md#operating) for the Loki-side
settings that go with it.

---

## Admin UIs (Infrastructure)

These variables configure infrastructure admin tools, not application code.

| Variable | Default | Description |
|----------|---------|-------------|
| `PGADMIN_DEFAULT_EMAIL` | `admin@pipeline.dev` | pgAdmin login email |
| `PGADMIN_DEFAULT_PASSWORD` | — | pgAdmin login password |
| `ME_CONFIG_BASICAUTH_USERNAME` | `admin` | Mongo Express username |
| `ME_CONFIG_BASICAUTH_PASSWORD` | — | Mongo Express password |
| `ADMIN_UIS_ENABLED` | `false` | **AWS targets (eks, ec2).** Serve `/pgadmin/`, `/mongo-express/`, `/grafana/`, `/kiali/` through the gateway. Off by default — the routes 404. When `true`, every request to them first passes an nginx `auth_request` to platform `GET /admin/console-check` (a live session of a platform administrator at AAL2), with the token taken from the `pb_admin_console` cookie and stripped before the console sees the request. |

---

## Pagination & Limits

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_PAGE_LIMIT` | `1000` | Max page size |
| `DEFAULT_PAGE_LIMIT` | `100` | Default page size |
| `MAX_PROMPT_LENGTH` | `5000` | Max AI prompt length |
| `MAX_BULK_ITEMS` | `100` | Max items per bulk operation |
| `MAX_EVENTS_PER_BATCH` | `100` | Max events per batch ingestion |
| `PIPELINE_NAME_MAX_LENGTH` | `100` | Max pipeline name length |
| `DEFAULT_PLUGIN_VERSION` | `1.0.0` | Version assigned to a plugin uploaded without one |
| `INVITATION_EXPIRATION_DAYS` | `7` | Org invitation expiry |
| `INVITATION_MAX_PENDING_PER_ORG` | `50` | Max pending invitations per org |

---

## AI Providers (Optional)

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `OPENAI_API_KEY` | OpenAI API key |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Google AI API key |
| `XAI_API_KEY` | xAI API key |
| `AI_PROVIDER` | (CLI `infra provision`) Provider to use: `anthropic` (default), `openai`, `google`, `xai`, `bedrock` |
| `AI_MODEL` | (CLI `infra provision`) Model id override (defaults to the provider's first model) |

At least one provider key is required for AI-powered pipeline and plugin generation. The same keys (plus the optional `AI_PROVIDER` / `AI_MODEL`) enable the `pipeline-manager infra provision` advisor's natural-language goal parsing and failure diagnosis; without a key, `infra provision` falls back to its deterministic prereq-check + command-assembly path. See the [AI plugins documentation](plugins/ai.md) for supported providers and models.

### Self-hosted / local model (OpenAI-compatible)

Point the provider registry at any OpenAI-compatible endpoint — a **Docker model image** (Ollama, Docker Model Runner, vLLM) or another self-hosted server — instead of, or in addition to, the cloud providers above. The provider id is `openai-compatible`; it registers only when a base URL is set, and its model list is deployment-defined (not part of the static catalog).

| Variable | Description |
|----------|-------------|
| `OPENAI_COMPATIBLE_BASE_URL` | Endpoint that speaks the OpenAI chat API, e.g. `http://ask-model:11434/v1`. **Setting this enables the `openai-compatible` provider.** |
| `OPENAI_COMPATIBLE_MODELS` | Comma-separated model list the endpoint serves, each `id[|Display Name]` (e.g. `qwen2.5-coder:7b|Qwen 2.5 Coder, llama3.1:8b`). |
| `OPENAI_COMPATIBLE_MODEL` | Single-model fallback used when `OPENAI_COMPATIBLE_MODELS` is unset. Defaults to `local|Local model`. |
| `OPENAI_COMPATIBLE_NAME` | Display name for the provider (defaults to `Local model (OpenAI-compatible)`). |
| `OPENAI_COMPATIBLE_API_KEY` | Optional. Most local servers ignore it; a placeholder is sent when unset. |

The deploy targets ship an **Ollama model container** you can use instead of running your own endpoint. How it is enabled differs per target:
- **aws/ec2, aws/eks** (`deploy/aws/{ec2,eks}/k8s/ask-model.yaml`) — deployed **by default** (listed in `kustomization.yaml`), with `OPENAI_COMPATIBLE_BASE_URL=http://ask-model:11434/v1` + `OPENAI_COMPATIBLE_MODELS=qwen2.5-coder:7b|Qwen 2.5 Coder` already set on the `ask` Deployment. A 7B tool-capable model needs ~6–8Gi RAM (CPU) or a GPU (uncomment the nodeSelector/tolerations + `nvidia.com/gpu` limit). On ec2, `LEAN=1` drops it — at 6Gi it does not fit the t3.xlarge that LEAN targets — along with the `ask` env that points at it.
- **local/minikube** — opt-in, because a 6Gi request will not schedule on a laptop-sized VM: `ASK_MODEL=1 deploy/local/minikube/bin/setup.sh` (or the same flag on `startup.sh` for an already-provisioned cluster) applies the manifest *and* wires the two env vars into the `app-env` ConfigMap. The minikube copy runs the 1.5B at a 1536Mi request.
- **local/docker** (`deploy/local/docker/docker-compose.yml`) — behind the `ask-model` compose profile: `docker compose --profile ask-model up -d`, then uncomment `OPENAI_COMPATIBLE_BASE_URL`/`OPENAI_COMPATIBLE_MODELS` in `.env` and `docker compose up -d ask` so the change reaches the service.

Override the served model with `OLLAMA_MODEL` (default `qwen2.5-coder:7b`). It must name the same model `OPENAI_COMPATIBLE_MODELS` advertises — advertising one the container has not pulled sends the request to a server that has never heard of it, which closes the connection mid-stream (`AI_APICallError: Cannot connect to API: other side closed`). Guarding that is why the workload is held **NotReady/unhealthy** until `ollama list` actually shows the model (a `startupProbe` in k8s, a healthcheck on docker) rather than merely until the server is listening. Model weights persist on the `ask-model-models` volume/PVC.

---

## Operational Tuning

Lower-level knobs read through api-core's shared env readers (`envInt` / `envBool` / `envStr`). Every one has a working default — set them only when you are deliberately tuning a deployment. A test (`packages/api-core/test/env-documented.test.ts`) fails the build if a variable is read through those readers and is not listed somewhere in this document, so this section cannot silently fall behind the code.

### Alerts & notifications

| Variable | Default | Description |
|----------|---------|-------------|
| `ALERTMANAGER_URL` | `http://alertmanager:9093` | In-cluster Alertmanager base URL the platform queries for live alerts |
| `ALERTMANAGER_TIMEOUT_MS` | `5000` | Per-request timeout for Alertmanager queries |
| `ALERT_DELIVERY_TIMEOUT_MS` | `5000` | Bounded timeout for one alert-destination delivery (and for a manual test send) |
| `ALERT_EMAIL_DEDUPE_TTL_MS` | `600000` | At-least-once dedupe window for alert email. Alertmanager retries its webhook, so an identical (alert, recipient) inside this window is suppressed |
| `ALERT_DESTINATION_MAX_LABEL` | `100` | Max characters in an alert destination's label |
| `ALERT_DESTINATION_MAX_TARGET` | `2048` | Max characters in an alert destination's target (webhook URL / email address) |
| `ALERT_WEBHOOK_LIMITER_MAX` | `3000` | Requests per window allowed on the Alertmanager relay endpoint. Sized for a burst fan-out, not for human traffic |
| `ALERT_WEBHOOK_LIMITER_WINDOWMS` | `60000` | Rate-limit window for the Alertmanager relay endpoint |
| `OBSERVABILITY_LIMITER_MAX` | `120` | Requests per window on the observability query endpoints (PromQL, logs) |
| `OBSERVABILITY_LIMITER_WINDOWMS` | `60000` | Rate-limit window for the observability query endpoints |
| `PLATFORM_SCRAPER_INTERVAL_MS` | `60000` | Interval for the platform's own metrics scrape loop |
| `READINESS_MONITOR_INTERVAL_MS` | `15000` | Interval at which a service re-probes its dependencies for the readiness endpoint |
| `SHUTDOWN_TIMEOUT_MS` | `15000` | Grace period for in-flight requests during coordinated shutdown before the process exits |

### Auth, sessions & audit

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTH_VERIFICATION_TOKEN_TTL_MS` | `86400000` | Lifetime of an email-verification / password-reset token (24h) |
| `SESSION_REVOCATION_TTL_SECONDS` | `3600` | How long a published `tokenVersion` bump is retained in Redis. Must exceed the access-token lifetime or a revocation can lapse before the token it revokes |
| `AUDIT_RETENTION_DAYS` | `90` | Retention for platform audit events. Drives the Mongo TTL index |
| `MONGO_MAX_POOL` | `20` | Mongo connection-pool ceiling |
| `MONGO_MIN_POOL` | `2` | Mongo connection-pool floor |
| `MONGO_SERVER_SELECTION_MS` | `5000` | Mongo server-selection timeout |

### Org lifecycle & invitations

| Variable | Default | Description |
|----------|---------|-------------|
| `INVITATION_SWEEP_INTERVAL_MS` | `3600000` | Interval of the expired-invitation reaper (leader-locked) |
| `ORG_DELETION_RETENTION_DAYS` | `7` | Grace period between a soft-deleted org and its hard purge |
| `ORG_PURGE_SWEEP_INTERVAL_MS` | `3600000` | Interval of the org-purge sweep (leader-locked) |
| `ORG_CASCADE_HTTP_TIMEOUT_MS` | `5000` | Per-service timeout for an org-cascade (delete/suspend) fan-out call |
| `DOMAIN_REVERIFY_INTERVAL_MS` | `86400000` | Interval of the domain-ownership re-verification sweep |
| `DOMAIN_REVERIFY_STALE_MS` | `604800000` | Age at which a verified domain is re-checked (7 days) |

### Billing reconciliation

| Variable | Default | Description |
|----------|---------|-------------|
| `BILLING_PROVISION_RETRY_ATTEMPTS` | `3` | Retries when provisioning a subscription against the billing service |
| `BILLING_PROVISION_RETRY_BASE_MS` | `200` | Base backoff between provisioning retries (exponential) |
| `BILLING_RECONCILE_INTERVAL_MS` | `300000` | Interval of the billing↔org entitlement drift reconciler |
| `BILLING_RECONCILE_BATCH_SIZE` | `50` | Orgs compared per reconciler tick |
| `BILLING_RECONCILE_JITTER_MS` | `250` | Random delay between reconciler batches, so replicas don't burst together |
| `BILLING_ENTITLEMENT_DRIFT_INTERVAL_MS` | `900000` | Interval of the billing service's own entitlement-drift sweep |
| `BILLING_ENTITLEMENT_DRIFT_MAX_PER_TICK` | `200` | Subscriptions examined per entitlement-drift tick |

### Compliance

| Variable | Default | Description |
|----------|---------|-------------|
| `COMPLIANCE_MAX_REGEX_LENGTH` | `100` | Max length of a rule-authored regex pattern. Authoring hygiene — it is **not** the ReDoS bound |
| `COMPLIANCE_REGEX_TIMEOUT_MS` | `50` | **Hard** wall-clock deadline for one rule-authored regex match. A match that exceeds it is aborted and treated as a violation (fail-closed) |
| `COMPLIANCE_NOTIFY_TIMEOUT_MS` | `5000` | Per-channel timeout for a compliance notification delivery |
| `COMPLIANCE_AUDIT_RETENTION_DAYS` | `180` | Retention for compliance check-log rows |
| `COMPLIANCE_MAX_ATTRIBUTE_DEPTH` | `10` | Max nesting depth of a validation request's attribute object |
| `COMPLIANCE_MAX_ATTRIBUTE_KEYS` | `100` | Max keys in a validation request's attribute object |
| `COMPLIANCE_SCAN_CONCURRENCY` | `10` | Entities evaluated in parallel during a compliance scan |
| `COMPLIANCE_SCAN_ENTITY_PAGE_SIZE` | `1000` | Rows read per page while enumerating scan targets |
| `COMPLIANCE_SCAN_ENTITY_MAX_TOTAL` | `100000` | Hard ceiling on entities examined by one scan |
| `COMPLIANCE_SCAN_PROGRESS_BATCH_SIZE` | `10` | Entities processed between scan-progress writes |
| `COMPLIANCE_SERVICE_TIMEOUT` | `5000` | Platform's timeout when calling the compliance service |
| `MESSAGE_SERVICE_TIMEOUT` | `5000` | Platform's timeout when calling the message service |

### Quotas

| Variable | Default | Description |
|----------|---------|-------------|
| `QUOTA_TIER_DEVELOPER_LABEL` | `Developer` | Display label for the developer tier |
| `QUOTA_TIER_PRO_LABEL` | `Pro` | Display label for the pro tier |
| `QUOTA_TIER_TEAM_LABEL` | `Team` | Display label for the team tier |
| `QUOTA_TIER_ENTERPRISE_LABEL` | `Enterprise` | Display label for the enterprise tier |
| `QUOTA_DEFAULT_DASHBOARDS` | developer-tier value | Dashboard limit for an org with no tier resolved |
| `QUOTA_DEFAULT_ALERT_RULES` | developer-tier value | Alert-rule limit for an org with no tier resolved |
| `QUOTA_DEFAULT_ALERT_DESTINATIONS` | developer-tier value | Alert-destination limit for an org with no tier resolved |
| `QUOTA_DEFAULT_IDP_CONFIGS` | developer-tier value | IdP-config limit for an org with no tier resolved |
| `QUOTA_DEFAULT_LISTINGS` | developer-tier value | Plugin-ecosystem listing limit for an org with no tier resolved |
| `QUOTA_DEFAULT_STORAGE_BYTES` | developer-tier value | Registry-storage limit for an org with no tier resolved |
| `QUOTA_AT_RISK_CACHE_TTL_MS` | `60000` | TTL of the "orgs near their limit" summary cache |
| `QUOTA_POOL_FALLBACK_TTL_MS` | `60000` | TTL of the cached pooled-root fallback used when the hierarchy lookup fails |

### Dashboards

| Variable | Default | Description |
|----------|---------|-------------|
| `DASHBOARD_MAX_NAME` | `150` | Max characters in a dashboard name |
| `DASHBOARD_MAX_DESCRIPTION` | `1000` | Max characters in a dashboard description |
| `DASHBOARD_MAX_PANELS` | `50` | Max panels in one dashboard |
| `DASHBOARD_MAX_PANEL_TITLE` | `200` | Max characters in a panel title |

### Plugin upload safety

| Variable | Default | Description |
|----------|---------|-------------|
| `PLUGIN_MAX_EXTRACT_ENTRIES` | `10000` | Max entries extracted from an uploaded plugin archive (zip-bomb guard) |
| `PLUGIN_MAX_EXTRACT_RATIO` | `50` | Max uncompressed:compressed ratio allowed for an uploaded archive |
| `PLUGIN_MAX_EXTRACT_BYTES` | upload cap × ratio | Absolute ceiling on bytes extracted from one archive |
| `PLUGIN_MAX_YAML_BYTES` | `1048576` | Max size (bytes, 1 MiB) of a plugin's `config.yaml` / `plugin-spec.yaml`, checked before parsing (oversized-input / billion-laughs guard) |

### Reporting retention

| Variable | Default | Description |
|----------|---------|-------------|
| `REPORTING_RETENTION_STARTUP_DELAY_MS` | `120000` | Delay before the first retention sweep after boot |
| `REPORTING_RETENTION_LOCK_TTL_MS` | `1800000` | Leader-lock TTL held while a retention sweep runs |
| `REPORTING_RETENTION_BATCH_SIZE` | `1000` | Rows deleted per retention batch |
| `REPORTING_RETENTION_MAX_BATCHES` | `50` | Max batches per table per sweep, so one sweep can't run unbounded |

### Service-to-service resilience

| Variable | Default | Description |
|----------|---------|-------------|
| `S2S_BREAKER_ENABLED` | `true` | Enable the service-to-service circuit breaker |
| `S2S_BREAKER_THRESHOLD` | `5` | Consecutive failures before the breaker opens for a peer |
| `S2S_BREAKER_COOLDOWN_MS` | `10000` | How long the breaker stays open before a trial request |
| `ASK_HTTP_TIMEOUT_MS` | `30000` | Timeout for the ask service's internal HTTP calls (long because answers stream) |
| `ASK_MAX_OUTPUT_TOKENS` | `2048` | Cap on the tokens one Ask answer may generate (min 64) — bounds the cost and latency of a single turn |
| `MAX_PAGE_OFFSET` | `100000` | Hard ceiling on `?offset=` across paginated endpoints — bounds a deep-paging scan |
