// GENERATED FROM docs/environment-variables.md — DO NOT EDIT.
// Regenerate: npm run generate:help  (see frontend/scripts/generate-help.mjs)
// SPDX-License-Identifier: Apache-2.0
import { FileCode } from 'lucide-react';
import type { HelpTopic } from '../types';

export const envVariablesTopic: HelpTopic = {
  "icon": FileCode,
  "id": "env-variables",
  "title": "Environment Variables",
  "description": "Configuration reference for all services",
  "sections": [
    {
      "id": "overview",
      "title": "Overview",
      "blocks": [
        {
          "type": "text",
          "content": "Complete reference for all environment variables used across Pipeline Builder services. Each variable can be set in your .env file or passed directly via your deployment configuration (Docker Compose, Kubernetes ConfigMap, ECS task definition)."
        },
        {
          "type": "text",
          "content": "Quick setup: Each deploy target ships its own template (deploy/local/docker/.env.example, deploy/local/minikube/.env.example, deploy/aws/ec2/.env.example, deploy/aws/eks/.env.example). Copy the one for your target to .env and fill in the required secrets."
        },
        {
          "type": "note",
          "content": "Security: Generate JWT secrets with openssl rand -base64 32. Never commit .env files to version control."
        },
        {
          "type": "text",
          "content": "Related docs: AWS Deployment | API Reference"
        }
      ]
    },
    {
      "id": "overview",
      "title": "Overview",
      "blocks": [
        {
          "type": "text",
          "content": "This reference documents every environment variable across the Pipeline Builder services, grouped by concern (core, authentication, databases, plugin builds, quotas, compliance, email, billing, AWS/Lambda, timeouts, caching, and more) with each variable's default and effect. It's for anyone deploying or operating the platform; pair it with the per-target .env.example templates noted above and set only what your target needs. Defaults mirror the code, and feature switches are called out where they interact — for example the billing master switch BILLING_DISCOUNTS_ENABLED and the per-tier QUOTA_TIER_* / JWT_EXPIRES_IN_* overrides. Use the Table of Contents below to jump to a section."
        }
      ]
    },
    {
      "id": "table-of-contents",
      "title": "Table of Contents",
      "blocks": [
        {
          "type": "list",
          "items": [
            "Core -- Server basics (port, logging, URLs)",
            "Authentication -- JWT, OAuth, passkeys, password policy",
            "Databases -- PostgreSQL, MongoDB, Redis",
            "Docker Registry -- Image registry for plugin builds",
            "Plugin Builds -- buildkit sidecar, queue config",
            "Quotas & Rate Limiting -- Per-org resource limits",
            "Service Discovery -- Inter-service hostnames and ports",
            "Compliance -- Compliance bypass and scan scheduling",
            "Email -- SMTP and SES configuration",
            "Billing -- Subscription billing provider",
            "Reporting & DORA -- Event reporting, DORA metrics, retention",
            "AWS CDK / Lambda -- Lambda runtime, CodeBuild compute",
            "Timeouts -- Request, build, and connection timeouts",
            "Caching -- Response and entity cache TTLs",
            "SSE -- Server-sent events configuration",
            "Admin UIs -- pgAdmin, Mongo Express credentials",
            "Pagination & Limits -- API response limits",
            "AI Providers -- API keys for AI-powered generation"
          ]
        }
      ]
    },
    {
      "id": "core",
      "title": "Core",
      "blocks": [
        {
          "type": "table",
          "headers": [
            "Variable",
            "Default",
            "Description"
          ],
          "rows": [
            [
              "PLATFORM_BASE_URL",
              "https://localhost:8443",
              "API gateway URL"
            ],
            [
              "PLATFORM_FRONTEND_URL",
              "https://localhost:8443",
              "Frontend URL (email links, OAuth redirects)"
            ],
            [
              "DEPLOY_TARGET",
              "local",
              "Deployment target (aws-ec2, aws-eks, local, docker, minikube). Served by the platform /config endpoint at runtime (the frontend is one shared prebuilt image, so this is NOT a NEXT_PUBLIC_* build-time inline); the onboarding CLI-setup step shows the AWS-only store-token/setup-events section only on the AWS targets"
            ],
            [
              "PORT",
              "3000",
              "Service listen port"
            ],
            [
              "TRUST_PROXY",
              "1",
              "Trust proxy headers (behind nginx/ALB)"
            ],
            [
              "LOG_LEVEL",
              "info",
              "error, warn, info, debug"
            ],
            [
              "LOG_FORMAT",
              "json",
              "json (structured) or text (human-readable)"
            ],
            [
              "SERVICE_NAME",
              "api",
              "Service name in logs"
            ],
            [
              "CORS_CREDENTIALS",
              "true",
              "Allow credentials in CORS requests"
            ],
            [
              "CORS_ORIGIN",
              "—",
              "CORS allowed origins (optional)"
            ],
            [
              "SYSTEM_ORG_ID",
              "000000000000000000000001",
              "ObjectId of the well-known system tenant (the org with slug:'system' + isSystem:true). Lowercased at module load and compared case-insensitively. If you override it, you must mirror the new value in the Postgres RLS policy (deploy/**/postgres-init.sql hardcodes 000000000000000000000001 as the always-visible system org), or system-org content becomes invisible to other orgs."
            ]
          ]
        }
      ]
    },
    {
      "id": "authentication",
      "title": "Authentication",
      "blocks": [
        {
          "type": "table",
          "headers": [
            "Variable",
            "Default",
            "Description"
          ],
          "rows": [
            [
              "SERVICE_SIGNING_KEY_FILE",
              "—",
              "Required. Path to THIS service's EC P-256 private key (PKCS#8 PEM) for INTERNAL service-to-service tokens. Different on every service — mounted read-only into that service alone, which is what stops a compromised workload signing as another. Generated by deploy/bin/service-signing-keys.sh; a service refuses to start without it."
            ],
            [
              "SERVICE_KEY_BUNDLE_FILE",
              "—",
              "Required. Path to the PUBLIC per-service key bundle ({\"services\": {\"<name>\": {\"keys\": [<jwk>…]}}}), used to verify peers' tokens. Identical on every service and public — it holds no private material. A token's kid selects the key AND names its owner, and the token's sub must agree, so one service can never speak for another. Re-read on change (mtime) and at least every 5 minutes, so a key rotation needs no restart."
            ],
            [
              "JWT_EXPIRES_IN",
              "900",
              "Access-token TTL in seconds (15 min) at the platform auth issuer — deliberately short so privilege changes take effect quickly (paired with tokenVersion revocation). Per-tier overrides take precedence. (The generic pipeline-core server scaffold falls back to 7200 where it isn't the token issuer.)"
            ],
            [
              "JWT_EXPIRES_IN_DEVELOPER",
              "(inherits JWT_EXPIRES_IN)",
              "Developer-tier access-token TTL override"
            ],
            [
              "JWT_EXPIRES_IN_PRO",
              "(inherits JWT_EXPIRES_IN)",
              "Pro-tier override — commonly shorter for compliance"
            ],
            [
              "JWT_EXPIRES_IN_TEAM",
              "(inherits JWT_EXPIRES_IN)",
              "Team-tier override"
            ],
            [
              "JWT_EXPIRES_IN_ENTERPRISE",
              "(inherits JWT_EXPIRES_IN)",
              "Enterprise-tier override (e.g. 1800 = 30 min)"
            ],
            [
              "JWT_EXPIRES_IN_UNLIMITED",
              "(inherits JWT_EXPIRES_IN)",
              "Unlimited-tier override (billing-disabled default tier)"
            ],
            [
              "JWT_ISSUER",
              "—",
              "When set, platform stamps it on every token it signs and every service rejects tokens without it. Applies to both chains. Set on all services at once."
            ],
            [
              "JWT_AUDIENCE",
              "—",
              "Same as JWT_ISSUER, for the aud claim."
            ],
            [
              "BCRYPT_SALT_ROUNDS",
              "12",
              "bcrypt cost factor for password hashing (10-12 recommended)."
            ],
            [
              "REFRESH_TOKEN_EXPIRES_IN",
              "2592000",
              "Refresh token TTL (30d). Also the Max-Age of the browser's pb_refresh cookie."
            ],
            [
              "AUTH_REFRESH_COOKIE_PATH",
              "/api/auth/refresh",
              "Path the browser's refresh cookie is scoped to, as the browser sees it (nginx strips /api before proxying, so this is the public path). Change only when the UI is served under a different public prefix."
            ],
            [
              "AUTH_COOKIE_SECURE",
              "true",
              "Secure on the refresh cookie. Every shipped target terminates TLS in front of the gateway and browsers accept Secure on http://localhost, so leave this on. Set false only for a plain-http deployment on a non-localhost hostname, where the browser would otherwise drop the cookie and no session could refresh."
            ],
            [
              "PASSWORD_MIN_LENGTH",
              "8",
              "Platform minimum password length — the floor every org's own minimum sits on (an org can raise it for its members, up to 128; see Org password policy)"
            ],
            [
              "PASSWORD_BREACH_CHECK",
              "hibp",
              "Breached-password check at registration, password change and admin reset. hibp queries the Have I Been Pwned \"Pwned Passwords\" range API with only the first 5 hex characters of the password's SHA-1 (k-anonymity, padded responses); off disables it (air-gapped installs). Fail-open: a timeout or error lets the password through and is metered as platform_password_breach_checks_total{outcome=\"unavailable\"}"
            ],
            [
              "PASSWORD_BREACH_CHECK_URL",
              "https://api.pwnedpasswords.com/range/",
              "Range API base (the 5-char prefix is appended). Point at an internal mirror to keep the check without public egress"
            ],
            [
              "PASSWORD_BREACH_CHECK_TIMEOUT_MS",
              "2000",
              "Per-check timeout; past it the check fails open"
            ],
            [
              "LOGIN_ACCOUNT_LIMITER_MAX",
              "10",
              "Per-account failed password sign-ins allowed per window on POST /auth/login (keyed on a SHA-256 of the normalized identifier; successful sign-ins are not counted). The per-IP limit is AUTH_LIMITER_*"
            ],
            [
              "LOGIN_ACCOUNT_LIMITER_WINDOWMS",
              "900000",
              "Per-account sign-in throttle window (15 min)"
            ],
            [
              "BOOTSTRAP_SUPERADMIN_EMAILS",
              "—",
              "Comma-separated user emails auto-promoted to isSuperAdmin=true at platform boot. Required for fresh installs — the first sysadmin can only be granted through this env or a direct DB update. Idempotent. Also names who the bootstrap-admin MFA exception applies to (#8): until one of these accounts enrols a passkey or an authenticator app, its password sign-in yields a limited session that can reach only enrolment, sign-out and the setup routes, and SSO enforcement never applies to it. Read live, so changing it needs no redeploy. See Assurance levels and required MFA."
            ],
            [
              "MFA_RECOVER_OPERATOR",
              "—",
              "Default --operator for the scripts/mfa-recover.js factor-reset command — who is running it, recorded as the audit actor. Only read by that command; the flag wins when both are given, and the command refuses to run with neither (an audit row for a factor reset is worth little without a name)."
            ]
          ]
        },
        {
          "type": "text",
          "content": "User-token signing (ES256) — platform only"
        },
        {
          "type": "text",
          "content": "Every token that speaks for a person — access, refresh, step-up and the short-lived token an opaque access key is exchanged for — is signed by platform alone with an EC P-256 key and a kid, and verified by everyone else against the public keys platform publishes at /.well-known/jwks.json. No other service holds a key that can mint one."
        },
        {
          "type": "table",
          "headers": [
            "Variable",
            "Default",
            "Description"
          ],
          "rows": [
            [
              "TOKEN_SIGNING_MODE",
              "local",
              "local reads a PEM from disk; kms keeps the private key inside AWS KMS (asymmetric ECC_NIST_P256, SIGN_VERIFY). Platform only."
            ],
            [
              "TOKEN_SIGNING_KEY_FILE",
              "—",
              "Required in local mode. Path to the EC P-256 private key (PKCS#8 PEM), generated by deploy/bin/token-signing-keys.sh and mounted from the token-signing-key Kubernetes Secret. Platform refuses to start if it cannot be read."
            ],
            [
              "TOKEN_SIGNING_KEY_PREVIOUS_FILE",
              "—",
              "Rotation: the RETIRING key. It is PUBLISHED in the JWKS (so tokens it signed keep verifying) but never signs anything new. Clear it once every token signed with the old kid has expired — including refresh tokens, which live REFRESH_TOKEN_EXPIRES_IN."
            ],
            [
              "TOKEN_SIGNING_KMS_KEY_ID",
              "—",
              "Required in kms mode. The KMS key, by alias (alias/pipeline-builder-token-signing) — an ARN embeds the AWS account id and must not be used. Platform needs kms:Sign + kms:GetPublicKey."
            ],
            [
              "TOKEN_SIGNING_KMS_KEY_PREVIOUS_ID",
              "—",
              "Rotation counterpart of TOKEN_SIGNING_KEY_PREVIOUS_FILE, in kms mode."
            ],
            [
              "PLATFORM_JWKS_URL",
              "derived",
              "Absolute URL of the key set, for verifiers OUTSIDE the cluster (the pipeline-manager CLI, the pipeline-events Lambda). In-cluster services derive it from PLATFORM_SERVICE_HOST/PLATFORM_SERVICE_PORT; the CLI and the Lambda derive it from PLATFORM_BASE_URL."
            ],
            [
              "JWKS_FETCH_TIMEOUT_MS",
              "3000",
              "Timeout on one JWKS fetch. Verifiers keep serving a key set they already hold if a refresh fails, and FAIL CLOSED (503) if they never obtained one."
            ]
          ]
        },
        {
          "type": "text",
          "content": "Multi-team secret encryption"
        },
        {
          "type": "text",
          "content": "AI provider keys and IdP client secrets are encrypted at rest. SECRET_ENCRYPTION_KEY is required at platform boot — the read paths do not fall back to clear text; a non-encrypted value throws on read. Rotating an org's KMS config re-encrypts that org's secrets under the new key (see the org KMS-config admin endpoint)."
        },
        {
          "type": "table",
          "headers": [
            "Variable",
            "Default",
            "Description"
          ],
          "rows": [
            [
              "SECRET_ENCRYPTION_KEY",
              "—",
              "Required. 32-byte master key (hex or base64). Generate with `head -c 32 /dev/urandom \\",
              "base64`. Platform aborts startup when this is unset in production."
            ],
            [
              "SECRET_ENCRYPTION_KEY_PREVIOUS",
              "—",
              "Rotation: decrypt-only fallback for rows still wrapped under the outgoing master key (never used to encrypt, and never applied to a per-org-KMS blob). Clear it after node scripts/reencrypt-secrets.js reports 0 failures inside a platform container — see Secret Rotation."
            ],
            [
              "SECRET_ENCRYPTION_PER_ORG_KMS",
              "false",
              "When true, each org's secrets are wrapped under its own KMS CMK (see Organization.kmsConfig). Orgs without an entry fall through to the shared master. Recommended for SOC2 / compliance deploys."
            ],
            [
              "SECRET_ENCRYPTION_KMS_KEY_ID",
              "—",
              "(Single-master KMS mode) KMS CMK alias / ARN used to wrap the shared master."
            ],
            [
              "SECRET_ENCRYPTION_KMS_CIPHERTEXT",
              "—",
              "(Single-master KMS mode) Base64 KMS-wrapped 32-byte master."
            ]
          ]
        },
        {
          "type": "text",
          "content": "Multi-team RLS context"
        },
        {
          "type": "table",
          "headers": [
            "Variable",
            "Default",
            "Description"
          ],
          "rows": [
            [
              "RLS_CONTEXT_MODE",
              "warn",
              "Behavior when withTenantTx is called outside any tenant scope. warn logs a stack-traced warning, strict throws, silent is no-op (tests / migration only). Recommended production rollout: warn for ≥7 days, then flip to strict after the logs show zero spurious warnings."
            ]
          ]
        },
        {
          "type": "text",
          "content": "Multi-team alert webhook relay"
        },
        {
          "type": "table",
          "headers": [
            "Variable",
            "Default",
            "Description"
          ],
          "rows": [
            [
              "ALERT_WEBHOOK_INSTANCES",
              "—",
              "JSON array of { id, token, previousToken?, allowedOrgIds? } entries. previousToken is the rotation overlap: while non-empty, either bearer is accepted. Required to enable the relay; unset / empty returns 503 at the webhook endpoint. Each Alertmanager sends X-Alertmanager-Instance: <id> + Authorization: Bearer <token>. allowedOrgIds restricts which orgs that instance can relay alerts for."
            ],
            [
              "ALERT_WEBHOOK_INSTANCE_TOKEN",
              "—",
              "Deploy input: the bundled Alertmanager's relay token. Setup generates it, builds platform's ALERT_WEBHOOK_INSTANCES entry (id alertmanager) from it, and mounts it for Alertmanager."
            ],
            [
              "ALERT_WEBHOOK_INSTANCE_TOKEN_PREVIOUS",
              "—",
              "Deploy input: rotation overlap for the above. Rendered into the instance entry's previousToken, so platform accepts the outgoing bearer until Alertmanager has restarted with the new one."
            ]
          ]
        },
        {
          "type": "text",
          "content": "OAuth / social login (Optional)"
        },
        {
          "type": "text",
          "content": "Platform-wide \"Sign in with…\" providers. A provider is enabled iff its OAUTH_<P>_CLIENT_ID is set (fail-soft — an unconfigured provider is hidden, never an error); the login page renders its buttons data-driven from the enabled set. Credentials are global / one app registration per provider for the whole deployment. The redirect URI to register in each provider's console is <OAUTH_CALLBACK_BASE_URL>/auth/callback/<provider>. Per-org enterprise SSO (OIDC / Cognito) is configured in the app, not here — see Authentication & SSO."
        },
        {
          "type": "text",
          "content": "Shared:"
        },
        {
          "type": "table",
          "headers": [
            "Variable",
            "Default",
            "Description"
          ],
          "rows": [
            [
              "OAUTH_CALLBACK_BASE_URL",
              "${PLATFORM_FRONTEND_URL}",
              "OAuth redirect origin (each handler appends /auth/callback/<provider>)"
            ],
            [
              "OAUTH_STATE_TTL_MS",
              "600000",
              "OAuth state (CSRF) token TTL (10 min)"
            ],
            [
              "OAUTH_CLEANUP_INTERVAL_MS",
              "60000",
              "Stale state cleanup interval"
            ],
            [
              "OAUTH_MAX_PENDING_STATES",
              "1000",
              "Cap on the in-memory pending-state fallback (used only when Redis is unset)"
            ],
            [
              "OIDC_DOC_CACHE_TTL_MS",
              "3600000",
              "OIDC discovery / JWKS document cache TTL"
            ],
            [
              "SAML_CLOCK_SKEW_MS",
              "60000",
              "Skew tolerated on a SAML assertion's NotBefore / NotOnOrAfter. Sized for ordinary NTP drift between the IdP and this deployment — raising it accepts staler assertions"
            ],
            [
              "SAML_REQUEST_TTL_MS",
              "600000",
              "How long an unanswered SAML AuthnRequest stays valid — i.e. how long a person has to finish signing in at their IdP"
            ],
            [
              "SAML_ASSERTION_REPLAY_TTL_MS",
              "600000",
              "Floor on how long a spent assertion id is remembered for replay refusal. The real window is the assertion's own NotOnOrAfter when that is longer (capped at 12 h)"
            ],
            [
              "SAML_HANDOFF_TTL_MS",
              "120000",
              "Lifetime of the one-time handoff the SAML ACS hands the browser — the few seconds it takes to follow one redirect"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Device authorization (CLI sign-in)"
        },
        {
          "type": "text",
          "content": "pipeline-manager auth login uses the OAuth 2.0 device authorization grant, so the CLI never holds a password — see Authentication → CLI sign-in. Every value below has a working default; none needs to be set."
        },
        {
          "type": "table",
          "headers": [
            "Variable",
            "Default",
            "Description"
          ],
          "rows": [
            [
              "DEVICE_CODE_TTL_MS",
              "600000",
              "How long a device code and its short user code stay valid (10 min)"
            ],
            [
              "DEVICE_CODE_INTERVAL_SECONDS",
              "5",
              "Minimum seconds between polls. A client polling faster gets slow_down and this flow's interval widens by 5 s"
            ],
            [
              "DEVICE_CODE_MAX_POLLS",
              "200",
              "Hard ceiling on polls per device code (a conforming client spends ~120 over the full TTL)"
            ],
            [
              "DEVICE_APPROVAL_GRACE_MS",
              "300000",
              "How long an approval's step-up proof remains good for the step-up token auth pat collects on its next poll"
            ],
            [
              "DEVICE_MAX_PENDING",
              "1000",
              "Cap on the in-memory pending-state fallback, used only when no Redis is configured"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Passkeys (WebAuthn)"
        },
        {
          "type": "text",
          "content": "The relying party is derived from PLATFORM_FRONTEND_URL and is never read from the request: the RP ID is its exact hostname (no scheme, no port) and the default origin is its scheme + host + port. Nothing below needs to be set."
        },
        {
          "type": "note",
          "content": "The RP ID is permanent. Every passkey is bound to the value in force when it was registered. Changing WEBAUTHN_RP_ID — or the hostname in PLATFORM_FRONTEND_URL — orphans every credential already enrolled: there is no migration, and affected users must enrol again. Platform refuses to boot when the RP ID is an IP address, when an origin is not the RP ID or a subdomain of it, or when an origin is plain http (http://localhost excepted)."
        },
        {
          "type": "table",
          "headers": [
            "Variable",
            "Default",
            "Description"
          ],
          "rows": [
            [
              "WEBAUTHN_RP_ID",
              "hostname of PLATFORM_FRONTEND_URL",
              "Relying-party id. Override only when the origin people browse to differs from the frontend URL (a CDN alias, a split app/api hostname). Permanent — see the warning above"
            ],
            [
              "WEBAUTHN_ORIGINS",
              "origin of PLATFORM_FRONTEND_URL",
              "Comma-separated origins a ceremony may come from (scheme + host + port). Each must be the RP ID or a subdomain of it"
            ],
            [
              "WEBAUTHN_RP_NAME",
              "Pipeline Builder",
              "Name shown in the device's passkey prompt"
            ],
            [
              "WEBAUTHN_CHALLENGE_TTL_MS",
              "120000",
              "How long a ceremony may take between /options and /verify (2 min). Challenges are single-use and held in the shared Redis"
            ],
            [
              "WEBAUTHN_MAX_PENDING_CEREMONIES",
              "1000",
              "Cap on the in-memory ceremony fallback, used only when no Redis is configured"
            ],
            [
              "FIDO_MDS_BLOB_PATH",
              "—",
              "Path to a downloaded FIDO Metadata Service (MDS3) blob JWT. Consulted only for orgs with an approved-authenticator (AAGUID) allowlist; wins over FIDO_MDS_URL (the air-gapped option). Its signature chain is verified against the FIDO root before any statement is trusted"
            ],
            [
              "FIDO_MDS_URL",
              "https://mds.fidoalliance.org/",
              "Where to fetch the MDS blob when no path is set; off disables fetching. With no metadata loaded, passkey registrations into an allowlisted org are refused (fail closed)"
            ],
            [
              "FIDO_MDS_FETCH_TIMEOUT_MS",
              "10000",
              "Blob fetch timeout. After a failed load, loads are not retried for 5 minutes (a stale snapshot, if any, keeps serving)"
            ],
            [
              "FIDO_MDS_REFRESH_MS",
              "86400000",
              "How long a loaded blob is cached before it is re-read (24 h)"
            ]
          ]
        },
        {
          "type": "text",
          "content": "The browser also needs publickey-credentials-get / publickey-credentials-create in Permissions-Policy; every shipped nginx config and frontend/next.config.js declares them explicitly."
        },
        {
          "type": "text",
          "content": "Authenticator app (TOTP)"
        },
        {
          "type": "text",
          "content": "Nothing below needs to be set. The algorithm parameters are deliberately not configurable — SHA-1 / 6 digits / 30 seconds is the only combination every authenticator reads reliably from an otpauth:// URI, and a knob there would only let an operator produce enrolments that scan cleanly and then never verify."
        },
        {
          "type": "text",
          "content": "Secrets are encrypted at rest under SECRET_ENCRYPTION_KEY, HKDF-bound to the owning user, so the master-key rotation notes above apply to them too."
        },
        {
          "type": "table",
          "headers": [
            "Variable",
            "Default",
            "Description"
          ],
          "rows": [
            [
              "TOTP_ISSUER",
              "Pipeline Builder",
              "Name the authenticator app shows above the code, and the issuer baked into the enrolment QR. Purely a label — changing it does not invalidate existing enrolments, though already-scanned entries keep the old name"
            ],
            [
              "TOTP_MAX_FAILURES",
              "5",
              "Consecutive wrong codes before the account's TOTP verification is locked out. A 6-digit code is ~20 bits, so this — not the code — is what makes online guessing hopeless"
            ],
            [
              "TOTP_LOCKOUT_MS",
              "900000",
              "How long that lockout lasts (15 min). Applies to sign-in and step-up alike, and to recovery codes"
            ],
            [
              "TOTP_LOGIN_CHALLENGE_TTL_MS",
              "300000",
              "Lifetime of the sign-in MFA challenge — the handle a password sign-in returns instead of a session (5 min). Held in the shared Redis"
            ],
            [
              "TOTP_MAX_PENDING_CHALLENGES",
              "1000",
              "Cap on the in-memory challenge fallback, used only when no Redis is configured"
            ]
          ]
        },
        {
          "type": "note",
          "content": "Operator note. A person who loses both their authenticator and their recovery codes cannot self-serve back in: deleting their usertotps row (with database access) is the recovery, and it should be treated as the privileged, out-of-band action it is."
        },
        {
          "type": "text",
          "content": "Per provider (CLIENT_ID empty = disabled):"
        },
        {
          "type": "table",
          "headers": [
            "Variable",
            "Default",
            "Description"
          ],
          "rows": [
            [
              "OAUTH_GOOGLE_CLIENT_ID",
              "—",
              "Google client ID (Google Cloud Console)"
            ],
            [
              "OAUTH_GOOGLE_CLIENT_SECRET",
              "—",
              "Google client secret"
            ],
            [
              "OAUTH_GITHUB_CLIENT_ID",
              "—",
              "GitHub client ID (GitHub OAuth Apps)"
            ],
            [
              "OAUTH_GITHUB_CLIENT_SECRET",
              "—",
              "GitHub client secret"
            ],
            [
              "OAUTH_FACEBOOK_CLIENT_ID",
              "—",
              "Facebook app ID (Meta for Developers)"
            ],
            [
              "OAUTH_FACEBOOK_CLIENT_SECRET",
              "—",
              "Facebook app secret"
            ],
            [
              "OAUTH_MICROSOFT_CLIENT_ID",
              "—",
              "Microsoft/Entra client ID (Entra admin center → App registrations)"
            ],
            [
              "OAUTH_MICROSOFT_CLIENT_SECRET",
              "—",
              "Microsoft/Entra client secret"
            ],
            [
              "OAUTH_MICROSOFT_TENANT",
              "common",
              "Entra tenant: common (any account) or a specific tenant id/domain"
            ],
            [
              "OAUTH_GITLAB_CLIENT_ID",
              "—",
              "GitLab application ID (GitLab Applications)"
            ],
            [
              "OAUTH_GITLAB_CLIENT_SECRET",
              "—",
              "GitLab application secret"
            ],
            [
              "OAUTH_GITLAB_BASE_URL",
              "https://gitlab.com",
              "GitLab base URL (point at a self-hosted instance to use it)"
            ],
            [
              "OAUTH_LINKEDIN_CLIENT_ID",
              "—",
              "LinkedIn client ID (LinkedIn Developers, \"Sign in with LinkedIn using OpenID Connect\")"
            ],
            [
              "OAUTH_LINKEDIN_CLIENT_SECRET",
              "—",
              "LinkedIn client secret"
            ]
          ]
        }
      ]
    },
    {
      "id": "databases",
      "title": "Databases",
      "blocks": [
        {
          "type": "text",
          "content": "PostgreSQL"
        },
        {
          "type": "table",
          "headers": [
            "Variable",
            "Default",
            "Description"
          ],
          "rows": [
            [
              "POSTGRES_USER",
              "postgres",
              "Superuser (container init)"
            ],
            [
              "POSTGRES_PASSWORD",
              "—",
              "Superuser password"
            ],
            [
              "POSTGRES_DB",
              "pipeline_builder",
              "Database name (container init)"
            ],
            [
              "DB_HOST",
              "postgres",
              "Host for services"
            ],
            [
              "DB_PORT",
              "5432",
              "Port"
            ],
            [
              "DB_USER",
              "postgres",
              "User for services"
            ],
            [
              "DB_PASSWORD",
              "—",
              "Password for services"
            ],
            [
              "DRIZZLE_MAX_POOL_SIZE",
              "20",
              "Connection pool size"
            ],
            [
              "DRIZZLE_IDLE_TIMEOUT_MILLIS",
              "30000",
              "Idle connection timeout (ms)"
            ],
            [
              "DRIZZLE_CONNECTION_TIMEOUT_MILLIS",
              "10000",
              "Connection timeout (ms)"
            ],
            [
              "DB_MAX_RETRIES",
              "3",
              "Connection retry attempts"
            ],
            [
              "DB_RETRY_DELAY_MS",
              "1000",
              "Retry delay (ms)"
            ],
            [
              "DB_TRANSACTION_TIMEOUT_MS",
              "30000",
              "Transaction timeout (ms)"
            ],
            [
              "DB_CLOSE_TIMEOUT_MS",
              "5000",
              "Connection close timeout (ms)"
            ]
          ]
        },
        {
          "type": "text",
          "content": "MongoDB"
        },
        {
          "type": "table",
          "headers": [
            "Variable",
            "Default",
            "Description"
          ],
          "rows": [
            [
              "MONGO_INITDB_ROOT_USERNAME",
              "mongo",
              "Root username"
            ],
            [
              "MONGO_INITDB_ROOT_PASSWORD",
              "—",
              "Root password"
            ],
            [
              "MONGO_INITDB_DATABASE",
              "platform",
              "Initial database"
            ],
            [
              "MONGODB_URI",
              "—",
              "Full connection URI with replica set"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Redis"
        },
        {
          "type": "table",
          "headers": [
            "Variable",
            "Default",
            "Description"
          ],
          "rows": [
            [
              "REDIS_URL",
              "—",
              "Standalone: redis://<host>:<port>[/db], or rediss:// for TLS"
            ],
            [
              "REDIS_PASSWORD",
              "—",
              "Data-node AUTH password (optional, either mode)"
            ],
            [
              "REDIS_SENTINELS",
              "—",
              "HA: comma-separated host:port Sentinel list. The app connects via Sentinel and follows the promoted primary after a failover. Also the shape a managed ElastiCache (cluster-mode-disabled) uses. See deploy/aws/*/k8s/redis-sentinel.yaml"
            ],
            [
              "REDIS_SENTINEL_MASTER",
              "mymaster",
              "Sentinel monitored-primary name (Sentinel mode)"
            ],
            [
              "REDIS_SENTINEL_PASSWORD",
              "—",
              "Sentinel AUTH password (Sentinel mode, optional)"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Redis must use maxmemory-policy noeviction for BullMQ. allkeys-lru causes silent job data loss. HA: the AWS targets (ec2 and eks) ship Sentinel HA by default (redis-sentinel.yaml — 3 Redis + 3 Sentinel, reached via REDIS_SENTINELS). The docker and minikube targets run a single instance with no failover. For a managed path, point it at ElastiCache (Multi-AZ, cluster-mode-disabled)."
        },
        {
          "type": "text",
          "content": "Set exactly one of REDIS_URL or REDIS_SENTINELS. Setting both, or setting the retired REDIS_HOST, stops every service at startup with a configuration error, as does a malformed REDIS_URL or Sentinel entry. Neither set means Redis is off. REDIS_PORT is ignored — Kubernetes injects REDIS_PORT=tcp://… into pods next to a Service named redis."
        },
        {
          "type": "text",
          "content": "Every service resolves Redis the same way, including the platform. Configure Redis for platform as well as the other services: it uses Redis to publish session revocations and to share OAuth/SSO login state, step-up single-use, and the background-sweep lock across replicas. Without it those fall back to per-replica memory, which breaks once platform scales past one replica."
        },
        {
          "type": "text",
          "content": "Impersonation needs Redis on every service. A service that cannot read Redis rejects impersonation tokens, because it could not tell whether the session was ended. Ordinary sessions are unaffected."
        }
      ]
    },
    {
      "id": "docker-registry",
      "title": "Docker Registry",
      "blocks": [
        {
          "type": "table",
          "headers": [
            "Variable",
            "Default",
            "Description"
          ],
          "rows": [
            [
              "IMAGE_REGISTRY_HOST",
              "registry",
              "Registry hostname"
            ],
            [
              "IMAGE_REGISTRY_PORT",
              "5000",
              "Registry port"
            ],
            [
              "IMAGE_REGISTRY_USER",
              "admin",
              "Registry username"
            ],
            [
              "IMAGE_REGISTRY_TOKEN",
              "—",
              "Registry password/token"
            ],
            [
              "REGISTRY_TOKEN_RATE_LIMIT_MAX",
              "60",
              "image-registry /token: requests per window per (source IP, username)"
            ],
            [
              "REGISTRY_TOKEN_RATE_LIMIT_IP_MAX",
              "300",
              "image-registry /token: requests per window per source IP across all usernames (stops password spraying)"
            ],
            [
              "REGISTRY_TOKEN_RATE_LIMIT_WINDOW_MS",
              "60000",
              "image-registry /token rate-limit window (ms)"
            ],
            [
              "IMAGE_REGISTRY_HTTP",
              "true",
              "Plugin builds talk to the in-cluster registry over plain HTTP. Set false only if the registry is exposed via a TLS-terminating proxy with a publicly trusted cert."
            ],
            [
              "IMAGE_REGISTRY_TOKEN_REALM",
              "${PLATFORM_BASE_URL}/image-registry/token",
              "Bearer-token realm the plugin keys its registry credential under. Must match the registry's REGISTRY_AUTH_TOKEN_REALM (e.g. http://image-registry:3000/token in-cluster) — when the registry redirects a push to a different host than the push target, the plugin only sends Basic auth if it has a credential keyed under that realm host. Set on every target's plugin so pushes don't 401 / insufficient_scope."
            ]
          ]
        }
      ]
    },
    {
      "id": "plugin-builds",
      "title": "Plugin Builds",
      "blocks": [
        {
          "type": "text",
          "content": "Every deploy target (EKS, EC2, minikube, local docker-compose) runs plugin builds against a rootless moby/buildkit sidecar (buildkitd). The plugin service's buildctl connects via the Unix socket exposed by the sidecar — there is no docker daemon, no privileged build sidecar, and no strategy switch."
        },
        {
          "type": "table",
          "headers": [
            "Variable",
            "Default",
            "Description"
          ],
          "rows": [
            [
              "BUILDKIT_HOST",
              "unix:///run/buildkit/buildkitd.sock",
              "buildctl --addr for the buildkitd sidecar"
            ],
            [
              "DOCKER_BUILD_TIMEOUT_MS",
              "900000",
              "Build timeout (15 min)"
            ],
            [
              "DOCKER_PUSH_TIMEOUT_MS",
              "300000",
              "Push timeout (5 min)"
            ],
            [
              "PLUGIN_UPLOAD_TIMEOUT_MS",
              "300000",
              "Upload HTTP timeout (5 min) — overrides HANDLER_TIMEOUT_MS for the upload route"
            ],
            [
              "PLUGIN_MAX_UPLOAD_MB",
              "4096",
              "Max plugin ZIP upload size in MB (supports prebuilt image.tar)"
            ]
          ]
        },
        {
          "type": "text",
          "content": "The plugin image is published with a single tag (plugin:<version>) — one builder, one path, no per-builder target suffixes."
        },
        {
          "type": "text",
          "content": "How the build runs"
        },
        {
          "type": "list",
          "items": [
            "Build from source (buildType: build_image): buildctl build --frontend dockerfile.v0 --local context=<dir> --local dockerfile=<dir> --output type=image,name=<image>,push=true[,registry.insecure=true]. buildkitd handles the Dockerfile parse, layer cache, registry push, and bearer-token negotiation.",
            "Prebuilt tarball (buildType: prebuilt): crane push <tar> <image>. buildctl can build but cannot push pre-existing docker save tarballs; the plugin image bundles crane for this path only."
          ]
        },
        {
          "type": "text",
          "content": "Why rootless BuildKit"
        },
        {
          "type": "list",
          "items": [
            "Rootless, no privileged containers: moby/buildkit:rootless runs as uid 1000 with no SYS_ADMIN and no privileged: true — it builds full OCI images from a Dockerfile without a Docker daemon and without a docker socket mount, removing the classic dind/socket attack surface.",
            "Builds and pushes directly: buildkitd parses the Dockerfile, runs the build with native layer caching, and pushes straight to the registry (--output type=image,push=true) — no intermediate docker save/docker push round-trip.",
            "No CA-trust workarounds: buildkitd carries the system CA bundle and follows realm-URL bearer challenges with the host's trust store — no per-container cert mounts, no update-ca-certificates shell wrappers.",
            "One code path everywhere: the same docker-build.ts runs on EKS, EC2, minikube, and local. Deploy target only changes the sidecar's hosting (k8s pod / compose service)."
          ]
        },
        {
          "type": "text",
          "content": "Build Queue"
        },
        {
          "type": "table",
          "headers": [
            "Variable",
            "Default",
            "Description"
          ],
          "rows": [
            [
              "PLUGIN_BUILD_CONCURRENCY",
              "1",
              "Max concurrent builds per container (per-tier overrides: `PLUGIN_BUILD_CONCURRENCY_<DEVELOPER\\",
              "PRO\\",
              "TEAM\\",
              "ENTERPRISE\\",
              "UNLIMITED>`)"
            ],
            [
              "PLUGIN_BUILD_QUEUE_NAME",
              "plugin-build",
              "BullMQ queue name"
            ],
            [
              "PLUGIN_BUILD_MAX_ATTEMPTS",
              "2",
              "Max build attempts before moving to DLQ"
            ],
            [
              "PLUGIN_BUILD_BACKOFF_DELAY_MS",
              "5000",
              "Backoff delay between retries (ms)"
            ],
            [
              "PLUGIN_BUILD_COMPLETED_RETENTION_SECS",
              "3600",
              "Completed job retention (1 hour)"
            ],
            [
              "PLUGIN_BUILD_FAILED_RETENTION_SECS",
              "86400",
              "Failed job retention (24 hours)"
            ],
            [
              "PLUGIN_BUILD_WORKER_TIMEOUT_MS",
              "10000",
              "Worker ready timeout (ms)"
            ],
            [
              "PLUGIN_DLQ_MAX_ATTEMPTS",
              "3",
              "Max DLQ retry attempts (exponential backoff)"
            ],
            [
              "PLUGIN_DLQ_BACKOFF_BASE_MS",
              "300000",
              "DLQ backoff base delay (5 min; scales 5m, 15m, 45m)"
            ],
            [
              "PLUGIN_DLQ_MAX_SIZE",
              "20",
              "Max DLQ jobs before oldest are purged"
            ],
            [
              "TEMP_DIR_MAX_AGE_MS",
              "14400000",
              "Stale temp dir cleanup threshold (4 hours)"
            ]
          ]
        }
      ]
    },
    {
      "id": "quotas-rate-limiting",
      "title": "Quotas & Rate Limiting",
      "blocks": [
        {
          "type": "table",
          "headers": [
            "Variable",
            "Default",
            "Description"
          ],
          "rows": [
            [
              "QUOTA_DEFAULT_PLUGINS",
              "100",
              "Fallback-read plugin cap (see note)"
            ],
            [
              "QUOTA_DEFAULT_PIPELINES",
              "10",
              "Fallback-read pipeline cap (see note)"
            ],
            [
              "QUOTA_DEFAULT_API_CALLS",
              "-1",
              "Fallback-read API-call cap, -1 = unlimited (see note)"
            ],
            [
              "QUOTA_DEFAULT_AI_CALLS",
              "100",
              "Fallback-read AI-call cap, sized smaller than apiCalls because each call has external $ cost (see note)"
            ],
            [
              "QUOTA_RESET_DAYS",
              "3",
              "Reset period (days)"
            ],
            [
              "QUOTA_SERVICE_HOST",
              "quota",
              "Quota service host"
            ],
            [
              "QUOTA_SERVICE_PORT",
              "3000",
              "Quota service port"
            ],
            [
              "LIMITER_MAX",
              "100",
              "Global rate limit (requests/window)"
            ],
            [
              "LIMITER_WINDOWMS",
              "900000",
              "Global rate limit window (15 min)"
            ],
            [
              "RATE_LIMIT_MAX",
              "100",
              "Per-route rate limit"
            ],
            [
              "RATE_LIMIT_WINDOW_MS",
              "60000",
              "Per-route rate limit window (1 min)"
            ],
            [
              "AUTH_LIMITER_MAX",
              "20",
              "Auth endpoint rate limit"
            ],
            [
              "AUTH_LIMITER_WINDOWMS",
              "900000",
              "Auth rate limit window (15 min)"
            ],
            [
              "MESSAGE_SEND_RATE_MAX",
              "60",
              "Per-org message send + reply limit (post-auth; complements the global per-IP limiter). Verified service principals exempt"
            ],
            [
              "MESSAGE_SEND_RATE_WINDOW_MS",
              "60000",
              "Per-org message-send window (1 min)"
            ],
            [
              "MESSAGE_ATTACHMENT_RATE_MAX",
              "30",
              "Per-org attachment-upload limit (rejected before multipart buffering)"
            ],
            [
              "MESSAGE_ATTACHMENT_RATE_WINDOW_MS",
              "60000",
              "Per-org attachment-upload window (1 min)"
            ],
            [
              "MESSAGE_THUMBNAIL_MAX_DIM",
              "320",
              "Long-edge (px) of generated image thumbnails (pure-JS jimp; served via ?thumb=1, falls back to the original)"
            ],
            [
              "LIMITER_MULT_DEVELOPER",
              "1",
              "Developer-tier rate-limit multiplier (budget = LIMITER_MAX × mult)"
            ],
            [
              "LIMITER_MULT_PRO",
              "10",
              "Pro-tier rate-limit multiplier"
            ],
            [
              "LIMITER_MULT_TEAM",
              "25",
              "Team-tier rate-limit multiplier"
            ],
            [
              "LIMITER_MULT_ENTERPRISE",
              "50",
              "Enterprise-tier rate-limit multiplier"
            ],
            [
              "LIMITER_MULT_UNLIMITED",
              "100",
              "Unlimited-tier rate-limit multiplier (billing-disabled default tier)"
            ]
          ]
        },
        {
          "type": "note",
          "content": "These are not the caps a new org gets. The platform service is the sole authority for org lifecycle: it seeds each org's stored limits from its tier (see QUOTA_TIERS below) at creation time, and enforcement reserves against those stored values. The QUOTA_DEFAULT_* values govern only the fallback read for an org that has no document yet — so the dashboard renders something instead of erroring. Changing them does not raise or lower any real org's limit."
        },
        {
          "type": "text",
          "content": "Tier presets ship in @pipeline-builder/api-core (QUOTA_TIERS in quota-tiers.ts):"
        },
        {
          "type": "table",
          "headers": [
            "Tier",
            "plugins",
            "pipelines",
            "apiCalls",
            "aiCalls",
            "seats"
          ],
          "rows": [
            [
              "developer",
              "25",
              "2",
              "25,000",
              "25",
              "1"
            ],
            [
              "pro",
              "50",
              "5",
              "250,000",
              "1,000",
              "1"
            ],
            [
              "team",
              "75",
              "6",
              "500,000",
              "2,500",
              "3"
            ],
            [
              "enterprise",
              "150",
              "30",
              "900,000",
              "9,000",
              "15"
            ],
            [
              "unlimited",
              "-1",
              "-1",
              "-1",
              "-1",
              "-1"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Any preset can be overridden per-environment via QUOTA_TIER_<DEVELOPER|PRO|TEAM|ENTERPRISE|UNLIMITED>_<LIMIT> (e.g. QUOTA_TIER_TEAM_SEATS=20), and DEFAULT_QUOTA_TIER sets the tier assigned to newly created orgs (developer by default). seats is a tier limit, not a tracked counter — it is enforced live at invite time against active org membership."
        },
        {
          "type": "text",
          "content": "unlimited tier. Every limit is -1 (uncapped) and every gated feature is on. It is the automatic default when billing is disabled (BILLING_ENABLED=false) — DEFAULT_QUOTA_TIER is ignored in that case and new orgs get unlimited. When billing is enabled it is never displayed, selectable, or purchasable (excluded from the plans list and tier pickers), and DEFAULT_QUOTA_TIER=unlimited is rejected in favour of developer. Its label is overridable via QUOTA_TIER_UNLIMITED_LABEL (default Unlimited)."
        },
        {
          "type": "text",
          "content": "Each tier's quota reset period is overridable via QUOTA_TIER_<TIER>_RESET_PERIOD (a single duration applied to every quota type). Defaults: 3days for developer/pro, 30days for team/enterprise. (The reset period is moot for unlimited, whose limits are all -1 and never reset.)"
        },
        {
          "type": "text",
          "content": "Per-call increments to /quotas/:orgId/increment cap amount at 1000 — bounds the per-request blast radius from a buggy or malicious caller."
        }
      ]
    },
    {
      "id": "service-discovery",
      "title": "Service Discovery",
      "blocks": [
        {
          "type": "table",
          "headers": [
            "Variable",
            "Default",
            "Description"
          ],
          "rows": [
            [
              "PLUGIN_SERVICE_HOST",
              "plugin",
              "Plugin service hostname"
            ],
            [
              "PLUGIN_SERVICE_PORT",
              "3000",
              "Plugin service port"
            ],
            [
              "PIPELINE_SERVICE_HOST",
              "pipeline",
              "Pipeline service hostname"
            ],
            [
              "PIPELINE_SERVICE_PORT",
              "3000",
              "Pipeline service port"
            ],
            [
              "MESSAGE_SERVICE_HOST",
              "message",
              "Message service hostname"
            ],
            [
              "MESSAGE_SERVICE_PORT",
              "3000",
              "Message service port"
            ],
            [
              "PLATFORM_SERVICE_HOST",
              "platform",
              "Platform service hostname (compliance → email delivery; every service → the access-key exchange)"
            ],
            [
              "PLATFORM_SERVICE_PORT",
              "3000",
              "Platform service port"
            ],
            [
              "API_KEY_EXCHANGE_TIMEOUT_MS",
              "3000",
              "Per-request timeout when a service trades an opaque access key for a short-lived token. A timeout answers 503 (never a pass) and increments api_key_exchange_failures_total{reason=\"unavailable\"}"
            ],
            [
              "COMPLIANCE_SERVICE_HOST",
              "compliance",
              "Compliance service hostname (also billing → compliance entitlement sync)"
            ],
            [
              "COMPLIANCE_SERVICE_PORT",
              "3000",
              "Compliance service port"
            ],
            [
              "BILLING_SERVICE_HOST",
              "billing",
              "Billing service hostname"
            ],
            [
              "BILLING_SERVICE_PORT",
              "3000",
              "Billing service port"
            ],
            [
              "QUOTA_SERVICE_HOST",
              "quota",
              "Quota service hostname"
            ],
            [
              "QUOTA_SERVICE_PORT",
              "3000",
              "Quota service port"
            ]
          ]
        }
      ]
    },
    {
      "id": "messaging-attachments",
      "title": "Messaging & Attachments",
      "blocks": [
        {
          "type": "text",
          "content": "The message service backs in-app messaging: system announcements (broadcast to every org), org-to-org conversations, support threads, and per-user direct messages (a conversation targeted at a single user within the recipient org via recipientUserId — only that user, plus the sender org and system org, can see it). Messages may carry file/image attachments, stored in S3-compatible object storage (MinIO by default)."
        },
        {
          "type": "table",
          "headers": [
            "Variable",
            "Default",
            "Description"
          ],
          "rows": [
            [
              "SUPPORT_ALIASES",
              "support@pipeline-builder,help@pipeline-builder",
              "Comma-separated support inbox aliases. Any of them resolves to the system support org on send; the compose recipient picker lists all of them as suggestions (the first is the primary, prefilled default)."
            ],
            [
              "S3_ENDPOINT",
              "http://minio:9000",
              "S3-compatible endpoint for attachment storage. Empty ⇒ default AWS S3 (no custom endpoint)."
            ],
            [
              "S3_BUCKET",
              "message-attachments",
              "Bucket for attachment blobs (auto-created on first upload)."
            ],
            [
              "S3_REGION",
              "us-east-1",
              "S3 region."
            ],
            [
              "S3_ACCESS_KEY_ID",
              "message-svc",
              "Per-service, bucket-scoped access key (created by the minio-init bootstrap — not the MinIO root creds)."
            ],
            [
              "S3_SECRET_ACCESS_KEY",
              "message-svc-secret",
              "Secret key. Change for any real deployment."
            ],
            [
              "S3_FORCE_PATH_STYLE",
              "true",
              "Path-style addressing (required by MinIO; harmless for real S3)."
            ],
            [
              "MESSAGE_ATTACHMENT_MAX_MB",
              "10",
              "Max attachment size (MiB). Uploads over this are rejected 413."
            ]
          ]
        },
        {
          "type": "note",
          "content": "MinIO backs more than attachments now: the container registry (S3 storage driver), Loki (log chunks + index), and Thanos (Prometheus long-term blocks) each use their own bucket + a per-service, bucket-scoped key (registry-svc / loki-svc / thanos-svc), all created by the minio-init bootstrap. See Deploy Operations → Object storage (MinIO) for the bucket table + HA topology (distributed StatefulSet on EKS, SNMD on ec2, single-drive on docker/minikube)."
        },
        {
          "type": "text",
          "content": "Attachments are validated against a MIME allow-list (common images + documents; no executables/scripts/HTML). Downloads are auth-gated and inherit the parent message's visibility, so a per-user targeted message's attachment stays private to its target. Blobs are reclaimed when a message is hard-purged by the retention sweep."
        }
      ]
    },
    {
      "id": "compliance",
      "title": "Compliance",
      "blocks": [
        {
          "type": "table",
          "headers": [
            "Variable",
            "Default",
            "Description"
          ],
          "rows": [
            [
              "COMPLIANCE_BYPASS",
              "false",
              "Bypass compliance checks when service is unavailable (dev/DR only)"
            ],
            [
              "COMPLIANCE_ENABLED",
              "true",
              "Enable compliance enforcement"
            ],
            [
              "SCAN_SCHEDULER_INTERVAL_MS",
              "60000",
              "Compliance scan scheduler interval (ms)"
            ],
            [
              "SYSTEM_ORG_SCANS_ENABLED",
              "false",
              "Run scheduled scans for the system org too"
            ],
            [
              "SCAN_LOCK_TTL_MS",
              "300000",
              "Scan scheduler cross-pod leader-lock TTL (ms); only one replica sweeps per tick"
            ],
            [
              "COMPLIANCE_SCAN_STALE_TIMEOUT_MS",
              "7200000",
              "Mark a scan failed once it has been running this long (min 60000)"
            ],
            [
              "DIGEST_SCHEDULER_INTERVAL_MS",
              "3600000",
              "How often the notification digest scheduler checks for due daily/weekly digests (ms)"
            ],
            [
              "DIGEST_LOCK_TTL_MS",
              "300000",
              "Digest scheduler cross-pod leader-lock TTL (ms)"
            ]
          ]
        }
      ]
    },
    {
      "id": "email",
      "title": "Email",
      "blocks": [
        {
          "type": "table",
          "headers": [
            "Variable",
            "Default",
            "Description"
          ],
          "rows": [
            [
              "EMAIL_ENABLED",
              "false",
              "Enable email sending"
            ],
            [
              "EMAIL_FROM",
              "noreply@example.com",
              "Sender address"
            ],
            [
              "EMAIL_FROM_NAME",
              "pipeline-builder",
              "Sender display name"
            ],
            [
              "EMAIL_PROVIDER",
              "smtp",
              "smtp or ses"
            ],
            [
              "SMTP_HOST",
              "localhost",
              "SMTP host"
            ],
            [
              "SMTP_PORT",
              "587",
              "SMTP port"
            ],
            [
              "SMTP_SECURE",
              "false",
              "Use TLS"
            ],
            [
              "SMTP_USER",
              "—",
              "SMTP username"
            ],
            [
              "SMTP_PASS",
              "—",
              "SMTP password"
            ]
          ]
        },
        {
          "type": "text",
          "content": "For AWS SES: set EMAIL_PROVIDER=ses with SES_REGION, SES_ACCESS_KEY_ID, SES_SECRET_ACCESS_KEY."
        }
      ]
    },
    {
      "id": "billing",
      "title": "Billing",
      "blocks": [
        {
          "type": "table",
          "headers": [
            "Variable",
            "Default",
            "Description"
          ],
          "rows": [
            [
              "BILLING_ENABLED",
              "true",
              "Enable billing (opt-out — on unless set to false). When false, new orgs default to the uncapped unlimited tier and no plans/tiers are offered; when true, unlimited is hidden and orgs get DEFAULT_QUOTA_TIER (default developer)."
            ],
            [
              "BILLING_PROVIDER",
              "stub",
              "stub, aws-marketplace, or stripe"
            ],
            [
              "BILLING_SERVICE_HOST",
              "billing",
              "Service hostname"
            ],
            [
              "BILLING_SERVICE_PORT",
              "3000",
              "Service port"
            ],
            [
              "BILLING_LIFECYCLE_CHECK_INTERVAL_MS",
              "3600000",
              "Subscription lifecycle check interval (1 hour)"
            ],
            [
              "PAYMENT_GRACE_PERIOD_DAYS",
              "7",
              "Grace period for overdue payments"
            ],
            [
              "RENEWAL_REMINDER_DAYS",
              "7",
              "Days before expiry to send renewal reminder"
            ],
            [
              "BILLING_BUNDLES_ENABLED",
              "false",
              "Master switch for purchasable add-on bundles — hidden unless set"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Plan pricing (BILLING_PLAN_{TIER}_MONTHLY / BILLING_PLAN_{TIER}_ANNUAL, where {TIER} is DEVELOPER, PRO, TEAM, or ENTERPRISE) is in cents. Defaults: Developer free, Pro $39/mo ($390/yr), Team $79/mo ($790/yr), Enterprise $599/mo ($5,990/yr). Per-plan _NAME (display name), _DESCRIPTION (string), and _FEATURES (JSON array) can also be overridden."
        },
        {
          "type": "text",
          "content": "An UNLIMITED plan (free, BILLING_PLAN_UNLIMITED_NAME default Unlimited) is also seeded so the billing store has a row for orgs on the billing-disabled default tier, but it is filtered out of the customer-facing plans list — it is never sold or shown when billing is enabled."
        },
        {
          "type": "text",
          "content": "Add-on bundles are env-tunable (see Billing Add-on Bundles → Overrides): BILLING_BUNDLE_<ID>_MONTHLY / _ANNUAL (price, cents), BILLING_BUNDLE_<ID>_GRANT (single-dimension grant amount), BILLING_BUNDLE_<ID>_TIERS (JSON array of purchasable tiers), and BILLING_BUNDLE_<ID>_VOLUME_TIERS (JSON array of {minQuantity, discountPercent} for a per-unit volume discount — used by SEAT), where <ID> is the bundle id upper-cased (SEAT, PIPELINE_PACK, PLUGIN_PACK, API_PACK, AI_PACK, STORAGE_PACK, RETENTION_PACK, DORA_HISTORY_PACK, SSO, ADVANCED_REPORTING, TEAM_USAGE_ANALYTICS, COMPLIANCE_STANDARD, COMPLIANCE_ADVANCED). Combo prices are BILLING_COMBO_<COMBO>_MONTHLY / _ANNUAL where <COMBO> is ANALYTICS_SUITE, TEAM_GROWTH, COMPLIANCE_SUITE, or SCALE_BUNDLE. The retention packs default to $15/mo ($150/yr, RETENTION_PACK) and $30/mo ($300/yr, DORA_HISTORY_PACK); under AWS Marketplace they meter as the RetentionPack / DoraHistoryPack dimensions (see AWS_MARKETPLACE_BUNDLE_DIMENSION_MAP)."
        },
        {
          "type": "text",
          "content": "The compliance content add-ons default to $29.90/mo ($299/yr, COMPLIANCE_STANDARD) and $99.90/mo ($999/yr, COMPLIANCE_ADVANCED, which requires Standard), with the COMPLIANCE_SUITE combo (both, 30% off) at $90.86/mo ($908.60/yr) — see Compliance → Curated content add-ons. On every entitlement change (purchase/cancel/renewal) billing pushes the org's entitled content sets to the compliance service (PUT /api/compliance/entitlements/:orgId, which auto-subscribes/activates on gain and deactivates on loss), reaching it via COMPLIANCE_SERVICE_HOST / COMPLIANCE_SERVICE_PORT (Service Discovery, above)."
        },
        {
          "type": "text",
          "content": "Stripe (BILLING_PROVIDER=stripe)"
        },
        {
          "type": "text",
          "content": "Direct SaaS billing through Stripe. For the full setup walkthrough (creating Products/Prices, registering the webhook, testing with the Stripe CLI, going live) see Billing Providers → Stripe."
        },
        {
          "type": "table",
          "headers": [
            "Variable",
            "Default",
            "Description"
          ],
          "rows": [
            [
              "STRIPE_SECRET_KEY",
              "—",
              "Secret. Stripe API secret key (sk_test_… / sk_live_…). Required when BILLING_PROVIDER=stripe"
            ],
            [
              "STRIPE_WEBHOOK_SECRET",
              "—",
              "Secret. Signing secret (whsec_…) for POST /billing/stripe/webhook; every delivery is signature-verified against it over the raw body"
            ],
            [
              "STRIPE_PRICE_MAP",
              "{}",
              "JSON map of <id>_<interval> → Stripe Price id, where <id> is a plan id or an add-on bundle id, e.g. {\"pro_monthly\":\"price_…\",\"seat_annual\":\"price_…\"}. A plan/interval absent here cannot be subscribed (creation fails fast); a bundle absent here is granted but its line item is skipped (not charged). Provision every plan + bundle Price once (Stripe Prices are immutable) with STRIPE_SECRET_KEY=… node api/billing/scripts/provision-stripe-prices.mjs (add --dry-run to preview), then paste its JSON here"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Stripe subscription statuses map to internal statuses via a fixed table (not env-configurable): unpaid ⇒ canceled (set only after the grace period), unknown ⇒ incomplete."
        },
        {
          "type": "text",
          "content": "Discounts"
        },
        {
          "type": "text",
          "content": "Discount codes + usage credits (docs/billing-discounts.md) — Stripe only, on by default."
        },
        {
          "type": "table",
          "headers": [
            "Variable",
            "Default",
            "Description"
          ],
          "rows": [
            [
              "BILLING_DISCOUNTS_ENABLED",
              "true",
              "Master switch — set false to 404 the discount routes. Also governs Marketplace metered-credit realization (same value for both providers)"
            ],
            [
              "BILLING_DISCOUNT_KEYS",
              "—",
              "Secret. AES-256-GCM signing keys for discount tokens, v1:<base64-32B>,v2:…; the highest version mints, older keys still decode (rotation). Required to issue Mode-B tokens"
            ],
            [
              "BILLING_DISCOUNT_MAX_PERCENT",
              "100",
              "Mint-time ceiling on a percent discount (1-100)"
            ],
            [
              "BILLING_DISCOUNT_MAX_CENTS",
              "10000000",
              "Mint-time ceiling on a dollar/credit discount, in cents ($100k)"
            ],
            [
              "BILLING_PROMOTIONS_ENABLED",
              "true",
              "Master switch for promotions (rule-driven auto-grant campaigns). Same opt-out default as BILLING_DISCOUNTS_ENABLED (on unless set to false). Additionally requires BILLING_DISCOUNTS_ENABLED (shared usage-credit machinery), so discounts off ⇒ promotions off; the routes 404 and the auto-grant engine no-ops when off"
            ],
            [
              "BILLING_PROMOTION_BACKFILL_INTERVAL_MS",
              "3600000",
              "Backfill-cron cadence (1h). Re-scans eligible-but-ungranted orgs so a transient failure or a late-activated campaign still lands. Leader-locked; idempotent"
            ],
            [
              "BILLING_PROMOTION_CLAWBACK_WINDOW_MS",
              "604800000",
              "Clawback window (7d). A promotion grant is reversed (ledger row pulled, balance reduced, budget released) if the subscription cancels within this window of the grant — defuses signup-grab-churn"
            ]
          ]
        },
        {
          "type": "text",
          "content": "BILLING_DISCOUNT_KEYS is a secret — provision it via a sealed secret / SSM, never commit a real value. Losing it makes previously issued Mode-B tokens undecodable (already-applied discounts on subscriptions are unaffected)."
        },
        {
          "type": "text",
          "content": "AWS Marketplace metering & credit realization"
        },
        {
          "type": "text",
          "content": "For BILLING_PROVIDER=aws-marketplace: add-on charges are reported as metered usage, and usage-credit discounts realize by withholding metered units (see docs/billing-discounts.md). Metering is default-off and the two switches (BILLING_DISCOUNTS_ENABLED + BILLING_METERING_ENABLED) must both be on before a Marketplace credit is accepted — otherwise a credit would bank but never reduce the AWS bill. For the full listing/fulfillment/SNS/IAM setup walkthrough see Billing Providers → AWS Marketplace."
        },
        {
          "type": "table",
          "headers": [
            "Variable",
            "Default",
            "Description"
          ],
          "rows": [
            [
              "BILLING_METERING_ENABLED",
              "false",
              "Run the metering cycle (report add-on usage + realize credits). Off = no metering, and Marketplace credits are rejected"
            ],
            [
              "BILLING_METERING_INTERVAL_MS",
              "3600000",
              "Metering cycle cadence (1 hour). AWS BatchMeterUsage dedupes by (customer, dimension, hour)"
            ],
            [
              "BILLING_METERING_DRAWDOWN_DRYRUN",
              "false",
              "Shadow mode — compute + log the intended credit withholding but report FULL quantities and leave the balance untouched. Validate the price map before going live"
            ],
            [
              "AWS_MARKETPLACE_PRODUCT_CODE",
              "—",
              "The Marketplace product code"
            ],
            [
              "AWS_MARKETPLACE_REGION",
              "AWS_REGION or us-east-1",
              "Region for the Metering/Entitlement clients"
            ],
            [
              "AWS_MARKETPLACE_SNS_TOPIC_ARN",
              "—",
              "Comma-separated SNS topic ARNs accepted by the webhook — set both the subscription and entitlement topics"
            ],
            [
              "AWS_MARKETPLACE_DIMENSION_MAP",
              "identity",
              "JSON map of Marketplace dimension → local plan id"
            ],
            [
              "AWS_MARKETPLACE_BUNDLE_DIMENSION_MAP",
              "identity",
              "JSON map of add-on bundle id → metered dimension key"
            ],
            [
              "AWS_MARKETPLACE_DIMENSION_PRICE_MAP",
              "{}",
              "JSON map of metered dimension → local list price in cents per metered unit per metering cycle (cycle = BILLING_METERING_INTERVAL_MS). Drives the credit drawdown; an unpriced dimension is never drawn against (reported in full). A wrong value directly mis-draws credit — mirror it to your AWS listing and cadence"
            ]
          ]
        },
        {
          "type": "note",
          "content": "Money-movement caution: the credit drawdown is real billing behavior. Keep BILLING_METERING_ENABLED=false until AWS_MARKETPLACE_DIMENSION_PRICE_MAP is validated (use the dry-run), and note that withholding offsets metered add-on usage only — plan-level reductions belong to AWS Marketplace private offers."
        }
      ]
    },
    {
      "id": "reporting-dora",
      "title": "Reporting & DORA",
      "blocks": [
        {
          "type": "text",
          "content": "Event reporting (setup-events → the reporting service) and DORA metrics. All are optional — the platform runs on the defaults. DORA metrics sit behind the advanced_reporting entitlement; see DORA Metrics. Retention windows are tier-aware and bundle-extendable (effective window = tier baseline + Σ retention-pack grant, computed by billing and synced into dora_settings) and additionally per-organization overridable via the org's reporting settings; the REPORTING_* values below are the deployment-wide fallback used when neither a tier baseline nor an org override applies. The per-tier baselines are set by QUOTA_TIER_<TIER>_EVENT_RETENTION_DAYS / QUOTA_TIER_<TIER>_DORA_RETENTION_DAYS (see below)."
        },
        {
          "type": "table",
          "headers": [
            "Variable",
            "Default",
            "Description"
          ],
          "rows": [
            [
              "PLATFORM_ACCESS_KEY",
              "—",
              "Set on the event-ingestion Lambda (not a service var) to hand it the reporting:ingest service-account key directly, skipping the Secrets Manager read. Normally unset: setup-events points the Lambda at PLATFORM_SECRET_NAME instead, which is also the only form the key ROTATOR can replace — an env-provided key cannot change without a redeploy. A JWT here is refused at startup with the fix named."
            ],
            [
              "PLATFORM_SECRET_NAME",
              "—",
              "Set on the event-ingestion Lambda and the key-rotation Lambda (not a service var) to the Secrets Manager secret holding the service-account key in its password field (pipeline-builder/{orgId}/reporting-ingest). Written by pipeline-manager infra store-token; wired by infra setup-events --scoped-ingest."
            ],
            [
              "DORA_ENABLED",
              "false",
              "Set on the event-ingestion Lambda (not a service var) to enable DORA lead-time commit-range resolution in your AWS account (SCM calls + github-token read). Toggle via pipeline-manager infra setup-events --with-dora, not by hand. Off ⇒ standard reporting still works and DORA lead time reports unknown."
            ],
            [
              "DORA_INCIDENT_WINDOW_HOURS",
              "24",
              "Reporting service. Window in which a production incident correlates to the most recent deploy (feeds post-deploy CFR / MTTR). Per-org override via dora_settings."
            ],
            [
              "REPORTING_RETENTION_ENABLED",
              "true",
              "Master switch for the retention purge sweep. Set false to keep all reporting history forever — recommended for self-hosted / unlimited-tier deployments that want unbounded retention."
            ],
            [
              "REPORTING_EVENT_RETENTION_DAYS",
              "30",
              "Retention (days) for standard pipeline events (non-deploy STAGE / ACTION / build). Older rows are purged by the sweep. Per-org override via dora_settings."
            ],
            [
              "REPORTING_DORA_RETENTION_DAYS",
              "180",
              "Retention (days) for DORA-source records (deploy-stage events + deployment outcomes + incidents) — ~2 quarters. Per-org override via dora_settings."
            ],
            [
              "REPORTING_RETENTION_INTERVAL_HOURS",
              "12",
              "How often the leader-locked retention sweep runs."
            ]
          ]
        },
        {
          "type": "text",
          "content": "The retention window is a tier baseline that add-on retention packs extend. Each tier's baseline is overridable per-environment:"
        },
        {
          "type": "table",
          "headers": [
            "Variable",
            "Default",
            "Description"
          ],
          "rows": [
            [
              "QUOTA_TIER_<TIER>_EVENT_RETENTION_DAYS",
              "30 (paid tiers) / unlimited on unlimited",
              "Per-tier baseline retention (days) for standard pipeline events, where <TIER> is DEVELOPER, PRO, TEAM, ENTERPRISE, or UNLIMITED. The unlimited tier derives -1 (unlimited — the sweep skips the org and keeps all history). The Standard Retention Pack add-on adds +90 days on top."
            ],
            [
              "QUOTA_TIER_<TIER>_DORA_RETENTION_DAYS",
              "180 (paid tiers) / unlimited on unlimited",
              "Per-tier baseline retention (days) for DORA-source records. The unlimited tier derives -1. The DORA History Pack add-on adds +365 days on top (and widens the report-query window to match)."
            ]
          ]
        },
        {
          "type": "text",
          "content": "Billing computes the effective window (tierBase + Σ pack grant, -1 = unlimited passthrough) and pushes it to the reporting service (PUT /api/reports/retention-sync/:orgId, writing dora_settings). The per-org report-query window tracks this effective retention (min(730, orgRetentionDays), absolute ceiling 730 days); an unlimited-tier org queries up to the 730-day ceiling."
        }
      ]
    },
    {
      "id": "aws-cdk-lambda",
      "title": "AWS CDK / Lambda",
      "blocks": [
        {
          "type": "table",
          "headers": [
            "Variable",
            "Default",
            "Description"
          ],
          "rows": [
            [
              "LAMBDA_RUNTIME",
              "nodejs24.x",
              "Lambda runtime"
            ],
            [
              "LAMBDA_TIMEOUT",
              "900",
              "Timeout (seconds)"
            ],
            [
              "LAMBDA_MEMORY_SIZE",
              "512",
              "Memory (MB)"
            ],
            [
              "LAMBDA_ARCHITECTURE",
              "ARM_64",
              "Plugin-lookup Lambda architecture: ARM_64 or x86_64"
            ],
            [
              "CODEBUILD_COMPUTE_TYPE",
              "SMALL",
              "SMALL, MEDIUM, LARGE, X2_LARGE"
            ],
            [
              "LOG_GROUP_NAME",
              "/pipeline-builder/logs",
              "CloudWatch log group"
            ],
            [
              "SECRETS_PATH_PREFIX",
              "pipeline-builder",
              "AWS Secrets Manager path prefix"
            ]
          ]
        }
      ]
    },
    {
      "id": "scaling-multi-replica-optional",
      "title": "Scaling & multi-replica (Optional)",
      "blocks": [
        {
          "type": "text",
          "content": "All optional (defaults shown). They tune behavior that matters only under horizontal scaling (>1 replica) or high load."
        },
        {
          "type": "note",
          "content": "Redis is required for multi-replica correctness. OAuth/SSO login CSRF state + nonce, SSE build-log delivery, the message service's SSE notification tickets (minted on one pod, redeemed on another), keyed-mutation idempotency (e.g. POST /messages), step-up single-use tokens, and the background sweep leader locks (org-purge, invitation-reaper, billing-reconcile, registry GC) all use the shared Redis when running with more than one replica. Without Redis they degrade to per-pod behavior, which is correct only on a single replica — e.g. round-robin between replicas would fail OAuth/SSO logins (state/nonce minted on one pod, validated on another), reject valid message-notification SSE connections (ticket minted on pod A, redeemed on pod B), and drop live build-log lines."
        },
        {
          "type": "table",
          "headers": [
            "Variable",
            "Default",
            "Description"
          ],
          "rows": [
            [
              "PIPELINE_EXEC_IDEMPOTENCY_WINDOW_SECONDS",
              "60",
              "Window for the execution-trigger idempotency guard — a duplicate POST /pipelines/:id/executions within it is a no-op, not a second CodePipeline run"
            ],
            [
              "BILLING_WEBHOOK_INPROGRESS_TTL_SECONDS",
              "300",
              "Webhook in-progress lock TTL — a crash mid-processing releases the claim after this so the provider's retry re-runs the event's side-effects (not dropped as a duplicate)"
            ],
            [
              "COMPLIANCE_VALIDATE_TIMEOUT_MS",
              "4000",
              "Per-attempt timeout for the fail-closed compliance validate call (now retried, so a transient blip doesn't reject a legit upload/create)"
            ],
            [
              "HTTP_CLIENT_MAX_SOCKETS",
              "64",
              "Max sockets per internal HTTP keep-alive agent (was unbounded)"
            ],
            [
              "REGISTRY_GC_LOCK_TTL_MS",
              "900000",
              "Image-registry GC leader-lock TTL (ms); only one replica runs the destructive GC sweep at a time"
            ]
          ]
        }
      ]
    },
    {
      "id": "timeouts",
      "title": "Timeouts",
      "blocks": [
        {
          "type": "table",
          "headers": [
            "Variable",
            "Default",
            "Description"
          ],
          "rows": [
            [
              "HANDLER_TIMEOUT_MS",
              "25000",
              "Global HTTP request timeout (25s)"
            ],
            [
              "PLUGIN_UPLOAD_TIMEOUT_MS",
              "300000",
              "Upload route timeout override (5 min)"
            ],
            [
              "DOCKER_BUILD_TIMEOUT_MS",
              "900000",
              "Docker build timeout (15 min)"
            ],
            [
              "DOCKER_PUSH_TIMEOUT_MS",
              "300000",
              "Docker push timeout (5 min)"
            ],
            [
              "SERVICE_TIMEOUT",
              "30000",
              "Inter-service HTTP call timeout"
            ],
            [
              "HTTP_CLIENT_TIMEOUT",
              "5000",
              "Internal HTTP client timeout"
            ],
            [
              "HTTP_CLIENT_MAX_RETRIES",
              "2",
              "Internal HTTP client retries"
            ],
            [
              "HTTP_CLIENT_RETRY_DELAY_MS",
              "200",
              "Internal HTTP client retry delay"
            ],
            [
              "QUOTA_SERVICE_TIMEOUT",
              "5000",
              "Quota service call timeout"
            ],
            [
              "BILLING_SERVICE_TIMEOUT",
              "5000",
              "Billing service call timeout"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Plugin Upload Timeout Chain"
        },
        {
          "type": "text",
          "content": "When uploading a large plugin ZIP (up to 4GB with prebuilt image.tar), the request passes through multiple timeout layers. Each layer must allow enough time for the upload to complete:"
        },
        {
          "type": "code",
          "content": "Client (curl)                    UPLOAD_TIMEOUT = 900s (15 min)\n  └─ nginx proxy_read_timeout    900s (shipped configs); nginx's own default is 60s\n      └─ Express route           PLUGIN_UPLOAD_TIMEOUT_MS = 300s (5 min)\n          └─ Express global      HANDLER_TIMEOUT_MS = 25s (overridden by route)\n              └─ Build queue     DOCKER_BUILD_TIMEOUT_MS = 900s (15 min, async)\n                  └─ Push        DOCKER_PUSH_TIMEOUT_MS = 300s (5 min, async)"
        },
        {
          "type": "text",
          "content": "The upload request returns 202 Accepted after the ZIP is parsed and the build job is enqueued. The Docker build and push happen asynchronously in the build queue — their timeouts do not affect the upload response."
        },
        {
          "type": "text",
          "content": "If uploads fail with 503 (timeout): Increase PLUGIN_UPLOAD_TIMEOUT_MS and ensure nginx proxy_read_timeout is at least as long (the shipped nginx configs already set it to 900s for the upload route). Do not increase HANDLER_TIMEOUT_MS — it applies globally to all routes."
        }
      ]
    },
    {
      "id": "caching",
      "title": "Caching",
      "blocks": [
        {
          "type": "table",
          "headers": [
            "Variable",
            "Default",
            "Description"
          ],
          "rows": [
            [
              "CACHE_TTL_ENTITY",
              "60",
              "Entity cache TTL (seconds)"
            ],
            [
              "CACHE_TTL_MESSAGE",
              "300",
              "Message cache TTL (seconds)"
            ],
            [
              "CACHE_TTL_REPORT_INVENTORY",
              "300",
              "Report inventory cache TTL (seconds)"
            ],
            [
              "CACHE_TTL_REPORT_TIMESERIES",
              "120",
              "Report timeseries cache TTL (seconds)"
            ],
            [
              "CACHE_TTL_COMPLIANCE_RULES",
              "60",
              "Compliance rules cache TTL (seconds)"
            ],
            [
              "CACHE_TTL_BILLING_PLANS",
              "14400",
              "Billing plans cache TTL (4 hours)"
            ],
            [
              "CACHE_CLEANUP_INTERVAL_MS",
              "30000",
              "Cache cleanup interval (30s)"
            ]
          ]
        }
      ]
    },
    {
      "id": "server-sent-events",
      "title": "Server-Sent Events",
      "blocks": [
        {
          "type": "table",
          "headers": [
            "Variable",
            "Default",
            "Description"
          ],
          "rows": [
            [
              "SSE_MAX_CLIENTS_PER_REQUEST",
              "10",
              "Max SSE clients per request ID"
            ],
            [
              "SSE_CLIENT_TIMEOUT_MS",
              "1800000",
              "SSE client timeout (30 min)"
            ],
            [
              "SSE_CLEANUP_INTERVAL_MS",
              "300000",
              "SSE cleanup interval (5 min)"
            ],
            [
              "SSE_STREAM_TIMEOUT_MS",
              "300000",
              "SSE stream timeout (5 min)"
            ],
            [
              "SSE_BACKPRESSURE_THRESHOLD",
              "10",
              "SSE backpressure threshold"
            ],
            [
              "SSE_MAX_TOTAL_TICKETS",
              "1000",
              "Message service: cap on notification SSE tickets minted per TTL window across all orgs (Redis-backed when configured; abuse bound)"
            ],
            [
              "SSE_MAX_TICKETS_PER_ORG",
              "10",
              "Message service: per-org cap on notification SSE tickets minted per TTL window"
            ]
          ]
        }
      ]
    },
    {
      "id": "observability-logs",
      "title": "Observability & Logs",
      "blocks": [
        {
          "type": "table",
          "headers": [
            "Variable",
            "Default",
            "Description"
          ],
          "rows": [
            [
              "PROMETHEUS_URL",
              "http://prometheus:9090",
              "Metrics backend for the native dashboards"
            ],
            [
              "LOKI_URL",
              "http://loki:3100",
              "Log backend for Deliver → Logs. Platform sends X-Scope-OrgID per request, derived from the caller's verified token"
            ],
            [
              "LOKI_BASE_SELECTOR",
              "service_name=~\".+\"",
              "Anchor matcher used when a log query constrains no label. Override on a deployment whose non-JSON producers people need to browse"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Loki itself runs with auth_enabled: true so each organization is a tenant — see Logs: Operating for the Loki-side settings that go with it."
        }
      ]
    },
    {
      "id": "admin-uis-infrastructure",
      "title": "Admin UIs (Infrastructure)",
      "blocks": [
        {
          "type": "text",
          "content": "These variables configure infrastructure admin tools, not application code."
        },
        {
          "type": "table",
          "headers": [
            "Variable",
            "Default",
            "Description"
          ],
          "rows": [
            [
              "PGADMIN_DEFAULT_EMAIL",
              "admin@pipeline.dev",
              "pgAdmin login email"
            ],
            [
              "PGADMIN_DEFAULT_PASSWORD",
              "—",
              "pgAdmin login password"
            ],
            [
              "ME_CONFIG_BASICAUTH_USERNAME",
              "admin",
              "Mongo Express username"
            ],
            [
              "ME_CONFIG_BASICAUTH_PASSWORD",
              "—",
              "Mongo Express password"
            ]
          ]
        }
      ]
    },
    {
      "id": "pagination-limits",
      "title": "Pagination & Limits",
      "blocks": [
        {
          "type": "table",
          "headers": [
            "Variable",
            "Default",
            "Description"
          ],
          "rows": [
            [
              "MAX_PAGE_LIMIT",
              "1000",
              "Max page size"
            ],
            [
              "DEFAULT_PAGE_LIMIT",
              "100",
              "Default page size"
            ],
            [
              "MAX_PROMPT_LENGTH",
              "5000",
              "Max AI prompt length"
            ],
            [
              "MAX_BULK_ITEMS",
              "100",
              "Max items per bulk operation"
            ],
            [
              "MAX_EVENTS_PER_BATCH",
              "100",
              "Max events per batch ingestion"
            ],
            [
              "INVITATION_EXPIRATION_DAYS",
              "7",
              "Org invitation expiry"
            ],
            [
              "INVITATION_MAX_PENDING_PER_ORG",
              "50",
              "Max pending invitations per org"
            ]
          ]
        }
      ]
    },
    {
      "id": "ai-providers-optional",
      "title": "AI Providers (Optional)",
      "blocks": [
        {
          "type": "table",
          "headers": [
            "Variable",
            "Description"
          ],
          "rows": [
            [
              "ANTHROPIC_API_KEY",
              "Anthropic API key"
            ],
            [
              "OPENAI_API_KEY",
              "OpenAI API key"
            ],
            [
              "GOOGLE_GENERATIVE_AI_API_KEY",
              "Google AI API key"
            ],
            [
              "XAI_API_KEY",
              "xAI API key"
            ],
            [
              "AI_PROVIDER",
              "(CLI infra provision) Provider to use: anthropic (default), openai, google, xai, bedrock"
            ],
            [
              "AI_MODEL",
              "(CLI infra provision) Model id override (defaults to the provider's first model)"
            ]
          ]
        },
        {
          "type": "text",
          "content": "At least one provider key is required for AI-powered pipeline and plugin generation. The same keys (plus the optional AI_PROVIDER / AI_MODEL) enable the pipeline-manager infra provision advisor's natural-language goal parsing and failure diagnosis; without a key, infra provision falls back to its deterministic prereq-check + command-assembly path. See the AI plugins documentation for supported providers and models."
        },
        {
          "type": "text",
          "content": "Self-hosted / local model (OpenAI-compatible)"
        },
        {
          "type": "text",
          "content": "Point the provider registry at any OpenAI-compatible endpoint — a Docker model image (Ollama, Docker Model Runner, vLLM) or another self-hosted server — instead of, or in addition to, the cloud providers above. The provider id is openai-compatible; it registers only when a base URL is set, and its model list is deployment-defined (not part of the static catalog)."
        },
        {
          "type": "table",
          "headers": [
            "Variable",
            "Description"
          ],
          "rows": [
            [
              "OPENAI_COMPATIBLE_BASE_URL",
              "Endpoint that speaks the OpenAI chat API, e.g. http://ask-model:11434/v1. Setting this enables the openai-compatible provider."
            ],
            [
              "OPENAI_COMPATIBLE_MODELS",
              "Comma-separated model list the endpoint serves, each `id[",
              "Display Name] (e.g. qwen2.5-coder:7b",
              "Qwen 2.5 Coder, llama3.1:8b`)."
            ],
            [
              "OPENAI_COMPATIBLE_MODEL",
              "Single-model fallback used when OPENAI_COMPATIBLE_MODELS is unset. Defaults to `local",
              "Local model`."
            ],
            [
              "OPENAI_COMPATIBLE_NAME",
              "Display name for the provider (defaults to Local model (OpenAI-compatible))."
            ],
            [
              "OPENAI_COMPATIBLE_API_KEY",
              "Optional. Most local servers ignore it; a placeholder is sent when unset."
            ]
          ]
        },
        {
          "type": "text",
          "content": "The deploy targets ship an Ollama model container you can use instead of running your own endpoint. How it is enabled differs per target:"
        },
        {
          "type": "list",
          "items": [
            "aws/ec2, aws/eks (deploy/aws/{ec2,eks}/k8s/ask-model.yaml) — deployed by default (listed in kustomization.yaml), with OPENAI_COMPATIBLE_BASE_URL=http://ask-model:11434/v1 + OPENAI_COMPATIBLE_MODELS=qwen2.5-coder:7b|Qwen 2.5 Coder already set on the ask Deployment. A 7B tool-capable model needs ~6–8Gi RAM (CPU) or a GPU (uncomment the nodeSelector/tolerations + nvidia.com/gpu limit). On ec2, LEAN=1 drops it — at 6Gi it does not fit the t3.xlarge that LEAN targets — along with the ask env that points at it.",
            "local/minikube — opt-in, because a 6Gi request will not schedule on a laptop-sized VM: ASK_MODEL=1 deploy/local/minikube/bin/setup.sh (or the same flag on startup.sh for an already-provisioned cluster) applies the manifest and wires the two env vars into the app-env ConfigMap. The minikube copy runs the 1.5B at a 1536Mi request.",
            "local/docker (deploy/local/docker/docker-compose.yml) — behind the ask-model compose profile: docker compose --profile ask-model up -d, then uncomment OPENAI_COMPATIBLE_BASE_URL/OPENAI_COMPATIBLE_MODELS in .env and docker compose up -d ask so the change reaches the service."
          ]
        },
        {
          "type": "text",
          "content": "Override the served model with OLLAMA_MODEL (default qwen2.5-coder:7b). It must name the same model OPENAI_COMPATIBLE_MODELS advertises — advertising one the container has not pulled sends the request to a server that has never heard of it, which closes the connection mid-stream (AI_APICallError: Cannot connect to API: other side closed). Guarding that is why the workload is held NotReady/unhealthy until ollama list actually shows the model (a startupProbe in k8s, a healthcheck on docker) rather than merely until the server is listening. Model weights persist on the ask-model-models volume/PVC."
        }
      ]
    }
  ],
  "sourceDoc": "docs/environment-variables.md"
};
