# platform

The identity, authentication, and organization service at the center of the platform — the source of truth for users, organizations, RBAC, and JWT issuance that every other service authenticates against.

## Responsibilities

- **Authentication & JWT issuance** — registration, login, refresh, logout, org switching, email verification, and step-up re-authentication; issues the access/refresh token pair every other service verifies.
- **User management** — self-service profile, password changes, API-token issuance/revocation, plus system-admin user administration.
- **Organizations** — multi-tenant containers for pipelines, plugins, and quotas; org-to-team hierarchy (descendants/subtree), tier and quota management, GDPR export, and cascading deletion.
- **RBAC / roles & write-access enforcement** — per-org roles (`owner` | `admin` | `member`) resolved from the `UserOrganization` junction, platform `superadmin`, and a read-only impersonation gate that blocks state-changing requests.
- **Groups & memberships** — first-class permission groups (e.g. Administrators, Developers, the system org's Superadmins) whose membership drives the cached `UserOrganization.role`.
- **Audit events** — tamper-resistant, org-scoped audit log (TTL-retained in MongoDB) with an internal service-token ingest endpoint for non-platform emitters.

## Endpoints

The API gateway strips the `/api` prefix before proxying; paths below are as mounted in this service.

### Auth (`/auth/*`)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/auth/register` | Create a user + paired organization (owner role) |
| POST | `/auth/login` | Authenticate with email/username + password, return token pair |
| POST | `/auth/refresh` | Exchange a refresh token for a new access token |
| POST | `/auth/logout` | Invalidate the current session |
| POST | `/auth/switch-org` | Switch active organization and re-issue tokens |
| POST | `/auth/send-verification` | Send an email-verification link |
| POST | `/auth/verify-email` | Verify email with a token (public) |
| POST | `/auth/step-up` | Re-verify password before destructive admin actions |
| `*` | `/auth/oauth/*` | OAuth (Google, GitHub) authorize/callback flow |

### Users (`/user/*`, `/users/*`)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/user/profile` | Get the current user's profile |
| PATCH | `/user/profile` | Update the current user's profile |
| DELETE | `/user/account` | Delete the current user's account (step-up) |
| POST | `/user/change-password` | Change password (step-up) |
| GET | `/user/organizations` | List organizations the user belongs to |
| POST | `/user/generate-token` | Generate an API token |
| GET | `/user/tokens` | List recent token-issuance history |
| POST | `/user/tokens/revoke-all` | Revoke all sessions (step-up) |
| GET | `/users` | List all users (system admin) |
| GET | `/users/:id` | Get a user by ID (system admin) |
| PUT | `/users/:id` | Update a user by ID (system admin) |
| PUT | `/users/:id/features` | Update a user's feature overrides (system admin) |
| DELETE | `/users/:id` | Delete a user by ID (system admin) |
| POST | `/users/bulk-delete` | Bulk-delete users (system admin, step-up) |

### Organizations (`/organization/*`, `/organizations/*`)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/organization` | Get the current user's organization |
| POST | `/organization` | Create an organization (admin/owner) |
| GET | `/organization/ai-config` | Get the org's AI-provider config |
| PUT | `/organization/ai-config` | Update the org's AI-provider keys (admin/owner) |
| GET | `/organization/:id` | Get an organization by ID |
| GET | `/organization/:id/descendants` | Org→team subtree IDs (self + descendants) |
| PUT | `/organization/:id` | Update an organization (system admin) |
| PATCH | `/organization/:id/tier` | Change pricing tier (system admin, step-up) |
| DELETE | `/organization/:id` | Delete an organization (system admin, step-up) |
| GET | `/organization/:id/export` | GDPR portability export (admin/owner) |
| GET | `/organization/:id/quotas` | Get quota limits and usage |
| PUT | `/organization/:id/quotas` | Update quota limits (system admin, step-up) |
| GET | `/organization/:id/members` | List members |
| POST | `/organization/:id/members` | Add a member (admin/owner) |
| POST | `/organization/:id/members/bulk-add` | Add a user to several subtree teams (admin/owner) |
| GET | `/organization/:id/teams` | Descendant team roster |
| GET | `/organization/:id/member/:memberId/teams` | Descendant teams annotated with the member's membership |
| DELETE | `/organization/:id/members/:userId` | Remove a member (admin/owner) |
| PATCH | `/organization/:id/members/:userId` | Update a member's role (admin/owner) |
| PATCH | `/organization/:id/members/:userId/deactivate` | Deactivate a member (admin/owner) |
| PATCH | `/organization/:id/members/:userId/activate` | Reactivate a member (admin/owner) |
| PATCH | `/organization/:id/transfer-owner` | Transfer ownership (admin/owner, step-up) |
| GET | `/organizations` | List all organizations (system admin) |

### Groups (`/organization/:id/groups/*`)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/organization/:id/groups` | List permission groups and their members |
| POST | `/organization/:id/groups/:groupId/members` | Add a member to a group (admin/owner) |
| DELETE | `/organization/:id/groups/:groupId/members/:userId` | Remove a member from a group (admin/owner) |

### Audit (`/audit/*`)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/audit` | List audit events (admin only; org-scoped for org admins) |
| POST | `/audit/events` | Internal ingest for non-platform services (service-token auth) |

> Additional operational routes are also mounted: `/invitation`, `/dashboards`, `/logs`, `/observability`, `/config`, and `/admin/*` (org IdP, KMS config, k8s namespace, user grants, summary, impersonate), plus `/health` and `/metrics`.

## Configuration

All config is read from environment variables (see `src/config/index.ts`). `JWT_SECRET` and `REFRESH_TOKEN_SECRET` are required in production (a dev-only insecure fallback is used otherwise); `SECRET_ENCRYPTION_KEY` is required in production for at-rest encryption of provider keys.

| Variable | Purpose | Default |
|----------|---------|---------|
| `PORT` | HTTP listen port | `3000` |
| `MONGODB_URI` | MongoDB connection string (required) | — |
| `JWT_SECRET` | Access-token signing secret (required in prod) | dev fallback |
| `REFRESH_TOKEN_SECRET` | Refresh-token signing secret (required in prod) | dev fallback |
| `JWT_EXPIRES_IN` | Access-token TTL (seconds) | `7200` |
| `JWT_ALGORITHM` | JWT signing algorithm | `HS256` |
| `REFRESH_TOKEN_EXPIRES_IN` | Refresh-token TTL (seconds) | `2592000` |
| `BCRYPT_SALT_ROUNDS` | bcrypt cost factor for password hashing | `12` |
| `PASSWORD_MIN_LENGTH` | Minimum password length | `8` |
| `AUTH_VERIFICATION_TOKEN_TTL_MS` | Email-verification token lifetime (ms) | `86400000` |
| `SECRET_ENCRYPTION_KEY` | At-rest encryption key for provider/IdP secrets (required in prod) | dev fallback |
| `AUDIT_RETENTION_DAYS` | Audit-event retention (TTL index) | `90` |
| `BOOTSTRAP_SUPERADMIN_EMAILS` | Emails granted `isSuperAdmin` at startup | — |
| `MONGO_MAX_POOL` / `MONGO_MIN_POOL` | Mongoose connection pool bounds | `20` / `2` |
| `LIMITER_MAX` / `LIMITER_WINDOWMS` | General rate-limit budget and window (ms) | `100` / `900000` |
| `AUTH_LIMITER_MAX` / `AUTH_LIMITER_WINDOWMS` | Auth-endpoint rate-limit budget and window (ms) | `20` / `900000` |
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
