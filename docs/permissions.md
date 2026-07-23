---
layout: default
title: Roles & Permissions
image: /assets/og-image-solution.png
---

# Roles & Permissions

Access control in Pipeline Builder is **permission-based and single-source**. A
user's effective permissions are the **union of the Roles assigned to them** —
there is no hidden role-derived baseline. Everything below is scoped to an
organization (or team); platform-operator powers live behind the global
**Super Admin** flag, not a per-org permission.

- Source of truth: [packages/api-core/src/types/permissions.ts](../packages/api-core/src/types/permissions.ts)
- Enforcement middleware: [packages/api-core/src/middleware/auth.ts](../packages/api-core/src/middleware/auth.ts)

---

## The model

- **Role** — a named set of fine-grained `resource:action` permissions
  (e.g. a "Billing Manager" role granting `billing:read` + `billing:manage`).
  Stored in the `roles` / `role_assignments` collections.
- **Effective permissions** — `resolveUserPermissions(assignedPermissions, isSuperAdmin)`
  returns the deduplicated union of every assigned Role's permissions. No Role
  assigned → no permissions (a Super Admin short-circuits to all).
- **Built-in Roles** — every org seeds **Admin** and **Member**; the system org
  also seeds **Super Admin**. A startup backfill re-syncs each built-in Role's
  permission set to the current catalog, so new permissions reach existing orgs.
- **Custom Roles** — admins with `roles:manage` can author additional Roles from
  the org-assignable catalog (see the carve-out below).
- **Coarse label** — the `owner` / `admin` / `member` label on a membership is
  **display and authority only** (ownership transfer, seat accounting). It is
  *derived*, and it does **not** grant permissions — those come only from Roles.

## Permission catalog

| Category | Permissions | Notes |
|----------|-------------|-------|
| Pipelines | `pipelines:read`, `pipelines:write`, `pipelines:publish` | `:publish` allows setting a pipeline `public` |
| Plugins | `plugins:read`, `plugins:write`, `plugins:publish` | `:publish` allows setting a plugin `public` |
| Compliance | `compliance:read`, `compliance:write` | |
| Members & access | `members:manage`, `roles:manage`, `invitations:manage` | |
| Observability | `dashboards:read`, `dashboards:write`, `observability:read`, `observability:write` | |
| Insights | `reports:read`, `reports:rollup` | `:rollup` allows including descendant teams in reports |
| Messaging | `messages:read`, `messages:write` | |
| Billing & quotas | `billing:read`, `billing:manage`, `quotas:read` | |
| Registry | `registry:read`, `registry:write` | **Super Admin only** — never grantable to a custom Role |
| Org settings | `org:settings` | SSO/IdP, KMS, AI config, general settings |

**`:read` permissions are enforced.** Withholding `quotas:read` / `reports:read` /
`billing:read` / `messages:read` from a custom Role actually blocks that read
(backend routes and the frontend nav/page guards check it). Built-in Admin and
Member both include all reads, so only bespoke custom Roles that drop a read are
affected.

**Registry carve-out.** `registry:read` / `registry:write` are in
`SUPERADMIN_ONLY_PERMISSIONS`: they're in **no** built-in Role bundle and can't be
requested by a custom Role (`sanitizePermissions` strips them), so the only holder
is a Super Admin via implicit-all.

### Built-in Role bundles

- **Member** — the read + author baseline: `pipelines:*` (read/write),
  `plugins:*` (read/write), `compliance:read`, `dashboards:read`,
  `observability:read`, `reports:read`, `messages:read/write`, `billing:read`,
  `quotas:read`. No `:publish`, no management, no `:rollup`.
- **Admin / Owner** — every **org-assignable** permission (the full catalog minus
  the Super-Admin-only registry pair). Includes `pipelines:publish`,
  `plugins:publish`, and `reports:rollup`.
- **Super Admin** — implicit-all, including `registry:*`.

## Enforcement

Routes gate **writes** with permission middleware; a denied state-changing
request also emits an [`authz.denied` audit event](audit-events.md#action-catalog).

| Middleware | Semantics |
|------------|-----------|
| `requirePermission(a, b, …)` | passes if the caller holds **any** of the listed permissions (Super Admin passes via implicit-all) |
| `requireAllPermissions(a, b, …)` | passes only if the caller holds **all** listed permissions |
| `requirePermissionOrService(a, …)` | like `requirePermission`, but ALSO admits an internal `service:*` principal — used on READ routes that both users and service-to-service callers hit (a service token carries no permission claims and would otherwise be wrongly denied) |

Public-visibility is permission-based too: `resolveAccessModifier` grants `public`
only to a caller holding the resource's `:publish` permission — so a custom Role
can be granted publish rights instead of being forced private by its coarse label.
Downward report roll-up (`?includeDescendants`) requires `reports:rollup`.

## Session invalidation

Access tokens are short-lived (15 min) and carry a `tokenVersion`. On any
privilege change (role edit, permission change, superadmin grant/revoke), platform
bumps the user's `tokenVersion` and publishes it to a Redis-backed revocation
store; `requireAuth` rejects a token whose version is behind (fail-open if Redis
is unavailable — auth then degrades to natural token expiry, never a lockout).

## Managing Roles via the API

```bash
GET|POST    /api/organization/:id/roles                       # list / create Roles
PUT|DELETE  /api/organization/:id/roles/:roleId               # update / delete a custom Role
POST|DELETE /api/organization/:id/roles/:roleId/members/:uid  # add / remove a Role member
```

`POST` / `PUT` / `DELETE` require `roles:manage`. Custom-Role authoring validates
the requested permissions against the org-assignable set (the registry carve-out
is rejected).

## Teams

A parent-org **admin/owner** can administer its teams (members, rules, quotas)
without a separate membership — fine-grained delegation applies within the team's
own tenancy boundary, and team-local Roles still bind. See
[Org → Team Hierarchy](README.md#teams-org--team-hierarchy).
