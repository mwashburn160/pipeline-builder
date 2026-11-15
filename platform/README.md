# platform

The identity, authentication, and organization service at the center of the platform — the source of truth for users, organizations, RBAC, and JWT issuance that every other service authenticates against.

## Responsibilities

- **Authentication & JWT issuance** — registration, login, refresh, logout, org switching, email verification, and step-up re-authentication; issues the access/refresh token pair every other service verifies.
- **User management** — self-service profile, password changes, API-token issuance/revocation, plus system-admin user administration.
- **Organizations** — multi-tenant containers for pipelines, plugins, and quotas; org-to-team hierarchy (descendants/subtree), tier and quota management, GDPR export, and cascading deletion.
- **RBAC / roles & write-access enforcement** — the coarse per-org label (`owner` | `admin` | `member`) is *derived* from a user's Roles and resolved from the `UserOrganization` junction (it governs ownership, seat accounting, and `isAdmin`, not permissions), plus platform `superadmin`, and a read-only impersonation gate that blocks state-changing requests.
- **Roles & memberships** — first-class Roles (e.g. Admin, Member, the system org's Super Admin) that carry explicit `resource:action` permissions; a user's effective permissions are the union of their assigned Roles, and Role membership still drives the derived, cached `UserOrganization.role` label.
- **Audit events** — tamper-resistant, org-scoped audit log (retention-pruned in MongoDB, with signed per-chain retention watermarks) with an internal service-token ingest endpoint for non-platform emitters.
- **Email delivery** — owns the SMTP/SES transport (invitations, verification, password resets, failing-alert-destination notices) and exposes an internal service-token endpoint (`POST /internal/notify-email`) so other services (e.g. compliance) can email an org's users without their own mail stack; resolves recipients (`targetUsers`, or all org admins) from the user directory.

## Endpoints

The API gateway strips the `/api` prefix before proxying; paths below are as mounted in this service.

Platform mounts about 270 routes. They are not listed here by hand — a hand list
drifted (it named a `groups` path that no longer exists, two of six OAuth
providers, and none of SCIM, SSO, TOTP, passkeys, service accounts or the device
flow). The exact, generated list of every route with its permission, step-up,
assurance and audit declarations is
[`frontend/src/generated/route-table/platform.json`](../frontend/src/generated/route-table/platform.json)
(rewritten by `UPDATE_ROUTE_TABLES=1` on `test/route-coverage.test.ts`, which
fails when it is stale), and the reviewed authorization of each gated route is
in [`docs/permission-contract.md`](../docs/permission-contract.md).

The route families:

| Prefix | What it serves |
|--------|----------------|
| `/auth/register`, `/auth/login`, `/auth/mfa/verify`, `/auth/refresh`, `/auth/logout`, `/auth/switch-org` | Password sign-up and sign-in (with the TOTP second leg), token refresh, sign-out, active-org switch |
| `/auth/password/*` | Forgot-password (`reset-request` → emailed single-use link → `reset`) and the sign-in "password no longer meets policy" change |
| `/auth/send-verification`, `/auth/verify-email`, `/auth/mark-email-verified` | Email verification |
| `/auth/oauth/*`, `/auth/sso/*` | Social sign-in (Google, GitHub, GitLab, Microsoft, LinkedIn, Facebook) and per-org SSO (OIDC, Cognito, SAML incl. SLO) |
| `/auth/webauthn/*`, `/auth/totp/*`, `/auth/recovery-codes` | Passkeys, authenticator app, MFA recovery codes |
| `/auth/step-up/*` | Step-up re-verification (password, passkey, TOTP, provider re-auth) |
| `/auth/token/exchange`, `/auth/key/*`, `/auth/device/*` | Access-key exchange and service-account key rotation; the RFC 8628 device flow (`pipeline-manager auth login`) |
| `/auth/onboarding/*` | First-run onboarding and domain-based org discovery / join / withdraw |
| `/user/*` | The caller's own account: profile, password, sessions, tokens, access keys, preferences, MFA prompt, data export (`/user/export`), account deletion (`/user/account`, preview at `/user/account/deletion`) |
| `/users/*` | Member administration, gated by `members:manage` and scoped to the caller's org (cross-org for platform admins) |
| `/organization/*`, `/organizations` | Orgs and teams, members, Roles (`/:id/roles[/:roleId[/members]]`), service accounts, domains and join requests, IdP and security policies, MFA resets, export, soft-delete/restore |
| `/invitation/*` | Invitations |
| `/audit/*` | Audit list, chain verification (`/audit/verify`) and the service-token ingest |
| `/dashboards/*`, `/observability/*` | Dashboards, metrics/logs queries, alert rules and destinations, silences, on-call, Alertmanager webhooks |
| `/scim/*` | SCIM 2.0 provisioning |
| `/admin/*` | Platform-operator surfaces (org IdP, KMS, namespaces, grants, impersonation, summary) |
| `/internal/*` | Service-to-service routes (service-token auth) |
| `/config`, `/health`, `/ready`, `/metrics`, `/.well-known/jwks.json` | Client config, liveness and readiness probes, Prometheus, the user-token public key set |

## Configuration

All config is read from environment variables (see `src/config/index.ts`). The ES256 user-token signing key must be loadable or platform refuses to start, as must platform's own internal service-signing key and the public key bundle; `SECRET_ENCRYPTION_KEY` is required in production for at-rest encryption of provider keys.

| Variable | Purpose | Default |
|----------|---------|---------|
| `PORT` | HTTP listen port | `3000` |
| `MONGODB_URI` | MongoDB connection string (required) | — |
| `TOKEN_SIGNING_MODE` | `local` (PEM on disk) or `kms` — signs every USER token (access, refresh, step-up, exchanged keys) with ES256 | `local` |
| `TOKEN_SIGNING_KEY_FILE` | EC P-256 private key (PKCS#8 PEM) in `local` mode; platform refuses to start without it | — |
| `TOKEN_SIGNING_KMS_KEY_ID` | KMS key **alias** in `kms` mode (`ECC_NIST_P256`, `SIGN_VERIFY`) | — |
| `SERVICE_SIGNING_KEY_FILE` | Platform's OWN ES256 key for the internal service tokens it mints. Cannot mint a user token | required |
| `SERVICE_KEY_BUNDLE_FILE` | The public per-service key bundle it verifies peers' tokens with | required |
| `JWT_EXPIRES_IN` | Access-token TTL (seconds); `JWT_EXPIRES_IN_<TIER>` overrides it per tier | `900` |
| `REFRESH_TOKEN_EXPIRES_IN` | Refresh-token TTL (seconds) | `2592000` |
| `BCRYPT_SALT_ROUNDS` | bcrypt cost factor for password hashing | `12` |
| `PASSWORD_MIN_LENGTH` | Minimum password length | `8` |
| `AUTH_VERIFICATION_TOKEN_TTL_MS` | Email-verification link lifetime (ms) | `86400000` |
| `AUTH_PASSWORD_RESET_TOKEN_TTL_MS` | Forgot-password link lifetime (ms) | `3600000` |
| `SECRET_ENCRYPTION_KEY` | At-rest encryption key for provider/IdP secrets (required in prod) | dev fallback |
| `AUDIT_RETENTION_DAYS` | Audit-event retention (enforced by the watermarking retention prune) | `90` |
| `AUDIT_RETENTION_PRUNE_INTERVAL_MS` | How often the audit retention prune runs | `3600000` |
| `BOOTSTRAP_SUPERADMIN_EMAILS` | Emails granted `isSuperAdmin` at startup | — |
| `MONGO_MAX_POOL` / `MONGO_MIN_POOL` | Mongoose connection pool bounds | `20` / `2` |
| `LIMITER_MAX` / `LIMITER_WINDOW_MS` | General rate-limit budget and window (ms) | `100` / `900000` |
| `AUTH_LIMITER_MAX` / `AUTH_LIMITER_WINDOW_MS` | Auth-endpoint rate-limit budget and window (ms) | `20` / `900000` |
| `CORS_ORIGIN` / `CORS_CREDENTIALS` | Allowed origins (comma-separated) and credentials | frontend URL / `true` |
| `TRUST_PROXY` | Express `trust proxy` hop count | `1` |

> Many additional optional variables configure OAuth, email (SMTP/SES), invitations, observability (Loki/Prometheus), per-org KMS, and sibling-service connections (quota, billing, compliance). See `src/config/index.ts` for the full list.

## Development

```sh
pnpm build   # compile and run the projen build
pnpm test    # run the Jest test suite
```

## License

Apache-2.0
