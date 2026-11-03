// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { OrgRole } from './common.js';

// =============================================================================
// Permission identifiers
// =============================================================================

/**
 * Canonical fine-grained permission identifiers, in `resource:action` form.
 *
 * These are the ORG-SCOPED capabilities a Role can grant (RBAC). Coarse by
 * design — `:write` covers create/update/delete for a resource — so the catalog
 * and permission-picker UI stay small; split a `:write` into `:create`/`:delete`
 * later if a resource needs it.
 *
 * NOT modeled here (intentionally): platform-operator actions (org delete, tier/
 * quota override, user admin, impersonation, platform settings) stay behind the
 * global `isSuperAdmin` flag, not a per-org permission; and `requireStepUp`
 * (MFA) / `requireFeature` (plan entitlements) remain orthogonal gates.
 */
export type Permission =
  // Pipelines
  | 'pipelines:read'
  | 'pipelines:write'
  | 'pipelines:publish'
  // The pipeline REGISTRY (`POST`/`DELETE /pipelines/registry`): which deployed
  // stack backs a pipeline, and the step manifest of plugin digests it runs.
  // Split out of `pipelines:write` so the CodeBuild synth can keep that record
  // current with a credential that can do nothing else — a key holding
  // `pipelines:write` could rewrite every pipeline the org owns. People get it
  // beside `pipelines:write` (the Member bundle); the `pipeline-register`
  // service account holds it alone.
  | 'pipeline_registry:write'
  // Golden-path pipeline templates. Split out of `pipelines:*` so a platform
  // team can curate the starter catalog WITHOUT write access to every pipeline
  // (and vice versa). `:publish` maps to the
  // template ladder's `public` rung; `org` and `private` need only `:write`.
  | 'templates:read'
  | 'templates:write'
  | 'templates:publish'
  // Plugins
  | 'plugins:read'
  | 'plugins:write'
  | 'plugins:publish'
  // Plugin ecosystem (docs/plugin-publishing.md). Org-assignable:
  //  - `plugins:install`        — install/upgrade/uninstall listings (or REQUEST
  //                               an install when the org's policy needs approval).
  //  - `plugin_installs:manage` — the org's consumption policy + deciding install
  //                               requests WITHIN the org (org-local only).
  //  - `publishers:manage`      — the org's publisher profile + submitting
  //                               ecosystem requests (every decision is system-org).
  // System-org-only (see SYSTEM_ORG_ONLY_PERMISSIONS):
  //  - `plugins:moderate`       — decide publish requests, moderate, yank, advisories.
  //  - `publishers:verify`      — publisher tiers, profile changes, transfers.
  | 'plugins:install'
  | 'plugin_installs:manage'
  | 'publishers:manage'
  | 'plugins:moderate'
  | 'publishers:verify'
  // Platform operations (system-org only). The cross-tenant operator surfaces
  // that used to require the superadmin FLAG, so a deployment can staff them
  // with a Role instead of handing out implicit-all. Split because the two carry
  // different risk: reading what a deploy configured is not the same as moving
  // another organisation's money.
  | 'platform:read'
  // The cross-tenant ORG LIST, split out of `platform:read` because that one
  // permission was doing two jobs with different blast radii: reading what a
  // DEPLOY was configured to do (RLS mode, KMS posture, the rendered alert
  // rules) and reading the roster of every CUSTOMER. Three of the four job
  // bundles carried it, and only one of them wanted the deploy internals —
  // Console Administrator and Support Agent got them purely because they needed
  // to find an org by name.
  //
  // Same mistake, and same fix, as `consoles:datastore` before it was split by
  // what a mistaken grant costs.
  | 'orgs:read'
  | 'billing:operate'
  // The operator consoles, split by BLAST RADIUS rather than by product. Three
  // permissions for five consoles, because what a mistaken grant costs differs
  // by an order of magnitude at each step:
  //
  //  - `observability_console:open` — Grafana and Kiali. Read-only views; the worst
  //    outcome of a mistaken grant is seeing telemetry.
  //  - `database_console:open`     — pgAdmin and mongo-express. A database shell
  //    over every tenant's rows: it can read and rewrite tenant data, but the
  //    audit chain lives elsewhere, so the damage is recorded.
  //  - `objectstore_console:open`   — the RustFS (S3) console. It can LIST and
  //    DELETE objects in the registry, Loki, Thanos, plugin-build and
  //    audit-chain buckets. Split from the pair above because the two are the
  //    two HALVES of the audit tamper-evidence design: the chain's HMAC key
  //    lives outside the DB, so a Mongo shell can tamper but cannot forge a
  //    consistent chain — except by truncating the tail, which a chain cannot
  //    see from the inside, and the defence against THAT is the signed
  //    chain-head export to object storage. One shell can truncate; the other
  //    can delete the heads that would expose the truncation.
  //
  // All three are system-org-only, so none can be held inside a tenant, and only
  // the first is in the Platform Operator bundle: staffing an operator must never
  // hand over a data shell as a side effect. Granting either of the other two is
  // a separate, explicit act by a superadmin composing a Role for exactly that
  // purpose.
  //
  // WHAT THE SPLIT DOES NOT DO, so nobody builds on it: it is not a containment
  // boundary. Roles live in Mongo (`collection: 'roles'`), so a
  // `database_console:open` holder can write that collection and grant themselves
  // `objectstore_console:open` — datastore contains objectstore by escalation. The
  // split expresses intent, keeps the default grant small and gives each class
  // its own refusal signal. What actually protects the audit heads from whoever
  // opens that console is S3 Object Lock with a retain-until-date
  // (`platform/src/services/audit-head-export.ts`), which holds regardless of
  // any permission here.
  | 'observability_console:open'
  | 'database_console:open'
  | 'objectstore_console:open'
  // On-call (system-org only). Reads the paging POSTURE and sends a test page.
  // Not a schedule editor — the provider owns the rota — and deliberately not a
  // settings surface either, because every knob is operator-side env. What it
  // grants is the one thing a product surface can give that a shell cannot:
  // "will we actually be paged", answerable without cluster access.
  | 'oncall:manage'
  // The vendor's other operational TASKS (system org only). Each exists so a
  // superadmin can staff one job with a Role instead of the superadmin flag —
  // before these, 34 routes were reachable only by someone who also held
  // impersonation, a database shell and the ability to mint another superadmin.
  //
  // Support desk, split in two because the content is reused across every
  // customer while a case belongs to one: `support_cases:write` is the desk's
  // own work (triage, assignment, severity, internal notes, recording an
  // incident against a support contract), `support_content:write` is authoring
  // the canned replies. Each gates its task's READS as well as its writes,
  // against the usual convention, because these tables carry no `org_id` — there
  // is no tenancy boundary underneath to fall back on.
  | 'support_cases:write'
  | 'support_content:write'
  // Cross-tenant subscriptions. Read is split from write because a read-only
  // holder is a real job here: someone who reports on revenue and plan mix
  // without being able to change a plan or cancel one.
  | 'subscriptions:read'
  | 'subscriptions:manage'
  // The org lifecycle ACROSS tenants: rename, delete, change tier, move under a
  // new parent. Distinct from `org_settings:write`, which is an org acting on
  // itself.
  | 'orgs:manage'
  // Cross-tenant quota writes. The matching reads (`/quotas/all`, `/at-risk`)
  // ride `platform:read` with the rest of the operator dashboard, so someone
  // watching for exhaustion does not need the ability to raise a limit.
  | 'quotas:manage'
  // The plugin BUILD queue — depth, stalls, and purging the dead-letter queue.
  // Distinct from `plugins:moderate`, which is ecosystem governance: this is
  // infrastructure, and the people who run it are not the people who review
  // submissions.
  | 'plugin_queue:manage'
  // Compliance
  | 'compliance:read'
  | 'compliance:write'
  // Members & access
  | 'members:manage'
  | 'roles:manage'
  | 'invitations:manage'
  // Org-scoped service accounts (non-human principals) and their access keys.
  // Split out of `members:manage` because a service account is a CREDENTIAL
  // holder, not a person: granting someone the ability to mint long-lived
  // machine keys is a different decision from letting them manage the roster.
  | 'service_accounts:manage'
  // Observability
  | 'dashboards:read'
  | 'dashboards:write'
  | 'observability:read'
  | 'observability:write'
  // `logs:export` is split OUT of `observability:read` deliberately. Reading
  // logs in the UI is paged and ephemeral; EXPORTING them is bulk egress that
  // leaves the building and outlives a revoked session, so an org admin must be
  // able to grant log viewing without granting downloads.
  | 'logs:export'
  // The org's own hash-chained audit trail. ORG-ASSIGNABLE, unlike the platform
  // operations pair: the rows an org reads are its own (the query predicate is
  // `orgId` OR `affectedOrgId`), so delegating it is an org's decision — a
  // compliance reviewer can be given the trail without being made an admin of
  // everything that produced it. Read-only by construction; there is no write.
  | 'audit:read'
  // Insights
  | 'reports:read'
  | 'reports:rollup'
  // Stakeholder reports. `reports:read` stays the FREE on-demand dashboard read;
  // these two are the add-on's write surface — `author` saves/schedules/drafts a
  // report, `share` publishes it beyond the platform (PDF, email, share links).
  // Split because publishing externally is a different risk from composing:
  // a lead can be allowed to build reports without being allowed to email them out.
  | 'reports:write'
  | 'reports:publish'
  // Messaging
  | 'messages:read'
  | 'messages:write'
  // Billing & quotas
  | 'billing:read'
  | 'billing:manage'
  | 'quotas:read'
  // Impersonation — viewing the platform as somebody else. Three ids, because
  // three different parties are involved and each decision belongs to a
  // different one of them (docs/permissions.md#impersonation):
  //  - `impersonation:open`   the VENDOR opening a cross-tenant session, which
  //                           is system-org-only and still consent-gated;
  //  - `team_access:open`     a PARENT org's admin viewing one of its own teams'
  //                           members, which never leaves the tenant;
  //  - `impersonation:approve` the TENANT answering a consent request.
  // `org_impersonation:write` below is a fourth thing again: the POLICY that
  // decides whether consent is needed at all.
  | 'impersonation:open'
  | 'impersonation:approve'
  | 'team_access:open'
  // Registry. Three rungs, because the write half has two very different
  // blast radii: `write` COPIES a manifest (additive — it creates a tag,
  // nothing stops resolving), `purge` DELETES one (a tenant's pipeline or a
  // digest-pinned plugin image can stop resolving, with no undo).
  | 'registry:read'
  | 'registry:write'
  | 'registry:purge'
  // Organization settings. Four RESOURCES, each with the `:write` action, rather
  // than one `org` resource with four noun-shaped actions — these are the org's
  // own configuration state, which is what `:write` means here (`:manage` is
  // reserved for administering a collection of other entities: members, roles,
  // invitations, service accounts, billing).
  //
  //  - `org_settings:write`      — general org settings + AI config.
  //  - `org_idp:write`           — SSO / IdP configuration (sensitive: controls login).
  //  - `org_kms:write`           — customer-managed KMS key configuration
  //                                (sensitive: controls encryption of org data).
  //  - `org_impersonation:write` — the impersonation policy (sensitive: controls
  //                                who may VIEW the org's data as a member).
  //
  // The last three were split OUT of `org_settings:write` so a custom role can
  // grant general settings WITHOUT the sensitive surfaces — a "settings manager"
  // role for org name or AI provider must not also be able to switch the org to
  // `open`. All remain org-assignable and are seeded into the admin/owner
  // bundles (via ORG_ASSIGNABLE_PERMISSIONS) so existing admins keep full
  // access.
  | 'org_settings:write'
  | 'org_idp:write'
  | 'org_kms:write'
  | 'org_impersonation:write';

/**
 * The CLOSED set of actions a permission id may end in — the second half of the
 * `resource:action` strategy the docs describe.
 *
 * It is closed for one concrete reason: `isMutationPermission` (frontend
 * `lib/auth-helpers.ts`) classifies read vs write BY SUFFIX, and that is what
 * disables every write affordance during a read-only impersonation session. A
 * noun-shaped action (the former `org:settings` and `consoles:datastore`) cannot be classified
 * by name, so each one had to be hand-listed — and a permission added without
 * remembering that list renders an enabled control that dead-ends on a 403.
 *
 * Reads are `:read` and `:rollup` (a read-VISIBILITY scope). Everything else is
 * a write. The five domain verbs are kept because each names an action with no
 * synonym in this vocabulary — `:export` is egress rather than mutation,
 * `:install` is consumption rather than authoring, `:moderate` and `:verify` are
 * ecosystem decisions, and `:operate` moves another tenant's money.
 *
 * `PERMISSION_ID_SHAPE` and this list are asserted over the whole catalog in
 * api-core's `test/permissions.test.ts`, so adding an off-strategy id fails
 * there rather than at a 403.
 */
export const PERMISSION_ACTIONS: readonly string[] = [
  'read', 'rollup',
  'write', 'manage', 'publish', 'open',
  'export', 'install', 'moderate', 'verify', 'operate', 'purge', 'approve',
];

/** `resource:action`, where resource is `snake_case` and action is in {@link PERMISSION_ACTIONS}. */
export const PERMISSION_ID_SHAPE = /^[a-z][a-z0-9_]*:[a-z]+$/;

/** All valid permissions (order determines display order in the picker). */
export const ALL_PERMISSIONS: readonly Permission[] = [
  'pipelines:read', 'pipelines:write', 'pipelines:publish', 'pipeline_registry:write',
  'templates:read', 'templates:write', 'templates:publish',
  'plugins:read', 'plugins:write', 'plugins:publish',
  'plugins:install', 'plugin_installs:manage', 'publishers:manage',
  'plugins:moderate', 'publishers:verify',
  'platform:read', 'orgs:read', 'billing:operate',
  'observability_console:open', 'database_console:open', 'objectstore_console:open',
  'oncall:manage',
  'support_cases:write', 'support_content:write',
  'subscriptions:read', 'subscriptions:manage',
  'orgs:manage', 'quotas:manage', 'plugin_queue:manage',
  'compliance:read', 'compliance:write',
  'members:manage', 'roles:manage', 'invitations:manage', 'service_accounts:manage',
  'dashboards:read', 'dashboards:write',
  'observability:read', 'observability:write',
  'logs:export', 'audit:read',
  'reports:read', 'reports:rollup', 'reports:write', 'reports:publish',
  'messages:read', 'messages:write',
  'billing:read', 'billing:manage',
  'quotas:read',
  'registry:read', 'registry:write', 'registry:purge',
  'impersonation:open', 'impersonation:approve', 'team_access:open',
  'org_settings:write', 'org_idp:write', 'org_kms:write', 'org_impersonation:write',
];

/**
 * The CLOSED set of functions that take a {@link Permission} and decide access.
 *
 * "Is permission X enforced anywhere?" has to be answerable statically, which
 * a grep can't do: four different call shapes consume a permission id
 * (`requirePermission('x')` at a route, `userHasPermission(req, 'x')` inside a
 * controller, and `resolveVisibility(req, v, 'x')` /
 * `requireVisibilityWriteAccess(…, 'x')` in the visibility helpers), so a naive
 * grep for a route-level gate reports `templates:publish` as UNENFORCED when it
 * is in fact enforced on every template publish.
 *
 * They all bottom out in `userHasPermission`, so the RUNTIME primitive was
 * already one. This constant makes the STATIC surface one as well: it names
 * every entry point, so `permission-coverage.test.ts` can enumerate the catalog
 * and report each permission's enforcement sites without guessing. A new gate
 * that takes a `Permission` must be listed here, or the coverage report starts
 * lying about the permissions only that gate enforces.
 */
export const PERMISSION_GATES: readonly string[] = [
  // Middleware gates (route level) — all any-of except requireAllPermissions.
  'requirePermission',
  'requireAllPermissions',
  'requirePermissionOrService',
  // The plugin-ecosystem governance chain (system org + permission + aal2).
  'requireSystemOrgPermission',
  // The single runtime primitive every gate above delegates to; also called
  // directly where a controller branches on a capability rather than rejecting.
  'userHasPermission',
  'hasPermission',
  // Visibility helpers — they take the entity's PUBLISH permission.
  'requireVisibilityWriteAccess',
  'checkVisibilityWriteAccess',
  'resolveVisibility',
  // quota's own wrapper. It delegates to `requirePermission`, but it takes the
  // id as an OPTION (`authorizeOrg({ permission: 'quotas:manage' })`) because it
  // also canonicalizes the `:orgId` param, which the route cannot drop. Without
  // this entry the coverage scan reported `quotas:manage` as enforced nowhere.
  'authorizeOrg',
];

/**
 * Display metadata for one permission: the label + description the
 * permission-picker UI shows, and the category it groups under.
 */
export interface PermissionMeta {
  id: Permission;
  label: string;
  description: string;
  category: string;
}

/**
 * The permission catalog with display metadata, in picker order.
 *
 * This module is the SINGLE catalog for backend and browser alike: it has no
 * runtime dependencies (the only import is a type), so the frontend imports it
 * through the `@pipeline-builder/api-core/permissions` subpath instead of keeping
 * a hand-maintained mirror. Every id in {@link ALL_PERMISSIONS} must appear here
 * exactly once (asserted by `permissions.test.ts`).
 */
export const PERMISSION_CATALOG: readonly PermissionMeta[] = [
  { id: 'pipelines:read', label: 'View pipelines', description: 'View pipelines and their executions', category: 'Pipelines' },
  { id: 'pipelines:write', label: 'Manage pipelines', description: 'Create, edit, and delete pipelines', category: 'Pipelines' },
  { id: 'pipelines:publish', label: 'Publish pipelines', description: 'Make pipelines public (org-wide/catalog visibility)', category: 'Pipelines' },
  { id: 'pipeline_registry:write', label: 'Register deployments', description: 'Record and remove the deployed stack and step manifest behind a pipeline (the pipeline registry)', category: 'Pipelines' },
  { id: 'templates:read', label: 'View templates', description: 'View the golden-path template catalog', category: 'Templates' },
  { id: 'templates:write', label: 'Manage templates', description: 'Author, edit, and delete pipeline templates', category: 'Templates' },
  { id: 'templates:publish', label: 'Publish templates', description: 'Share a template beyond your org (public visibility)', category: 'Templates' },
  { id: 'plugins:read', label: 'View plugins', description: 'View plugins and builds', category: 'Plugins' },
  { id: 'plugins:write', label: 'Manage plugins', description: 'Create, upload, edit, and delete plugins', category: 'Plugins' },
  { id: 'plugins:publish', label: 'Publish plugins', description: 'Make plugins public (org-wide/catalog visibility)', category: 'Plugins' },
  { id: 'plugins:install', label: 'Install plugins', description: 'Install, upgrade, and uninstall ecosystem plugins (or request an install when your org requires approval)', category: 'Plugin Ecosystem' },
  { id: 'plugin_installs:manage', label: 'Manage plugin installs', description: "Set your org's plugin consumption policy and approve or deny install requests within the org", category: 'Plugin Ecosystem' },
  { id: 'publishers:manage', label: 'Manage publisher profile', description: "Manage your org's publisher profile and submit publish, verification, transfer, and advisory requests", category: 'Plugin Ecosystem' },
  { id: 'plugins:moderate', label: 'Moderate the plugin ecosystem', description: 'Decide publish requests, moderate submissions and reviews, yank versions, and publish advisories (system org only)', category: 'Plugin Ecosystem' },
  { id: 'publishers:verify', label: 'Verify publishers', description: 'Approve Verified applications, publisher tier and profile changes, and ownership transfers (system org only)', category: 'Plugin Ecosystem' },
  { id: 'platform:read', label: 'View platform operations', description: 'Read the platform settings and the cross-tenant organization list (system org only)', category: 'Platform operations' },
  { id: 'orgs:read', label: 'View all organizations', description: 'List and open every organization on the deployment \u2014 the roster the operator surfaces work from (system org only)', category: 'Platform operations' },
  { id: 'billing:operate', label: 'Operate discounts and promotions', description: 'Create, apply and revoke discount tokens and promotion campaigns across tenants (system org only)', category: 'Platform operations' },
  { id: 'observability_console:open', label: 'Open the observability consoles', description: 'Open Grafana and Kiali — dashboards, traffic and mesh health across every tenant (system org only)', category: 'Platform operations' },
  { id: 'database_console:open', label: 'Open the database consoles', description: 'Open pgAdmin and mongo-express — a direct read/write shell over every tenant\u2019s rows (system org only)', category: 'Platform operations' },
  { id: 'objectstore_console:open', label: 'Open the object-store console', description: 'Open the RustFS (S3) console — list and delete objects in every bucket, including the audit chain (system org only)', category: 'Platform operations' },
  { id: 'oncall:manage', label: 'Manage on-call paging', description: 'Read the paging posture and send a test page (system org only; the rota lives with the provider)', category: 'On-call' },
  { id: 'support_cases:write', label: 'Work the support desk', description: 'Triage the support queue, assign and re-prioritise cases, write internal notes, and record incidents against a support contract (system org only)', category: 'Support desk' },
  { id: 'support_content:write', label: 'Author canned replies', description: 'Write and retire the reusable support replies offered to every customer (system org only)', category: 'Support desk' },
  { id: 'subscriptions:read', label: 'View all subscriptions', description: 'View every organization\u2019s subscription, plan mix and billing events (system org only)', category: 'Platform operations' },
  { id: 'subscriptions:manage', label: 'Change any subscription', description: 'Change a plan, set a support floor, and cancel an organization\u2019s subscription (system org only)', category: 'Platform operations' },
  { id: 'orgs:manage', label: 'Administer any organization', description: 'Rename, re-tier, move and delete any organization (system org only)', category: 'Platform operations' },
  { id: 'quotas:manage', label: 'Change any quota', description: 'Raise, reset and clear another organization\u2019s quotas (system org only; viewing them rides platform:read)', category: 'Platform operations' },
  { id: 'plugin_queue:manage', label: 'Run the plugin build queue', description: 'Read build-queue depth and purge the dead-letter queue (system org only)', category: 'Platform operations' },
  { id: 'compliance:read', label: 'View compliance', description: 'View compliance rules, policies, and scans', category: 'Compliance' },
  { id: 'compliance:write', label: 'Manage compliance', description: 'Create and edit rules, policies, and exemptions', category: 'Compliance' },
  { id: 'members:manage', label: 'Manage members', description: 'Add, remove, and change roles of org members', category: 'Members & Access' },
  { id: 'roles:manage', label: 'Manage roles', description: 'Create, edit, and delete roles', category: 'Members & Access' },
  { id: 'invitations:manage', label: 'Manage invitations', description: 'Send, resend, and revoke invitations', category: 'Members & Access' },
  { id: 'service_accounts:manage', label: 'Manage service accounts', description: 'Create org service accounts, assign their roles, and issue or revoke their keys', category: 'Members & Access' },
  { id: 'dashboards:read', label: 'View dashboards', description: 'View custom dashboards', category: 'Observability' },
  { id: 'dashboards:write', label: 'Manage dashboards', description: 'Create and edit custom dashboards', category: 'Observability' },
  { id: 'observability:read', label: 'View alerting', description: 'View alert rules and destinations', category: 'Observability' },
  { id: 'observability:write', label: 'Manage alerting', description: 'Create and edit alert rules and destinations', category: 'Observability' },
  { id: 'logs:export', label: 'Download logs', description: "Download your organization's log entries as a file (viewing logs only needs 'View alerting')", category: 'Observability' },
  { id: 'audit:read', label: 'View the audit log', description: "Read the organization's own tamper-evident audit trail", category: 'Observability' },
  { id: 'reports:read', label: 'View reports', description: 'View analytics and reports', category: 'Insights' },
  { id: 'reports:rollup', label: 'Roll up team reports', description: 'Include descendant teams when viewing reports', category: 'Insights' },
  { id: 'reports:write', label: 'Author stakeholder reports', description: 'Create, schedule and draft scheduled reports for managers', category: 'Insights' },
  { id: 'reports:publish', label: 'Publish reports externally', description: 'Publish a report and mint expiring share links for people outside the platform', category: 'Insights' },
  { id: 'messages:read', label: 'View messages', description: 'View messages and announcements', category: 'Messaging' },
  { id: 'messages:write', label: 'Send messages', description: 'Send messages and announcements', category: 'Messaging' },
  { id: 'billing:read', label: 'View billing', description: 'View subscriptions and usage', category: 'Billing & Quotas' },
  { id: 'billing:manage', label: 'Manage billing', description: 'Manage subscriptions, add-ons, and the billing portal', category: 'Billing & Quotas' },
  { id: 'quotas:read', label: 'View quotas', description: 'View organization quotas and usage', category: 'Billing & Quotas' },
  { id: 'registry:read', label: 'View registry', description: 'View the container image registry', category: 'Registry' },
  { id: 'registry:write', label: 'Copy container images', description: 'Copy and promote a container image into another repository', category: 'Registry' },
  { id: 'registry:purge', label: 'Delete container images', description: 'Delete images and repositories, and run registry garbage collection', category: 'Registry' },
  { id: 'impersonation:open', label: 'Open an impersonation session', description: "View a customer's account as one of its users, with that organization's consent", category: 'Impersonation' },
  { id: 'impersonation:approve', label: 'Answer impersonation requests', description: 'Approve or deny a request to view a member of this organization as that member', category: 'Impersonation' },
  { id: 'team_access:open', label: "View a team member's account", description: "View a member of one of this organization's teams as that member (read-only)", category: 'Impersonation' },
  { id: 'org_settings:write', label: 'Organization settings', description: 'Manage general org settings and AI config', category: 'Organization' },
  { id: 'org_idp:write', label: 'Manage SSO/IdP', description: 'Configure single sign-on and identity providers', category: 'Organization' },
  { id: 'org_kms:write', label: 'Manage encryption keys', description: 'Configure customer-managed KMS encryption keys', category: 'Organization' },
  { id: 'org_impersonation:write', label: 'Manage impersonation policy', description: 'Control whether platform operators may view the organization as one of its members', category: 'Organization' },
];

const PERMISSION_LABELS = new Map<string, string>(PERMISSION_CATALOG.map((p) => [p.id, p.label]));

/** Human label for a permission id (falls back to the raw id for an unknown one). */
export function permissionLabel(id: string): string {
  return PERMISSION_LABELS.get(id) ?? id;
}

/** One picker section: a category and the permissions it contains, in catalog order. */
export interface PermissionCategory {
  category: string;
  permissions: PermissionMeta[];
}

/** Group a permission list into categories, preserving catalog order. */
function groupByCategory(perms: readonly PermissionMeta[]): PermissionCategory[] {
  const order: string[] = [];
  const byCategory = new Map<string, PermissionMeta[]>();
  for (const p of perms) {
    if (!byCategory.has(p.category)) { byCategory.set(p.category, []); order.push(p.category); }
    byCategory.get(p.category)!.push(p);
  }
  return order.map((category) => ({ category, permissions: byCategory.get(category)! }));
}

/** Check whether a string is a valid Permission. */
export function isValidPermission(value: string): value is Permission {
  return (ALL_PERMISSIONS as readonly string[]).includes(value);
}

/**
 * Permissions that must NEVER be grantable through a user-authored CUSTOM Role —
 * they gate platform-operator surfaces (the shared image registry), so allowing
 * an org admin to mint a Role carrying them would be a latent privilege
 * escalation. They are NOT seeded into ANY built-in Role bundle (neither
 * `member` nor `admin`), so the only holder is a superadmin (implicit-all) —
 * which is what makes the image-registry gates that require them effectively
 * superadmin-only. This list ALSO blocks custom-Role authoring from requesting
 * them (see platform `sanitizePermissions`).
 */
export const SUPERADMIN_ONLY_PERMISSIONS: readonly Permission[] = [
  // `registry:read` and `registry:write` were both here. What stays is the
  // destructive rung alone: deleting a manifest or a whole repository, and the
  // GC prune, each of which can remove an image a tenant's pipeline still
  // resolves — including the digest-pinned plugin images the supply chain
  // verifies against. That is the one registry action with no undo, so it keeps
  // the narrowest possible audience: the flag, and never a Role.
  'registry:purge',
];

/**
 * Permissions that govern the PLUGIN ECOSYSTEM and may be held only inside the
 * system org (docs/plugin-publishing.md). Like
 * {@link SUPERADMIN_ONLY_PERMISSIONS} they are in no member/admin/owner bundle
 * and are never grantable through a custom Role in ANY org (platform
 * `sanitizePermissions` refuses them). The only holders are superadmins
 * (implicit-all) and members of the built-in "Ecosystem Manager" Role, which is
 * seeded in the system org alone from {@link ECOSYSTEM_MANAGER_PERMISSIONS} and
 * assignable only by a superadmin.
 *
 * `oncall:manage` is in NEITHER named role, which makes it superadmin-only in
 * practice. That is deliberate rather than an oversight: paging is the vendor's
 * own operational concern and has nothing to do with ecosystem moderation, so
 * widening the Ecosystem Manager role to carry it would hand the pager to
 * people hired to review plugins. It is not a placeholder — it gates two live
 * routes (the paging posture read and the test page), unlike `registry:*`.
 */
export const SYSTEM_ORG_ONLY_PERMISSIONS: readonly Permission[] = [
  'plugins:moderate',
  'publishers:verify',
  // The cross-tenant operator surfaces, system-org-only for the same reason the
  // consoles are: they read and move things belonging to organisations the
  // holder is not a member of, so they must never be grantable inside a tenant.
  'platform:read',
  'orgs:read',
  // Reading the image registry: repository names, tags, manifests, blobs and the
  // storage rollup. Promoted out of SUPERADMIN_ONLY because the registry browser
  // was invisible to every Role, so a Platform Operator debugging a failed
  // plugin build could see the build queue and its dead letters but not the
  // images the build produced — and the only way to look was the superadmin
  // flag. It stays system-org-only (no tenant Role may carry it) and is paired
  // with a per-repo org-ownership filter that runs AFTER it, so widening the
  // permission does not widen which repositories a holder can reach: a
  // system-org member who is not a superadmin sees `system/*`, `library/*` and
  // `public/*` — this deployment's own base and plugin images — and no tenant's
  // `org-*` repositories at all (`canReadRepo` in the image-registry service).
  'registry:read',
  // Copying/promoting an image. System-org-only rather than superadmin-only
  // because it is ADDITIVE: it writes a new tag and makes nothing stop
  // resolving, and `canWriteRepo` confines a non-superadmin system-org caller
  // to `system/*` regardless. Deliberately carried by NO built-in bundle today
  // — promoting an image is a job, not a side effect of running the deployment,
  // so it waits for a Role of its own rather than riding along with
  // `platform:read`.
  'registry:write',
  'billing:operate',
  'observability_console:open',
  'database_console:open',
  'objectstore_console:open',
  // Opening a cross-tenant impersonation session. System-org-only for the
  // obvious reason — it views an organisation the holder is not a member of —
  // and it is the ONE permission in this list that also has to clear a gate the
  // permission system does not own: the target organisation's consent (its
  // `org_impersonation:write` policy), plus aal2 and a strong step-up. The
  // permission says who may ASK; the tenant still answers.
  //
  // It does NOT cover emergency access. `POST /:userId/breakglass` bypasses
  // tenant consent and so stays on the superadmin flag alone, approved by a
  // SECOND superadmin (four-eyes). A permission that could be delegated must not
  // be able to walk past consent.
  'impersonation:open',
  // Paging is the vendor's own operational concern and grants NO tenant access
  // — `isSystemOrgId` is a content-owner check, not a privilege gate — so a
  // tenant role must never be able to carry it, and a tenant must never be able
  // to make this deployment send a page.
  'oncall:manage',
  // The vendor's own operational tasks. Each one replaced a `requireSystemAdmin`
  // gate, so the point of listing them here is the same as the point of adding
  // them at all: a Role composed in the system org can carry exactly one job,
  // and no Role in any tenant can carry it at all.
  'support_cases:write',
  'support_content:write',
  'subscriptions:read',
  'subscriptions:manage',
  'orgs:manage',
  'quotas:manage',
  'plugin_queue:manage',
];

/** Whether `permission` may be held only inside the system org. */
export function isSystemOrgOnlyPermission(permission: string): boolean {
  return (SYSTEM_ORG_ONLY_PERMISSIONS as readonly string[]).includes(permission);
}

/**
 * Permissions an org may assign via a CUSTOM Role — every permission except the
 * {@link SUPERADMIN_ONLY_PERMISSIONS} and {@link SYSTEM_ORG_ONLY_PERMISSIONS}.
 * Custom-Role create/update validates the requested permission set against this
 * (see platform roles-service).
 */
export const ORG_ASSIGNABLE_PERMISSIONS: readonly Permission[] =
  ALL_PERMISSIONS.filter((p) => isOrgAssignablePermission(p));

/** Whether `permission` may be granted through a user-authored custom Role. */
export function isOrgAssignablePermission(permission: Permission): boolean {
  return !SUPERADMIN_ONLY_PERMISSIONS.includes(permission) && !isSystemOrgOnlyPermission(permission);
}

/**
 * Category → permissions for the custom-Role AUTHORING picker: the catalog minus
 * the non-assignable permissions, with any now-empty category dropped
 * (so "Registry" disappears). The grouped view of
 * {@link ORG_ASSIGNABLE_PERMISSIONS}.
 */
export const ORG_ASSIGNABLE_CATEGORIES: readonly PermissionCategory[] =
  groupByCategory(PERMISSION_CATALOG.filter((p) => isOrgAssignablePermission(p.id)));

// =============================================================================
// Permission-scoped credentials (personal access keys / machine tokens)
// =============================================================================

/**
 * Every `:read` permission — the "read-only" preset a new personal access key
 * starts from. Derived from the catalog so a new resource's read permission
 * joins the preset without a second edit.
 */
export const READ_ONLY_PERMISSIONS: readonly Permission[] =
  ALL_PERMISSIONS.filter((p) => p.endsWith(':read'));

/**
 * Normalize a requested permission subset: every entry must be a catalog id
 * (anything else → `null`, the caller's 400), duplicates collapse, and the
 * result is in canonical catalog order so a stored subset compares stably.
 * An EMPTY array is valid — a key that can authenticate but do nothing — and
 * is distinct from "no subset" (`undefined`), which means full access.
 */
export function normalizePermissionSubset(requested: readonly unknown[]): Permission[] | null {
  const wanted = new Set<string>();
  for (const p of requested) {
    if (typeof p !== 'string' || !isValidPermission(p)) return null;
    wanted.add(p);
  }
  return ALL_PERMISSIONS.filter((p) => wanted.has(p));
}

/**
 * The permissions a permission-scoped credential actually carries: the
 * INTERSECTION of the subset it was created with and the holder's CURRENT
 * effective permissions, in catalog order. Re-evaluated at every issue, so
 * losing a Role shrinks the credential and nothing can ever grow it past the
 * subset it was created with.
 */
export function intersectPermissions(
  effective: readonly string[],
  subset: readonly string[],
): Permission[] {
  const allowed = new Set(subset);
  const held = new Set(effective);
  return ALL_PERMISSIONS.filter((p) => allowed.has(p) && held.has(p));
}

// =============================================================================
// Built-in Role seed bundles
// =============================================================================

/**
 * Permission bundles used to SEED the built-in Roles ("Admin", "Member").
 *
 * This is the single definition of what those built-in Roles grant — it is used
 * when a Role record is created (and by the startup backfill) to populate that
 * Role's own `permissions[]`. It is NOT a runtime permission source: a user's
 * effective permissions come ONLY from the Roles assigned to them (see
 * {@link resolveUserPermissions}). The coarse `role` label (owner/admin/member)
 * survives only for `isAdmin`/ownership/display, never to grant permissions.
 *
 * - `member`  — day-to-day builder: read + write on pipelines/templates/plugins,
 *   read elsewhere. No member/role/billing management, no compliance/alert
 *   authoring, and no `:publish` on any catalog.
 * - `admin`   — full org administration: every ORG-ASSIGNABLE permission (i.e.
 *   ALL_PERMISSIONS minus the {@link SUPERADMIN_ONLY_PERMISSIONS} and the
 *   {@link SYSTEM_ORG_ONLY_PERMISSIONS}, so `registry:*` stay
 *   superadmin-implicit-only and ecosystem moderation stays with the system
 *   org's Ecosystem Managers — neither is granted to org admins).
 * - `owner`   — same as admin (ownership itself — transfer/delete — is gated
 *   separately, not via a permission).
 */
const MEMBER_PERMISSIONS: readonly Permission[] = [
  'pipelines:read', 'pipelines:write', 'pipeline_registry:write',
  'templates:read', 'templates:write',
  'plugins:read', 'plugins:write',
  'plugins:install',
  'compliance:read',
  'dashboards:read',
  'observability:read',
  'reports:read',
  'messages:read', 'messages:write',
  'billing:read',
  'quotas:read',
];

const ADMIN_PERMISSIONS: readonly Permission[] = [...ORG_ASSIGNABLE_PERMISSIONS];

/**
 * Seed bundle for each built-in Role, keyed by the coarse role it grants.
 * Consumed by the Role seeder + the startup backfill to populate a built-in
 * Role's `permissions[]`. NOT consulted at request time — see
 * {@link resolveUserPermissions}.
 */
export const ROLE_PERMISSIONS: Record<OrgRole, readonly Permission[]> = {
  member: MEMBER_PERMISSIONS,
  admin: ADMIN_PERMISSIONS,
  owner: ADMIN_PERMISSIONS,
};

/**
 * Seed bundle for the built-in "Ecosystem Manager" Role — seeded ONLY in the
 * system org (docs/plugin-publishing.md). It carries the
 * {@link SYSTEM_ORG_ONLY_PERMISSIONS} plus the reads a moderator needs (the
 * in-app catalog, in-app notices, the moderation-SLA dashboard) and nothing
 * tenant-facing: no `registry:*`, no `members:manage`. The Role grants the
 * coarse `member` label and never sets `isSuperAdmin`.
 */
/**
 * The PLATFORM OPERATOR bundle — the third rung of the system org's ladder.
 *
 * Before it the ladder had two rungs and a gap: Ecosystem Manager (plugin
 * moderation) and Super Admin (implicit-all, which also carries impersonation,
 * pgAdmin and mongo-express). Anything in between — read the platform settings,
 * run a promotion campaign, check whether the pager is configured — had to be
 * done by making somebody a full superadmin.
 *
 * It is a BUNDLE rather than a grantable list because `SYSTEM_ORG_ONLY_PERMISSIONS`
 * can never be carried by a custom Role in any org: without a seeded bundle
 * these permissions had no grant path at all and were superadmin-only in
 * practice, which is exactly the thing they were added to avoid.
 *
 * Deliberately NOT carrying `plugins:moderate` / `publishers:verify`: ecosystem
 * moderation is a different job with its own Role, and a reviewer of plugins
 * should not acquire the ability to move another tenant's money by being handed
 * the operator Role.
 */
export const PLATFORM_OPERATOR_PERMISSIONS: readonly Permission[] = [
  // BOTH halves of the old `platform:read`: this is the one job that genuinely
  // wants the deploy's own configuration AND the customer roster.
  'platform:read',
  'orgs:read',
  'oncall:manage',
  'observability_console:open',
  // RUNNING the deployment: raise a quota during an incident, watch the build
  // queue and purge its dead-letter queue.
  'quotas:manage',
  'plugin_queue:manage',
  // Reads that make the operator views usable: the dashboards the posture panels
  // live on, the cross-tenant log view, and the customer's plan when a limit is
  // the thing being debugged.
  'observability:read',
  'dashboards:read',
  'subscriptions:read',
  // The registry browser: repository names, tags and manifests for the images
  // this deployment's builds produce. It was withheld while `registry:read` was
  // superadmin-only — a seeded bundle carrying a superadmin-only permission
  // would make that list a lie, since bundles bypass `sanitizePermissions`. The
  // permission was promoted to system-org-only deliberately rather than smuggled
  // in here, which is the order those two changes have to happen in.
  'registry:read',
];

/**
 * ACCOUNT MANAGER — the commercial relationship with a customer, as opposed to
 * running the deployment.
 *
 * Split from {@link PLATFORM_OPERATOR_PERMISSIONS} rather than piled onto it,
 * because the two jobs diverge at exactly the permissions added alongside this
 * bundle. `billing:operate` MOVED here from the operator bundle for that reason:
 * minting a discount token is a commercial act, not an operational one, and the
 * person who restarts a stuck build queue has no reason to hold it.
 *
 * The destructive half of the catalogue lives here — `orgs:manage` can DELETE
 * an organisation and `subscriptions:manage` can cancel its subscription — so
 * this is deliberately the smaller, more rarely-assigned of the two.
 */
export const ACCOUNT_MANAGER_PERMISSIONS: readonly Permission[] = [
  'subscriptions:read',
  'subscriptions:manage',
  'orgs:manage',
  'billing:operate',
  // A quota bump is as often a commercial concession as an operational one, so
  // both bundles carry it.
  'quotas:manage',
  // The all-organizations list, which is the surface this job works from — and
  // only that. It used to take `platform:read`, which also handed over the
  // deploy's RLS mode, KMS posture and rendered alert rules: internals a
  // commercial role has no use for.
  'orgs:read',
];

/**
 * CONSOLE ADMINISTRATOR — the operator consoles, as a Role.
 *
 * WHY THIS EXISTS even though each console permission is grantable by hand: with
 * no seeded Role, the only path to pgAdmin was a superadmin composing a custom
 * Role for it, and the observed outcome of asking people to do that is that they
 * reach for the superadmin FLAG instead — the exact failure these permissions
 * were added to remove. A named Role also makes "who can open a data shell?" one
 * query instead of an audit of every custom Role.
 *
 * It carries all three consoles, which is the whole job for the person who holds
 * it. ONE CONSEQUENCE WORTH KNOWING: `database_console:open` and
 * `objectstore_console:open` are the two halves of the audit tamper-evidence
 * design — a Mongo shell can truncate a hash chain's tail, and the object store
 * holds the signed heads that would expose the truncation — so a holder of this
 * Role can do both. The permissions stay SEPARATE for exactly that reason: a
 * deployment that wants them held by different people composes a narrower Role
 * by hand (a superadmin may include any system-org-only permission in a Role
 * authored in the system org) and assigns this one to nobody.
 */
/**
 * PLATFORM OBSERVER — look, don't touch. The ladder's missing bottom rung.
 *
 * Every other system-org bundle grants a write. The one that does not —
 * Console Administrator — grants a read that IS a database shell. So somebody
 * who should see the deployment and change nothing (a new operator shadowing, an
 * auditor, an on-call engineer during a handover) had two options: Super Admin,
 * or nothing. The usual outcome of a choice like that is the flag.
 *
 * Strictly read-only by construction: every permission here ends `:read`, which
 * `isMutationPermission` classifies as a read, so the dashboard disables every
 * write affordance for a holder rather than offering controls that 403.
 *
 * NOT `audit:read`. It would be the obvious addition and it is the wrong one:
 * `listAuditEvents` pins every non-superadmin to their OWN org, so a system-org
 * observer holding it would see the system org's audit trail and nothing else —
 * an affordance that looks like fleet-wide audit access and is not. Reading
 * another tenant's trail is deliberately the flag's alone.
 */
export const PLATFORM_OBSERVER_PERMISSIONS: readonly Permission[] = [
  'platform:read',
  'orgs:read',
  'subscriptions:read',
  'observability:read',
  'dashboards:read',
  // A read, and this Role is reads — the registry browser with neither of the
  // two write rungs (`registry:write` copies, `registry:purge` deletes).
  'registry:read',
];

export const CONSOLE_ADMIN_PERMISSIONS: readonly Permission[] = [
  'observability_console:open',
  'database_console:open',
  'objectstore_console:open',
  // The all-organizations list, so a holder can find the org they were asked
  // about without a second Role — and nothing more. This was `platform:read`,
  // which meant opening a database console also granted the deploy's own
  // configuration, for no reason beyond the two sharing a gate.
  'orgs:read',
];

/**
 * REGISTRY OPERATOR — moves container images around, and nothing else.
 *
 * THE GAP IT FILLS. Promoting an image — copying a built tag from one repository
 * to the one a release resolves — is a job somebody does, and until now the only
 * identity that could do it was a superadmin. `registry:write` has no other
 * carrier, and a system-org-only permission with no seeded carrier is
 * superadmin-only in practice (the `platform:read` failure, pinned by the
 * "at least one seeded carrier" assertion in api-core's `test/permissions.test.ts`).
 * So splitting `registry:purge` out of `registry:write` is only half the change:
 * the additive half needs a Role or the split buys nothing.
 *
 * WHY IT IS NOT PART OF PLATFORM OPERATOR. That Role runs the deployment and
 * already reads the registry. Promoting an image is a release decision, not an
 * operational side effect, and rolling it into the Role everyone on call holds
 * would mean the pager rotation can retag a release at 3am. The two Roles
 * compose instead — a member may hold any number, and permissions are the union.
 *
 * WHY IT IS ONLY TWO PERMISSIONS. Deliberately nothing else: no `platform:read`,
 * no console, no `orgs:read`. `canReadRepo`/`canWriteRepo` confine a
 * non-superadmin system-org holder to `system/*`, `library/*` and `public/*` —
 * this deployment's own base and plugin images — so the Role cannot reach a
 * tenant's repositories at all, and a holder who also needs the operator views
 * gets the operator Role too. It does NOT carry `registry:purge`, which is in
 * {@link SUPERADMIN_ONLY_PERMISSIONS} and in no bundle by design: an image
 * promoter has no business deleting the image a tenant's pipeline resolves.
 */
export const REGISTRY_OPERATOR_PERMISSIONS: readonly Permission[] = [
  'registry:read',
  'registry:write',
];

/**
 * SUPPORT AGENT — the support desk, and nothing else.
 *
 * Deliberately carries no `platform:read`, no console and no billing write: an
 * agent answers cases and writes the canned replies. `subscriptions:read` is
 * here because the first question on any case is what the customer is entitled
 * to, and without it an agent would have to ask someone else to look.
 */
export const SUPPORT_AGENT_PERMISSIONS: readonly Permission[] = [
  'support_cases:write',
  'support_content:write',
  'subscriptions:read',
  // NEW, and the gap the split exposed: an agent triaging a case needs to find
  // the customer's organization. The only permission that listed orgs was
  // `platform:read`, which would also have handed a support agent the deploy's
  // internals — so they had neither, and had to ask someone else to look.
  'orgs:read',
  // Reading and answering the case itself rides the ordinary messaging
  // permissions — a support case IS a message thread.
  'messages:read',
  'messages:write',
];

/**
 * SUPPORT LEAD — the support desk, plus the authority to look.
 *
 * THE GAP IT FILLS. `impersonation:open` is system-org-only, and a system-org-only
 * permission with no seeded carrier is superadmin-only in practice — the
 * invariant api-core's `test/permissions.test.ts` asserts, and the reason
 * `platform:read` shipped unusable. Without this Role, splitting impersonation
 * out of the flag would change nothing: the only way to let somebody view a
 * customer's account would still be to make them a full Super Admin, handing
 * over `/admin/users/:id/grants`, the single-person MFA reset, the database
 * console and `registry:purge` at the same time.
 *
 * WHY IT IS THE SUPPORT DESK AND NOT THE OPERATOR. The question impersonation
 * answers is "what is this customer actually seeing?", which is a support
 * question. Platform Operator runs the deployment and is held by whoever is on
 * call; adding this to it would hand every rota member the ability to become any
 * customer's user at 3am. Support Agent's bundle plus the one permission is the
 * narrower, more honest shape — and a lead who also runs the deployment holds
 * both Roles.
 *
 * WHAT IT STILL CANNOT DO. Emergency access: `breakglass` bypasses tenant
 * consent and stays on the flag, approved by a second Super Admin. And the
 * tenant can refuse — `impersonation:open` is permission to ASK.
 */
export const SUPPORT_LEAD_PERMISSIONS: readonly Permission[] = [
  ...SUPPORT_AGENT_PERMISSIONS,
  'impersonation:open',
];

/**
 * STARTING POINTS for a custom Role in a tenant org — templates, not Roles.
 *
 * THE GAP THEY FILL. An org seeds exactly TWO Roles — Member and Admin — and
 * Admin is every org-assignable permission. So promoting anyone past "author and
 * read" hands over the whole remainder at once: `org_kms:write`,
 * `org_idp:write`, `org_impersonation:write`, `billing:manage`, `roles:manage`
 * and `audit:read` among them. The product's answer is "author a custom Role",
 * and the safety is already right (`sanitizePermissions` bounds a custom Role by
 * its author's own ceiling). What was missing is the starting point.
 *
 * The exact sizes of that cliff are asserted in `test/permissions.test.ts`
 * rather than written here. This paragraph used to carry them inline — "three
 * Roles: Member (15), Team Lead (17) and Admin (37)" — and every one of those
 * numbers went stale: `Team Lead` stopped being seeded when it became the first
 * template below, and the two bundles have grown since. A count nothing checks
 * is a claim that decays, and this one was the stated rationale for the feature.
 *
 * WHY TEMPLATES AND NOT SEEDED ROLES. A seeded built-in is `system: true` and
 * therefore immutable, so seeding these would put four undeletable rows in every
 * org whether it wants them. A template leaves no trace until someone uses it,
 * and what it produces is an ordinary custom Role the org fully owns — editable,
 * deletable, and bounded by the author's ceiling like any other.
 *
 * WHAT THEY DELIBERATELY EXCLUDE. `roles:manage` is in none of them. It is the
 * one permission that compounds — the holder can mint further Roles, up to their
 * own ceiling — so acquiring it should stay a conscious act rather than a side
 * effect of picking a preset. Every permission here is org-assignable, so a
 * template is valid in any org and `sanitizePermissions` accepts it.
 */
export interface RoleTemplate {
  id: string;
  name: string;
  /** What the job is — shown next to the template, and a sensible Role description. */
  description: string;
  permissions: readonly Permission[];
}

export const ROLE_TEMPLATES: readonly RoleTemplate[] = [
  {
    // Was a SEEDED Role in every org until it became a template. It is the only
    // built-in that was a job description rather than a structural requirement:
    // Super Admin is where `isSuperAdmin` is derived from, Admin and Member are
    // the floor an org is unusable without, and the system-org Roles carry
    // permissions no custom Role may hold. Team Lead was none of those — it is
    // `member` plus two report permissions, and an org that does not delegate
    // report authoring had an undeletable row for it anyway.
    //
    // CONSEQUENCE, stated rather than discovered: a new org no longer has a Role
    // that grants `reports:write` to a non-admin. An admin holds both permissions
    // (they are in the admin bundle) and instantiates this template to delegate
    // them — the same shape as the four below. Orgs that already have the seeded
    // Role keep it, and the backfill keeps its bundle current.
    id: 'team-lead',
    name: 'Team Lead',
    description: 'Authors and shares stakeholder reports for a team, without org-admin access.',
    permissions: [...MEMBER_PERMISSIONS, 'reports:write', 'reports:publish'],
  },
  {
    /**
     * MEMBER ALREADY IS THE DEVELOPER ROLE — this template exists for what it
     * does NOT cover.
     *
     * Everything in a developer's loop is `pipelines:read` + `pipelines:write`,
     * both in the member bundle: create, edit, validate, run, stop, the bulk
     * ops, AI generation (`/pipelines/generate`, incl. from-url and streaming),
     * the pipeline registry, plus `templates:read` to instantiate and
     * `plugins:install` to add a plugin. A template restating that would buy
     * nothing.
     *
     * What a developer hits the cliff on is the SELF-SERVICE operate pair: they
     * can read their service's dashboards and metrics and cannot change either,
     * because both writes sit in the admin bundle. So the person who owns a
     * pipeline files a ticket to get an alert on it.
     *
     * DELIBERATELY NOT HERE. `logs:export` — viewing logs rides
     * `observability:read`, but downloading them is bulk egress an org may
     * withhold from members (docs/permissions.md), and a template aimed at every
     * engineer would reverse that. `pipelines:publish` — sharing beyond the
     * author is a release decision, which is Release Manager's below; somebody
     * who does both holds both Roles.
     */
    id: 'developer',
    name: 'Developer',
    description: 'Builds and runs pipelines, and owns the dashboards and alerts for what they build.',
    permissions: [...MEMBER_PERMISSIONS, 'dashboards:write', 'observability:write'],
  },
  {
    id: 'release-manager',
    name: 'Release Manager',
    description: 'Decides what becomes shared beyond its author, and approves plugin installs.',
    permissions: [
      'pipelines:read', 'pipelines:publish',
      'templates:read', 'templates:publish',
      'plugins:read', 'plugins:publish',
      'plugin_installs:manage',
    ],
  },
  {
    id: 'security-officer',
    name: 'Security Officer',
    description: 'Identity, encryption keys and the evidence trail — the surface an auditor asks about.',
    permissions: [
      'audit:read', 'logs:export',
      'compliance:read', 'compliance:write',
      'org_idp:write', 'org_kms:write', 'org_impersonation:write',
      // Owning the impersonation POLICY (`org_impersonation:write`) without
      // being able to answer a REQUEST was the asymmetry the consent flow left
      // behind: the lesser act had a permission of its own and the greater one
      // had none. Whoever decides whether consent is required should be able to
      // give or withhold it.
      'impersonation:approve',
    ],
  },
  {
    id: 'people-manager',
    name: 'People Manager',
    description: 'The roster and its machine credentials, across the account\u2019s teams — without the org\u2019s settings or its money.',
    permissions: [
      'members:manage', 'invitations:manage', 'service_accounts:manage',
      // The same job, one level down: entering a descendant team to work on its
      // roster, and viewing one of its members as that member. Without it a
      // people manager in a parent org can administer the account's teams on
      // paper and not reach them.
      'team_access:open',
    ],
  },
  {
    id: 'billing-manager',
    name: 'Billing Manager',
    description: 'The subscription, seats and invoices for this organization.',
    permissions: [
      'billing:read', 'billing:manage', 'quotas:read',
    ],
  },
  {
    /**
     * The job the impersonation consent flow created INSIDE the tenant: the
     * named person who answers "may a support engineer view this account?" and
     * can afterwards read what happened.
     *
     * It exists as a template because `impersonation:approve` is in the admin
     * and owner bundles — so by default every admin may consent — and the whole
     * point of splitting it out was to let an org say "this decision is one
     * person's". Doing that means authoring a Role that holds it and taking it
     * off the others, and hand-composing was the only route.
     *
     * Two permissions and no more: approving is not administering. `audit:read`
     * is here because consenting without being able to check what the session
     * then did is consent in name only.
     */
    id: 'access-approver',
    name: 'Access Approver',
    description: 'Answers requests to view this organization\u2019s accounts, and reads the trail of what happened.',
    permissions: [
      'impersonation:approve', 'audit:read',
    ],
  },
];

export const ECOSYSTEM_MANAGER_PERMISSIONS: readonly Permission[] = [
  'plugins:read',
  'plugins:moderate',
  'publishers:verify',
  'messages:read',
  'observability:read',
];

/**
 * Seed bundle for the built-in "Team Lead" Role — the person who reports UPWARD.
 *
 * Exists because the target user for stakeholder reports is a lead, not an admin,
 * and granting `reports:write` only through the admin bundle would have forced
 * every reporting lead to be an org admin (members:manage, roles:manage,
 * org_settings:write, billing) to send their manager a weekly summary.
 *
 * Deliberately NOT included: `reports:rollup`. Rolling a report up over descendant
 * teams is downward visibility across the org tree, which is a granted capability
 * in this model, not something a team's own lead gets by default — a lead of a
 * PARENT org is granted it explicitly. The Role grants the coarse `member` label
 * and never sets `isSuperAdmin`.
 */
export const TEAM_LEAD_PERMISSIONS: readonly Permission[] = [
  ...MEMBER_PERMISSIONS,
  'reports:write',
  'reports:publish',
];

/**
 * Seed bundle for the built-in "Pipeline Automation" Role — what the org's
 * unscoped stored credential (the `platform-automation` service account that
 * `pipeline-manager infra store-token` provisions) needs, and nothing more.
 *
 * Derived by tracing every call made with that key, not by guessing:
 *  - `pipelines:read` — the CodeBuild synth (and `pipeline deploy --store-tokens`)
 *    fetching the pipeline it builds (`GET /pipelines/:id`);
 *  - `plugins:read`   — plugin resolution at synth/deploy and in the plugin-lookup
 *    Lambda (`POST /plugins/lookup`), and the run-time vulnerability check step
 *    (`POST /plugins/runtime-check`).
 *
 * What it deliberately does NOT carry, and where that work went:
 *  - registry writes (`pipeline_registry:write`) — the synth registers its step
 *    manifest with the separate `pipeline-register` key (Pipeline Registration);
 *  - image pushes and pulls — CodeBuild authenticates to the image registry with
 *    the `registry-push` scoped key, never this one;
 *  - reporting writes — the events Lambda and step report uploads use the
 *    `reporting:ingest` scoped key.
 *
 * It used to be the org ADMIN Role, so a leaked synth credential could rewrite
 * every pipeline, Role and member of the org.
 */
export const PIPELINE_AUTOMATION_PERMISSIONS: readonly Permission[] = [
  'pipelines:read',
  'plugins:read',
];

/**
 * Seed bundle for the built-in "Pipeline Registration" Role, held by the
 * `pipeline-register` service account: `POST`/`DELETE /pipelines/registry` for
 * its own org and nothing else — not even a read.
 */
export const PIPELINE_REGISTRATION_PERMISSIONS: readonly Permission[] = [
  'pipeline_registry:write',
];

// =============================================================================
// Resolution
// =============================================================================

/**
 * Resolve a user's effective org permissions from the Roles assigned to them.
 *
 * Single-source model: a user's abilities are EXACTLY the union of the
 * permissions carried by the Roles they hold (a Role = a named permission set;
 * built-in Roles carry their bundle explicitly, seeded from
 * {@link ROLE_PERMISSIONS}). There is no separate role-derived baseline — the
 * coarse `role` label grants nothing on its own.
 *
 * 1. Platform superadmins (`isSuperAdmin`) always get ALL permissions.
 * 2. Otherwise, union every permission granted by the user's assigned Roles.
 * 3. Invalid/unknown permission strings are silently ignored.
 *
 * @param assignedPermissions - Flattened permissions from every Role the user holds
 * @param isSuperAdmin - Whether the user has the global super-admin flag
 * @returns Effective permissions in canonical order
 */
export function resolveUserPermissions(
  assignedPermissions?: readonly string[] | null,
  isSuperAdmin?: boolean,
): Permission[] {
  if (isSuperAdmin) return [...ALL_PERMISSIONS];

  const perms = new Set<Permission>();
  if (assignedPermissions) {
    for (const p of assignedPermissions) {
      if (isValidPermission(p)) perms.add(p);
    }
  }
  return ALL_PERMISSIONS.filter(p => perms.has(p));
}

/**
 * Confine a resolved permission list to what may be held in the token's ACTIVE
 * org: outside the system org every {@link SYSTEM_ORG_ONLY_PERMISSIONS} entry is
 * dropped (docs/plugin-publishing.md). Applied at token issue on
 * top of {@link resolveUserPermissions} — including a superadmin's implicit-all —
 * so a token minted in a tenant org never CLAIMS `plugins:moderate` /
 * `publishers:verify`, even if a hand-written Role document somehow carried
 * them there. (Superadmins still pass `hasPermission` via the flag; the
 * ecosystem route gate additionally requires the system org, so that bypass
 * never reaches a governance route from a tenant org either.)
 *
 * Takes a boolean rather than an org id so this module stays dependency-free
 * (the frontend imports it); callers decide with api-core `isSystemOrgId`.
 */
export function confinePermissionsToOrg<P extends string>(
  permissions: readonly P[],
  activeOrgIsSystemOrg: boolean,
): P[] {
  return activeOrgIsSystemOrg ? [...permissions] : permissions.filter((p) => !isSystemOrgOnlyPermission(p));
}

/** Whether a resolved permission list grants `permission` (superadmin ⇒ always). */
export function hasPermission(
  granted: readonly string[] | null | undefined,
  permission: Permission,
  isSuperAdmin?: boolean,
): boolean {
  if (isSuperAdmin) return true;
  return !!granted && granted.includes(permission);
}

// =============================================================================
// Built-in Role seed bundles, as a TABLE
// =============================================================================

/**
 * The named permission bundles a built-in Role may carry, and the Role NAME each
 * one is seeded under. One table, because the three facts about a job Role —
 * its id, its permissions and its display name — were previously three
 * independent lists in three places, and nothing held them together.
 *
 * WHAT WENT WRONG WITHOUT IT. The platform resolved a bundle through a
 * nine-branch `if` chain with a fall-through to the coarse `grantsRole` bundle.
 * Every job Role grants `member`, so a bundle added to the id list WITHOUT its
 * branch did not fail — it silently seeded the plain Member bundle, and the
 * startup backfill then re-synced it to that wrong value on every boot. The
 * Role existed, was assignable from the staffing panel, and granted fifteen
 * tenant permissions instead of its job. Nothing anywhere exercised the
 * resolver per bundle.
 *
 * Keyed access plus `satisfies` makes a missing entry a COMPILE error, and an
 * extra one too — in both directions, with no runtime check to forget.
 *
 * The NAME lives here for the same reason. The platform seeded names from its
 * own constants while the frontend's staffing roster hard-coded its own copy,
 * each pinned by a test against itself — so renaming a Role passed both suites
 * and the roster silently rendered "Role not found", which is the grant path for
 * that Role's permissions disappearing. Both sides read this now.
 */
export const SEED_BUNDLES = {
  ecosystem_manager: { name: 'Ecosystem Manager', permissions: ECOSYSTEM_MANAGER_PERMISSIONS },
  team_lead: { name: 'Team Lead', permissions: TEAM_LEAD_PERMISSIONS },
  platform_observer: { name: 'Platform Observer', permissions: PLATFORM_OBSERVER_PERMISSIONS },
  platform_operator: { name: 'Platform Operator', permissions: PLATFORM_OPERATOR_PERMISSIONS },
  account_manager: { name: 'Account Manager', permissions: ACCOUNT_MANAGER_PERMISSIONS },
  console_admin: { name: 'Console Administrator', permissions: CONSOLE_ADMIN_PERMISSIONS },
  support_agent: { name: 'Support Agent', permissions: SUPPORT_AGENT_PERMISSIONS },
  support_lead: { name: 'Support Lead', permissions: SUPPORT_LEAD_PERMISSIONS },
  registry_operator: { name: 'Registry Operator', permissions: REGISTRY_OPERATOR_PERMISSIONS },
  pipeline_automation: { name: 'Pipeline Automation', permissions: PIPELINE_AUTOMATION_PERMISSIONS },
  pipeline_registration: { name: 'Pipeline Registration', permissions: PIPELINE_REGISTRATION_PERMISSIONS },
} as const;

/** Every seed-bundle id. The platform's `Role.seedBundle` enum is this list. */
export const SEED_BUNDLE_IDS = Object.keys(SEED_BUNDLES) as Array<keyof typeof SEED_BUNDLES>;
export type SeedBundleId = keyof typeof SEED_BUNDLES;

/**
 * The SYSTEM ORG's job Roles, in staffing order — the subset of
 * {@link SEED_BUNDLES} seeded there, which is every bundle except `team_lead`
 * (a tenant job, and a template rather than a seeded Role since it stopped
 * being structural).
 *
 * `ecosystem_manager` IS one of them; it is listed here even though its roster
 * lives on the Ecosystem console rather than the staffing panel, because what
 * this list answers is "which Roles does the system org seed", not "which panel
 * renders them".
 */
export const SYSTEM_ORG_JOB_BUNDLES: readonly SeedBundleId[] = [
  'ecosystem_manager',
  'platform_observer',
  'platform_operator',
  'account_manager',
  'console_admin',
  'support_agent',
  'support_lead',
  'registry_operator',
];

/**
 * The MACHINE Roles every org seeds — the subset of {@link SEED_BUNDLES} held by
 * the service accounts `pipeline-manager infra store-token` provisions.
 *
 * Seeded rather than offered as a {@link ROLE_TEMPLATES} entry, unlike the
 * tenant job presets, because they are structural: the CLI grants one to the
 * account it creates and the startup backfill moves existing accounts onto it,
 * and both have to find it in EVERY org by a stable identity. A template leaves
 * nothing to find until somebody instantiates it.
 */
export const ORG_AUTOMATION_BUNDLES: readonly SeedBundleId[] = [
  'pipeline_automation',
  'pipeline_registration',
];

/**
 * The service accounts `pipeline-manager infra store-token` provisions, keyed by
 * account name, and the built-in Role each holds — `null` for an account whose
 * key carries a capability SCOPE (a `TokenScope`) and so needs no Role at all.
 *
 * One table for the CLI (which Role to grant a NEW account) and the platform's
 * startup backfill (which Role to move an EXISTING account onto, off the org
 * admin Role these accounts were once given). A rename here moves both.
 */
export const AUTOMATION_ACCOUNT_BUNDLES = {
  'platform-automation': 'pipeline_automation',
  'pipeline-register': 'pipeline_registration',
  'reporting-ingest': null,
  'registry-push': null,
} as const satisfies Record<string, SeedBundleId | null>;
