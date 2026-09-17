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

- Source of truth: [packages/api-core/src/types/permissions.ts](https://github.com/mwashburn160/pipeline-builder/blob/main/packages/api-core/src/types/permissions.ts)
- Enforcement middleware: [packages/api-core/src/middleware/auth.ts](https://github.com/mwashburn160/pipeline-builder/blob/main/packages/api-core/src/middleware/auth.ts)

---

## Overview

This reference documents Pipeline Builder's per-org, permission-based access control: the fine-grained `resource:action` catalog, the built-in and custom Roles that bundle those permissions, and how they're enforced. It's for admins managing Roles and developers gating routes. A user's effective permissions are the deduplicated union of their assigned Roles (a Super Admin short-circuits to all), sourced from [`permissions.ts`](https://github.com/mwashburn160/pipeline-builder/blob/main/packages/api-core/src/types/permissions.ts) and enforced by the middleware in [`auth.ts`](https://github.com/mwashburn160/pipeline-builder/blob/main/packages/api-core/src/middleware/auth.ts); a startup backfill keeps built-in Roles synced to the current catalog. Read [The model](#the-model) first, then the [permission catalog](#permission-catalog), [enforcement](#enforcement) middleware, and the API for managing Roles.

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
  the org-assignable catalog (see the carve-out below), bounded by a **permission
  ceiling**: an author may only grant permissions they themselves hold, so a
  `roles:manage` holder cannot mint a Role carrying capabilities they lack (a
  Super Admin bypasses the ceiling).
- **Coarse label** — the `owner` / `admin` / `member` label on a membership is
  **display and authority only** (ownership transfer, seat accounting). It is
  *derived*, and it does **not** grant permissions — those come only from Roles.

## The visibility ladder

Every catalog entity — pipelines, plugins, templates, dashboards — shares ONE
three-rung sharing model, stored as a `visibility` column:

| Rung | Who can see it | Who can edit it |
| --- | --- | --- |
| `private` | Only the author (`createdBy`) — a personal draft | The author (plus super admins) |
| `org` | Everyone in the owning org | The resource's `:write` permission |
| `public` | The org **and its child teams**; from the system org, every org | The resource's `:publish` permission |

`public` never crosses tenant boundaries on its own: it means "beyond just me,
within my org tree". The only globally-visible content is what lives in the
**system org**, which is a superadmin action.

**Create-time defaults differ per entity**, deliberately — the ladder is
identical, only the starting rung differs:

- **pipelines / plugins** default to `org`. They are team assets that deploy
  shared infrastructure, so creating one must not hide it from the team. A
  personal draft is available, but opt-in.
- **templates** default to `private`. Draft-first is the point: you iterate on a
  golden-path starter before sharing it.

Enforcement lives in exactly two places, so no entity can drift:
`AccessControlQueryBuilder.buildAccessControl` builds the read predicate, and
`requireVisibilityWriteAccess` gates the writes.

> **Messages are not on the ladder.** Their visibility is a bespoke
> sender/recipient/broadcast predicate plus per-user targeting, so they carry no
> `visibility` column at all.

## Permission catalog

| Category | Permissions | Notes |
|----------|-------------|-------|
| Pipelines | `pipelines:read`, `pipelines:write`, `pipelines:publish` | `:publish` allows the `public` rung |
| Templates | `templates:read`, `templates:write`, `templates:publish` | Golden-path [pipeline templates](templates.md). Split out of `pipelines:*` so a platform team can curate starters without pipeline write access. `:write` covers the `private` and `org` rungs; `:publish` is required for `public`. **Instantiating** a template creates a pipeline, so that still needs `pipelines:write`. |
| Plugins | `plugins:read`, `plugins:write`, `plugins:publish` | `:publish` allows the `public` rung |
| Compliance | `compliance:read`, `compliance:write` | |
| Members & access | `members:manage`, `roles:manage`, `invitations:manage` | |
| Observability | `dashboards:read`, `dashboards:write`, `observability:read`, `observability:write` | |
| Insights | `reports:read`, `reports:rollup` | `:rollup` allows including descendant teams in reports |
| Messaging | `messages:read`, `messages:write` | |
| Billing & quotas | `billing:read`, `billing:manage`, `quotas:read` | |
| Registry | `registry:read`, `registry:write` | **Super Admin only** — never grantable to a custom Role |
| Org settings | `org:settings` | General org settings + AI provider config |
| SSO / IdP | `org:idp` | Per-org SSO/IdP (OIDC) configuration — **sensitive** (controls login); split out of `org:settings` |
| KMS | `org:kms` | Customer-managed KMS key configuration — **sensitive** (controls encryption); split out of `org:settings` |
| Impersonation | `org:impersonation` | The organization's impersonation policy — **sensitive** (controls who may view the org's data as one of its members); split out of `org:settings` so a role that manages general settings cannot also open the org to impersonation |

**`:read` permissions are enforced.** Withholding `quotas:read` / `reports:read` /
`billing:read` / `messages:read` from a custom Role actually blocks that read
(backend routes and the frontend nav/page guards check it). `pipelines:read` and
`templates:read` are the exceptions — the catalog reads are auth-only at the API
(gate-writes-only), so those two are declarative today. Built-in Admin and
Member both include all reads, so only bespoke custom Roles that drop a read are
affected.

**Registry carve-out.** `registry:read` / `registry:write` are in
`SUPERADMIN_ONLY_PERMISSIONS`: they're in **no** built-in Role bundle and can't be
requested by a custom Role (`sanitizePermissions` strips them), so the only holder
is a Super Admin via implicit-all.

### Built-in Role bundles

- **Member** — the read + author baseline: `pipelines:*` (read/write),
  `templates:*` (read/write), `plugins:*` (read/write), `compliance:read`, `dashboards:read`,
  `observability:read`, `reports:read`, `messages:read/write`, `billing:read`,
  `quotas:read`. No `:publish`, no management, no `:rollup`.
- **Admin / Owner** — every **org-assignable** permission (the full catalog minus
  the Super-Admin-only registry pair). Includes `pipelines:publish`,
  `templates:publish`, `plugins:publish`, and `reports:rollup`.
- **Super Admin** — implicit-all, including `registry:*`.

## Enforcement

Routes gate **writes** with permission middleware; a denied state-changing
request also emits an [`authz.denied` audit event](audit-events.md#action-catalog).

> **Not the same as the mesh.** This page covers **application** authorization —
> per-org capability checks on API routes. Beneath it, the [Istio ambient service
> mesh](service-mesh.md) enforces **network** authorization (L4, by service
> identity): which *services* may reach which *services* at all. A request must
> pass both — the mesh `AuthorizationPolicy` (can `sa/pipeline` reach `platform:3000`?)
> and then `requirePermission` (does this user hold the capability?). Don't conflate
> a mesh 403 (identity not allow-listed) with an app 403 (missing permission).

| Middleware | Semantics |
|------------|-----------|
| `requirePermission(a, b, …)` | passes if the caller holds **any** of the listed permissions (Super Admin passes via implicit-all) |
| `requireAllPermissions(a, b, …)` | passes only if the caller holds **all** listed permissions |
| `requirePermissionOrService(a, …)` | like `requirePermission`, but ALSO admits an internal `service:*` principal — used on READ routes that both users and service-to-service callers hit (a service token carries no permission claims and would otherwise be wrongly denied) |

Public-visibility is permission-based too: `resolveVisibility` grants `public`
only to a caller holding the resource's `:publish` permission — so a custom Role
can be granted publish rights instead of being forced private by its coarse label.
Downward report roll-up (`?includeDescendants`) requires `reports:rollup`.

**Accounts are not org-scoped.** A user account can belong to many
organizations, so `members:manage` covers a member's **role in your
organization** and removing them from it — not the account itself. Changing a
user's username, email or password, and deleting an account, are platform-admin
actions (`PUT`/`DELETE /users/:id`, both behind step-up). An org admin who
needs someone locked out removes or deactivates the membership.

## Session invalidation

Access tokens are short-lived (15 min) and carry a `tokenVersion`. On any
privilege change (role edit, permission change, superadmin grant/revoke), platform
bumps the user's `tokenVersion` and publishes it to a Redis-backed revocation
store; `requireAuth` rejects a token whose version is behind (fail-open if Redis
is unavailable — auth then degrades to natural token expiry, never a lockout).

## Impersonation (view as user)

A read-only "view as user X" session reproduces what a tenant sees — for support
work, bug reports, "it looks wrong on my account".

```
POST /api/admin/impersonate/:userId
X-Step-Up-Token: <token>
```

**Who can open one:**

| Caller | Reach |
|--------|-------|
| Platform **sysadmin** | Any user |
| Admin/owner of an **ancestor org** | Users in their own subtree — a parent org's teams |

A parent organization already administers its descendant teams' members, quotas
and secrets, so no separate approval applies within the account. This is
**strictly downward**: a team admin gets no authority over the parent, a sibling
team is not in the subtree, and an admin of the user's *own* org does not qualify
— that would be "any admin may view any of their members", which this is not.
Members get nothing in either direction.

Every caller must also pass a [step-up](authentication.md) re-authentication. The
response is an access token carrying the target user's identity, valid for
**15 minutes**. No refresh token is issued.

When a parent-org admin opens a session, the team's admins are **notified** —
they are informed, not asked.

**It is read-only, enforced server-side.** The token carries an
`impersonationReadOnly` claim, and every request that isn't `GET`, `HEAD` or
`OPTIONS` is rejected with `IMPERSONATION_READ_ONLY`. No state change can land
under a borrowed identity.

**What it will not do:**

| Refused | Why |
|---------|-----|
| Impersonating yourself | No purpose; rejected `400` |
| Impersonating another sysadmin | Stops a compromised sysadmin laundering authority through a peer's identity |
| Impersonating from inside an impersonation session | Keeps the audit trail a single hop — always requester → user, never chained |
| A user with no resolvable organization | There is no org to pin the session to (non-sysadmin callers) |

**Tenancy.** The issued token is built from the *target's* identity, so it carries
no `isSuperAdmin` claim — which means the `x-org-id` override is unavailable
during impersonation. The session is **pinned to one organization** (today, the
target's active org) and resolved strictly: if the target has no live membership
there — or that org is soft-deleted — the token is issued with no organization
context rather than falling back to some other org they belong to. An operator
who asked to view a specific organization is never silently placed in a different
one. It is not a way to roam between tenants.

**Visibility.** Starting a session emits `admin.impersonate.start`, filed under
the organization the session is pinned to rather than the system org — so that
org's admins see it in their own audit view, not just platform operators. The
event carries a `requestId` and an `approvalReason`, and actions taken during the
session carry the sysadmin in a first-class `impersonatorId` field. See
[Audit Events](audit-events.md).

**Every session is recorded.** Each one creates an impersonation request that the
token is then redeemed against — there is no path that issues a token without a
record. An approval is single-use, so a request cannot be redeemed twice. The
request's `approvalReason` records why it was allowed: `policy_open` (nobody had
to be asked), `ancestor_authority` (a parent org's admin), `consent` (someone
approved), or `breakglass` (emergency access).

### Administrator access policy

Each organization chooses whether platform sysadmins may view its members'
accounts, under **Settings → Organization → Administrator access**. Changing it
requires the `org:impersonation` permission and re-entering your password.

| Policy | Shown as | What happens when a sysadmin asks |
|--------|----------|-----------------------------------|
| `open` | Open | The session starts immediately. It is still logged. |
| `consent` **(default)** | Ask first | The request waits. Someone must approve it within **1 hour**. |
| `denied` | Emergencies only | Refused. Only [emergency access](#impersonation-view-as-user) remains. |

**Who is asked.** By default the request goes to the member whose account it is.
An organization can turn off **Let members approve access to their own account**;
requests then go to its admins, and the first to answer decides. A sysadmin who
explicitly asks for the member to approve, in an organization that forbids it, is
refused rather than silently redirected.

**Strictest wins across teams.** A team can make its policy stricter than its
parent's, never looser: the policy that applies is the stricter of the two, and
self-approval is allowed only if both allow it. The settings page shows when a
parent's policy is overriding the team's own. If the parent's policy can't be
read, the strictest policy applies until it can.

`denied` can't be selected on a deployment with fewer than two sysadmins, because
emergency access under it needs a second sysadmin to approve.

**Approving.** The request appears on the approver's **Access requests** page,
and they are notified in the app. Approving shows exactly what is being granted —
who, whose account, for how long, and that it's view-only. The requester is
notified of the decision either way, and opens an approved session from their own
Access requests page, which asks for their password again. An approval that isn't
opened within the hour lapses and shows as expired. A request nobody could be notified about is reported to the
requester immediately rather than left waiting.

Admins of a **parent** organization are not subject to the policy when viewing
their own teams' members: the team's admins are informed, not asked. They do this
from **Members → View a team member's account**, which appears for admins of an
organization that has teams: pick a team, then **View as user** on a member. The
request names that team, so the session is scoped to it regardless of which
organization the member last had active.

Through the API, an impersonation request may name the organization explicitly:

```
POST /api/admin/impersonate/:userId
{ "orgId": "<team id>" }
```

The user must be an active member of that organization, or the request is
refused. Without `orgId`, the session is for the user's active organization.

**Seeing and ending sessions.** Every signed-in user has an **Access requests**
page (`/dashboard/access-requests`, under Home in the sidebar). It lists live
sessions on your own account, sessions you opened, and — for an organization
admin — sessions on your organization's members, each with an **End session**
button. Ending a session takes effect immediately; it never asks for confirmation.

**Stop impersonating** ends the session on the server as well as in the browser,
so the token stops working rather than remaining valid until it expires.

A live session can also be revoked through the API:

```
POST /api/admin/impersonate/requests/:id/revoke
```

Permitted to the impersonated user, an admin of the pinned organization, whoever
approved it, or the requester. Each session's token carries its own `jti`, so
revoking ends **that session only** — the impersonated user's own sessions are
untouched. The next request under a revoked token is rejected, rather than the
session running out its 15-minute TTL.

**Revocation reaches every service.** The platform refuses a revoked session's
token directly; ending a session also publishes it to Redis, which every other
service checks on each impersonated request. If that publish fails, the
response carries `revokedEverywhere: false` and the Access requests page warns
that the session may keep working elsewhere until it expires, rather than
reporting it ended.

A service that cannot read Redis **rejects** impersonation tokens — it cannot tell
whether the session was ended, and a withdrawn session that keeps working is not
withdrawn. Ordinary user sessions are unaffected by a Redis outage.

**Emergency access.** A sysadmin can take read-only access without waiting for
approval, for incidents where the account's owner can't or shouldn't be asked
(**Emergency access…** on the user's edit dialog):

```
POST /api/admin/impersonate/:userId/breakglass
{ "justification": "INC-1234: customer pipelines failing since 09:10" }
```

It is deliberately expensive rather than blocked:

- A written **justification** of at least 20 characters is required, and it is
  shown to the organization.
- **Every admin** of the organization is notified immediately, including how many
  times this operator has used emergency access in the last 30 days.
- A **second sysadmin must approve** it before any token is issued when the
  organization's policy is `denied`, or when the operator has already used
  emergency access 5 times in 30 days. The response is then `202` with
  `awaiting: "second_sysadmin"`; the second sysadmin approves it from their
  Access requests page, and the requester opens it from there.
- It is audited as `admin.impersonate.breakglass`, never as an ordinary start.
- A user with no organization cannot be reached this way — there would be nobody
  to notify.

No one — including a sysadmin — can approve their own request.

## Managing Roles via the API

```bash
GET|POST    /api/organization/:id/roles                       # list / create Roles
PUT|DELETE  /api/organization/:id/roles/:roleId               # update / delete a custom Role
POST|DELETE /api/organization/:id/roles/:roleId/members/:uid  # add / remove a Role member
```

`POST` / `PUT` / `DELETE` require `roles:manage`. Custom-Role authoring validates
the requested permissions against the org-assignable set (the registry carve-out
is rejected) **and** against the author's own permissions (the permission ceiling
above) — a request granting a permission the author lacks is rejected `403`.

## Teams

A parent-org **admin/owner** can administer its teams (members, rules, quotas)
without a separate membership — fine-grained delegation applies within the team's
own tenancy boundary, and team-local Roles still bind. See
[Org → Team Hierarchy](README.md#teams-org--team-hierarchy).

### Cross-organization reach

**Except for platform sysadmins (the system organization), an organization cannot
reach into another organization unless it is that organization's child team.**

This governs every way of acting on an organization you are not a member of:

| Reaching into… | From the same org | From its parent | From a sibling team | From its child team | From a separate account |
|---|---|---|---|---|---|
| Administering it | admins | admins ✅ | ❌ | ❌ | ❌ |
| Reading it | members | admins ✅ | ❌ | ❌ | ❌ |
| Impersonating a member | ❌ | admins ✅ | ❌ | ❌ | ❌ |
| Overriding the org via `x-org-id` | sysadmin only | | | | |

A sysadmin can do all of these for any organization. Reach only ever flows
**down** the tree, from a parent to its teams.

**Switching organizations is different.** Switching your active organization
follows your own memberships: you can switch to any organization you are an
active member of, including a separate one. Being a parent admin does not let you
switch into a team you don't belong to — you administer and view it from the
parent instead.

## Related

- [Authentication](authentication.md) — sign-in, step-up re-auth, SSO
- [Audit Events](audit-events.md) — the event catalog, including `admin.impersonate.*`
- [Organization Benefits](organization-benefits.md) — org, team and account structure
- [API Reference](api-reference.md) — route-level permission requirements
