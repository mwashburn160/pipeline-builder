# Platform Service

The platform service handles authentication, user management, organization management, and membership for the pipeline-builder system.

## Data Model

### User

Users represent individual accounts. A user can belong to **multiple organizations** via the `UserOrganization` junction collection.

- `username` - Unique, lowercase identifier
- `email` - Unique, lowercase email address
- `password` - Bcrypt-hashed (optional for OAuth-only users)
- `lastActiveOrgId` - References the last organization the user interacted with (replaces the former `organizationId` field)
- `isEmailVerified` - Whether the user has verified their email
- `tokenVersion` - Incremented to invalidate all active sessions
- `oauth` - Linked OAuth providers (Google, GitHub)
- `featureOverrides` - Per-user feature flag overrides

**Note:** There is no global `role` field on the User model. Roles are per-organization and stored in the `UserOrganization` junction collection.

### Organization

Organizations are multi-tenant containers for pipelines, plugins, and quotas.

- `name` / `slug` - Display name and URL-safe identifier
- `owner` - References the User who owns this organization
- `tier` - Quota tier: `'developer'` | `'pro'` | `'unlimited'`
- `quotas` / `usage` - Per-type quota limits and usage tracking (plugins, pipelines, apiCalls)
- `aiProviderKeys` - Encrypted AI provider API keys

**Note:** The `members[]` array has been removed from the Organization model. Membership is now managed exclusively through the `UserOrganization` junction collection. Query `UserOrganization` to list members of an organization.

### UserOrganization (Junction Collection)

Links users to organizations with per-org roles. A user may have different roles in different organizations.

- `userId` - References User
- `organizationId` - References Organization
- `role` - `'owner'` | `'admin'` | `'member'` (per-org, not global)
- `isActive` - Soft deactivation flag (deactivated members cannot access the org)
- `joinedAt` - Timestamp of when the user joined

## Authentication

### JWT Tokens

Access tokens contain:
- `sub` - User ID
- `organizationId` - Active organization ID
- `organizationName` - Active organization name
- `role` - User's role **in the active organization** (`'owner'` | `'admin'` | `'member'`)
- `isAdmin` - Derived boolean: `true` when `role === 'admin' || role === 'owner'`
- `username`, `email`, `isEmailVerified`, `tokenVersion`

Refresh tokens contain only `sub` and `tokenVersion`.

### Auth Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/auth/register` | Register user, create org, create `UserOrganization` with role `'owner'` |
| `POST` | `/auth/login` | Login with email/username + password, returns tokens scoped to last active org |
| `POST` | `/auth/refresh` | Refresh token pair (preserves active org from current JWT) |
| `POST` | `/auth/logout` | Invalidate sessions, clear cookies |
| `POST` | `/auth/switch-org` | Switch active organization. Verifies membership via `UserOrganization`, updates `lastActiveOrgId`, re-issues tokens with new org context |
| `POST` | `/auth/send-verification` | Send email verification link |
| `POST` | `/auth/verify-email` | Verify email with token |

### User Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/user/organizations` | List all organizations the authenticated user belongs to (via `UserOrganization`) |

## Organization Member Management

All member operations use the `UserOrganization` junction collection.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/organization/:id/members` | List members (queries `UserOrganization`, populates user data) |
| `POST` | `/organization/:id/members` | Add member (creates `UserOrganization` record) |
| `DELETE` | `/organization/:id/members/:userId` | Remove member (deletes `UserOrganization` record) |
| `PATCH` | `/organization/:id/members/:userId` | Update member role |
| `PATCH` | `/organization/:id/members/:userId/deactivate` | Soft-deactivate member (sets `isActive: false`, clears `lastActiveOrgId`) |
| `PATCH` | `/organization/:id/members/:userId/activate` | Reactivate a deactivated member |
| `PATCH` | `/organization/:id/transfer-owner` | Transfer ownership (demotes old owner to admin, promotes new owner) |

## Authorization

- **Org admin/owner** can manage members within their own organization
- **System admin** (admin/owner role in the `system` organization) can manage any organization
- `isAdmin` in the JWT is `true` when the user's per-org role is `'admin'` or `'owner'`
