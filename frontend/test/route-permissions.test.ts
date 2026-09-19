// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * UI gate ↔ API gate parity.
 *
 * Each service's route-coverage test writes its resolved route table to
 * `src/generated/route-table/<service>.json` (see docs/permissions.md →
 * "Route coverage"). A table entry records EVERY gate the route runs, not just
 * permissions: `permissions`, `systemAdmin`, `features` (paid entitlements),
 * `stepUp` (recent re-authentication), `scopes` (machine-credential scopes) and
 * `minAssurance` (authenticator strength).
 *
 * This suite maps every gated control in the dashboard to the route(s) it calls
 * and asserts, for EACH of those dimensions:
 *
 *   1. the control's page/component really declares that gate (the `can('…')`,
 *      the nav/page-access permission, the `ai_generation` lock, …), and
 *   2. holding what the control declares SATISFIES what the route enforces — so
 *      a button can never be shown to someone the API will reject, and a gate
 *      rename or a new gate on either side fails here.
 *
 * Controls are mapped explicitly (there is no way to infer which fetch a button
 * makes). The `GATED_ROUTES_WITHOUT_A_CONTROL` registry closes the other half:
 * every route that enforces anything beyond plain permissions must be either
 * mapped to a control here or listed there WITH A REASON, so a newly gated route
 * cannot land unmapped — the test fails naming the route.
 *
 * NOT covered on purpose: `:publish` controls (`can('pipelines:publish')` etc.).
 * Publishing is not a separate route — `resolveVisibility` checks the permission
 * inside the write handler — so there is no route requirement to compare against.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolvePageGate } from '../src/lib/page-access';
import { FEATURE_GATES } from '../src/lib/feature-gates';
import { ALL_FEATURE_FLAGS, type FeatureFlag } from '../src/lib/feature-flags';

interface PermissionGate {
  mode: 'any' | 'all';
  permissions: string[];
  allowService: boolean;
}

interface RouteTableEntry {
  method: string;
  path: string;
  auth: boolean;
  permissions: PermissionGate[];
  systemAdmin: boolean;
  servicePrincipal: boolean;
  /** Non-empty on an INTERNAL route (#14): the services allowed to call it. No
   *  user token reaches such a route, so no UI control can ever drive one. */
  internalCallers: string[];
  stepUp: boolean;
  features: string[];
  scopes: string[];
  /** Minimum authenticator-assurance level (0 = none, 2 = strong factor). */
  minAssurance: number;
  audit: string[];
}

const TABLE_DIR = resolve(__dirname, '../src/generated/route-table');
const FRONTEND_DIR = resolve(__dirname, '..');

const tables: Record<string, RouteTableEntry[]> = Object.fromEntries(
  readdirSync(TABLE_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => [f.replace(/\.json$/, ''), JSON.parse(readFileSync(resolve(TABLE_DIR, f), 'utf8')) as RouteTableEntry[]]),
);

/** A gated UI control, the gates it declares, and the routes it drives. */
interface Control {
  /** What the user sees / does. */
  control: string;
  /** Source file holding the permission check. */
  file: string;
  /**
   * Extra sources that hold part of this control's gating — a modal, a shared
   * card, the panel a page delegates to. Searched alongside `file` when checking
   * that a declared FEATURE gate is really rendered.
   */
  gateFiles?: string[];
  /** Permission ids the control checks INLINE (the set a holder would have). */
  permissions: string[];
  /**
   * Permissions the control does not re-check because the PAGE already gates on
   * them (the read gate in `src/lib/nav.ts` → `src/lib/page-access.ts`). Listed
   * so the row still records everything the route needs, and verified against
   * `resolvePageGate(page)` rather than by grepping for a string.
   */
  pagePermissions?: string[];
  /** Next.js pathname the control lives on — required with `pagePermissions`. */
  page?: string;
  /**
   * Permissions NOTHING in the UI checks, each with the reason that is safe —
   * i.e. every role able to reach the surface already holds it. Writing the
   * reason down is the point: it stops "nobody checks this" being invisible.
   */
  implicitPermissions?: { permission: string; why: string }[];
  /** Entitlements the routes require. Must be rendered as a lock, not hidden. */
  features?: FeatureFlag[];
  /** The routes demand a recent re-authentication (`requireStepUp`). */
  stepUp?: boolean;
  /** Highest `minAssurance` the routes demand (0 when none do). */
  minAssurance?: number;
  /** `<service> <METHOD> <path>` entries from the generated tables. */
  routes: string[];
  /**
   * How the INLINE permission appears in `file`. Write controls check it with
   * `can('x:y')` (the default); whole-page READS are gated by the nav's
   * `requiredPermission`, so those rows use `'nav'`; a control that must stay
   * VISIBLE-but-disabled during read-only impersonation checks
   * `hasPermission(user, 'x:y')` instead, so those rows use `'has'`.
   */
  via?: 'can' | 'nav' | 'has';
}

const CONTROLS: Control[] = [
  {
    control: 'New / edit / delete pipeline',
    file: 'pages/dashboard/pipelines.tsx',
    permissions: ['pipelines:write'],
    routes: ['pipeline POST /pipelines', 'pipeline PUT /pipelines/:id', 'pipeline DELETE /pipelines/:id'],
  },
  {
    control: 'Restore / purge a deleted pipeline',
    file: 'pages/dashboard/pipelines.tsx',
    gateFiles: ['src/components/RecentlyDeletedPanel.tsx'],
    permissions: ['pipelines:write'],
    stepUp: true,
    routes: ['pipeline POST /pipelines/:id/restore', 'pipeline POST /pipelines/:id/purge'],
  },
  {
    control: 'Run / cancel a pipeline execution',
    file: 'pages/dashboard/pipelines/[id].tsx',
    permissions: ['pipelines:write'],
    routes: [
      'pipeline POST /pipelines/:pipelineId/executions',
      'pipeline POST /pipelines/:pipelineId/executions/:executionId/stop',
    ],
  },
  {
    control: 'Pipeline list + detail reads',
    file: 'src/lib/nav.ts',
    permissions: ['pipelines:read'],
    routes: ['pipeline GET /pipelines', 'pipeline GET /pipelines/:id'],
    via: 'nav',
  },
  {
    control: 'Template gallery reads',
    file: 'src/lib/nav.ts',
    permissions: ['templates:read'],
    routes: ['pipeline GET /pipeline-templates', 'pipeline GET /pipeline-templates/:id'],
    via: 'nav',
  },
  {
    control: 'Author / edit / delete a pipeline template',
    file: 'pages/dashboard/templates.tsx',
    permissions: ['templates:write'],
    routes: [
      'pipeline POST /pipeline-templates',
      'pipeline PUT /pipeline-templates/:id',
      'pipeline DELETE /pipeline-templates/:id',
    ],
  },
  {
    control: 'Upload / edit / delete a plugin',
    file: 'pages/dashboard/plugins.tsx',
    permissions: ['plugins:write'],
    routes: ['plugin POST /plugins', 'plugin PUT /plugins/:id', 'plugin DELETE /plugins/:id'],
  },
  {
    control: 'Plugin list + detail reads',
    file: 'src/lib/nav.ts',
    permissions: ['plugins:read'],
    routes: ['plugin GET /plugins', 'plugin GET /plugins/:id'],
    via: 'nav',
  },
  {
    control: 'Send / delete a message',
    file: 'pages/dashboard/messages.tsx',
    permissions: ['messages:write'],
    routes: ['message POST /messages', 'message DELETE /messages/:id'],
  },
  {
    control: 'Message reads',
    file: 'src/lib/nav.ts',
    permissions: ['messages:read'],
    routes: ['message GET /messages', 'message GET /messages/:id'],
    via: 'nav',
  },
  {
    control: 'Review a compliance exemption',
    file: 'pages/dashboard/inbox.tsx',
    permissions: ['compliance:write'],
    routes: ['compliance PUT /compliance/exemptions/:id/review', 'compliance DELETE /compliance/exemptions/:id'],
  },
  {
    control: 'Author / delete a compliance rule or policy',
    file: 'pages/dashboard/compliance.tsx',
    permissions: ['compliance:write'],
    routes: [
      'compliance POST /compliance/rules',
      'compliance DELETE /compliance/rules/:id',
      'compliance POST /compliance/policies',
      'compliance DELETE /compliance/policies/:id',
    ],
  },
  {
    control: 'Compliance reads (rules, policies, scans)',
    file: 'src/lib/nav.ts',
    permissions: ['compliance:read'],
    routes: ['compliance GET /compliance/rules', 'compliance GET /compliance/policies', 'compliance GET /compliance/scans'],
    via: 'nav',
  },
  {
    control: 'Change / cancel the subscription',
    file: 'pages/dashboard/billing.tsx',
    permissions: ['billing:manage'],
    // Cancelling is step-up gated; the resume path is global (see the
    // "step-up refusals are resumable app-wide" test).
    stepUp: true,
    routes: [
      'billing POST /billing/subscriptions',
      'billing PUT /billing/subscriptions/:id',
      'billing POST /billing/subscriptions/:id/cancel',
    ],
  },
  {
    control: 'Add / remove a billing add-on',
    file: 'pages/dashboard/quotas.tsx',
    permissions: ['billing:manage'],
    routes: [
      'billing POST /billing/subscriptions/:id/addons',
      'billing DELETE /billing/subscriptions/:id/addons/:bundleId',
    ],
  },
  {
    control: 'Quota usage reads',
    file: 'src/lib/nav.ts',
    permissions: ['quotas:read'],
    routes: ['quota GET /quotas', 'quota GET /quotas/:orgId'],
    via: 'nav',
  },
  {
    control: 'Report reads',
    file: 'src/lib/nav.ts',
    permissions: ['reports:read'],
    // The DORA reads under /reports/execution/* additionally require the
    // `advanced_reporting` entitlement, so they get their own row below.
    // `/reports/retention` is the effective date-range cap the Reports page reads
    // — deliberately reports:read ONLY (the Retention Pack is sold to every tier).
    routes: ['reporting GET /reports/execution/list', 'reporting GET /reports/retention'],
    via: 'nav',
  },
  {
    control: 'Create / edit a custom dashboard',
    file: 'pages/dashboard/observability/new.tsx',
    permissions: ['dashboards:write'],
    routes: ['platform POST /dashboards', 'platform POST /dashboards/:id/clone'],
  },
  {
    control: 'Create / edit / delete an alert rule',
    file: 'pages/dashboard/observability/alert-rules.tsx',
    permissions: ['observability:write'],
    routes: [
      'platform POST /observability/alert-rules',
      'platform PUT /observability/alert-rules/:id',
      'platform DELETE /observability/alert-rules/:id',
    ],
  },
  {
    control: 'Create / edit / delete an alert destination',
    file: 'pages/dashboard/observability/alert-destinations.tsx',
    permissions: ['observability:write'],
    routes: [
      'platform POST /observability/alert-destinations',
      'platform PUT /observability/alert-destinations/:id',
      'platform DELETE /observability/alert-destinations/:id',
    ],
  },
  {
    control: 'Change a member\'s role / remove a member',
    file: 'pages/dashboard/members.tsx',
    permissions: ['members:manage'],
    routes: [
      'platform POST /organization/:id/members',
      'platform DELETE /organization/:id/members/:userId',
      'platform PATCH /organization/:id/members/:userId/deactivate',
    ],
  },
  {
    control: 'Create / edit / delete a Role',
    file: 'pages/dashboard/roles.tsx',
    permissions: ['roles:manage'],
    routes: [
      'platform POST /organization/:id/roles',
      'platform PUT /organization/:id/roles/:roleId',
      'platform DELETE /organization/:id/roles/:roleId',
    ],
  },
  {
    control: 'Add / edit / delete an IdP group → role mapping',
    file: 'pages/dashboard/settings/sso.tsx',
    permissions: ['roles:manage'],
    routes: [
      'platform POST /organization/:id/idp/group-mappings',
      'platform PUT /organization/:id/idp/group-mappings/:mappingId',
      'platform DELETE /organization/:id/idp/group-mappings/:mappingId',
    ],
  },
  {
    control: 'Issue / revoke a SCIM provisioning key',
    file: 'pages/dashboard/settings/sso.tsx',
    gateFiles: ['src/components/settings/ScimProvisioning.tsx'],
    permissions: ['service_accounts:manage'],
    stepUp: true,
    // The SCIM endpoints themselves are driven by the identity provider, never
    // by the dashboard — what the UI drives is the service-account key mint that
    // produces the credential, so those are the routes to compare against.
    routes: [
      'platform POST /organization/:id/service-accounts',
      'platform POST /organization/:id/service-accounts/:accountId/keys',
      'platform DELETE /organization/:id/service-accounts/:accountId/keys/:keyId',
    ],
  },
  {
    control: 'Send / revoke an invitation',
    file: 'pages/dashboard/invitations.tsx',
    permissions: ['invitations:manage'],
    routes: [
      'platform POST /invitation/send',
      'platform DELETE /invitation/:invitationId',
      'platform POST /invitation/:invitationId/resend',
    ],
  },
  {
    control: 'Edit organization identity / AI settings',
    file: 'pages/dashboard/settings.tsx',
    permissions: ['org:settings'],
    routes: ['platform PATCH /organization/:id/identity', 'platform POST /organization/:id/domains'],
  },
  {
    control: 'Edit the impersonation policy',
    file: 'pages/dashboard/settings.tsx',
    gateFiles: ['src/components/settings/ImpersonationPolicySettings.tsx'],
    permissions: ['org:impersonation'],
    stepUp: true,
    routes: ['platform PATCH /organization/:id/impersonation-policy'],
  },
  {
    control: 'Connect / edit / disconnect the org\'s own SSO (OIDC or SAML)',
    file: 'pages/dashboard/settings/sso.tsx',
    gateFiles: [
      'src/components/settings/OrgSsoSettings.tsx',
      'src/components/settings/OrgSamlSettings.tsx',
      'src/components/settings/SsoDisconnect.tsx',
    ],
    // The page's read gate IS `org:idp` (nav → page-access), and every control
    // here lives on that page.
    permissions: [],
    pagePermissions: ['org:idp'],
    page: '/dashboard/settings/sso',
    // Enforced inside the handlers (`requireOwnOrgSso`), not the route table —
    // the page renders the `sso` FeatureLock in place of the editors.
    features: ['sso'],
    stepUp: true,
    minAssurance: 2,
    routes: [
      'platform PUT /organization/:id/idp',
      'platform PATCH /organization/:id/idp',
      'platform DELETE /organization/:id/idp',
    ],
  },
  {
    control: 'View / edit / enable-disable / delete a service account',
    file: 'pages/dashboard/security.tsx',
    gateFiles: [
      'src/components/settings/ServiceAccountsSection.tsx',
      'src/components/settings/ServiceAccountDrawer.tsx',
    ],
    permissions: ['service_accounts:manage'],
    stepUp: true,
    routes: [
      'platform GET /organization/:id/service-accounts/:accountId',
      'platform PATCH /organization/:id/service-accounts/:accountId',
      'platform DELETE /organization/:id/service-accounts/:accountId',
    ],
  },
  {
    control: 'Edit an org\'s name / slug / description (sysadmin drill-down)',
    file: 'src/components/admin/org-detail/OrgIdentityCard.tsx',
    // Sysadmin-only route (`systemAdmin` in the table) on a sysadmin-only page
    // (`/dashboard/admin/orgs/[orgId]` is `systemAdminOnly` in page-access).
    permissions: [],
    stepUp: true,
    routes: ['platform PUT /organization/:id'],
  },
  // ── Entitlement-gated controls ─────────────────────────────────────────────
  // Every route below carries a `requireFeature(...)` gate, so the control has to
  // render a lock (not hide, and not 403 on click). `features` here must cover
  // exactly what the routes enforce.
  {
    control: 'Ask assistant (AI Q&A launcher)',
    file: 'src/components/ui/DashboardLayout.tsx',
    permissions: [],
    implicitPermissions: [{
      permission: 'pipelines:read',
      why: 'The launcher is dashboard chrome, not a page. The ask service accepts ANY of '
        + 'pipelines/plugins/templates:read and all three sit in the member bundle, so every role '
        + 'that can open the dashboard already satisfies it — there is nothing to pre-check.',
    }],
    features: ['ai_generation'],
    routes: ['ask POST /ask/agent/stream', 'ask GET /ask/providers'],
  },
  {
    control: 'Generate a pipeline with AI (Git URL / prompt tabs)',
    file: 'pages/dashboard/pipelines.tsx',
    gateFiles: ['src/components/pipeline/CreatePipelineModal.tsx'],
    permissions: ['pipelines:write'],
    pagePermissions: ['pipelines:read'],
    page: '/dashboard/pipelines',
    features: ['ai_generation'],
    routes: [
      'pipeline POST /pipelines/generate',
      'pipeline POST /pipelines/generate/stream',
      'pipeline POST /pipelines/generate/from-url',
      'pipeline POST /pipelines/generate/from-url/stream',
      'pipeline GET /pipelines/providers',
    ],
  },
  {
    control: 'Generate a plugin with AI (AI Builder tab)',
    file: 'pages/dashboard/plugins.tsx',
    gateFiles: ['src/components/plugin/CreatePluginModal.tsx'],
    permissions: ['plugins:write'],
    pagePermissions: ['plugins:read'],
    page: '/dashboard/plugins',
    features: ['ai_generation'],
    routes: ['plugin POST /plugins/generate', 'plugin POST /plugins/generate/stream', 'plugin GET /plugins/providers'],
  },
  {
    control: 'Bulk create / update / delete pipelines',
    file: 'pages/dashboard/pipelines.tsx',
    permissions: ['pipelines:write'],
    features: ['bulk_operations'],
    routes: ['pipeline POST /pipelines/bulk/create', 'pipeline PUT /pipelines/bulk/update', 'pipeline POST /pipelines/bulk/delete'],
  },
  {
    control: 'Bulk update / delete plugins',
    file: 'pages/dashboard/plugins.tsx',
    permissions: ['plugins:write', 'plugins:publish'],
    features: ['bulk_operations'],
    routes: ['plugin PUT /plugins/bulk/update', 'plugin POST /plugins/bulk/delete'],
  },
  {
    control: 'DORA metrics (report, trend, environment filter)',
    file: 'pages/dashboard/reports.tsx',
    gateFiles: ['src/components/reports/tabs/DoraTab.tsx'],
    permissions: [],
    pagePermissions: ['reports:read'],
    page: '/dashboard/reports',
    features: ['advanced_reporting'],
    routes: [
      'reporting GET /reports/execution/dora',
      'reporting GET /reports/execution/dora/trend',
      'reporting GET /reports/execution/environments',
    ],
  },
  {
    control: 'Mark a deployment outcome (DORA change-failure rate)',
    file: 'pages/dashboard/reports.tsx',
    gateFiles: ['src/components/reports/tabs/DoraTab.tsx'],
    // Checked with `hasPermission` rather than `can()` so a read-only
    // impersonation session still SEES the control, disabled with the reason.
    permissions: ['pipelines:write'],
    via: 'has',
    features: ['advanced_reporting'],
    routes: ['reporting POST /reports/deployments/:executionId/outcome'],
  },
  {
    control: 'Per-pipeline maturity scorecard',
    file: 'src/components/pipeline/ScorecardCard.tsx',
    permissions: [],
    pagePermissions: ['pipelines:read'],
    page: '/dashboard/pipelines/[id]',
    features: ['advanced_reporting'],
    routes: ['pipeline GET /pipelines/:id/scorecard'],
  },
  {
    control: 'Org-wide maturity scorecard (Reports → Scorecard tab)',
    file: 'pages/dashboard/reports.tsx',
    gateFiles: ['src/components/reports/tabs/ScorecardTab.tsx'],
    // The Reports page gates on `reports:read`, but this roll-up is served by the
    // PIPELINE service on `pipelines:read` — so the tab checks that itself.
    permissions: ['pipelines:read'],
    features: ['advanced_reporting'],
    routes: ['pipeline GET /pipelines/scorecard'],
  },
  {
    control: 'Incident reporting settings + wiring test',
    file: 'pages/dashboard/settings/incident-reporting.tsx',
    gateFiles: ['src/components/settings/IncidentReportingSettings.tsx'],
    permissions: [],
    // Admin-only page; `org:settings` rides the admin bundle, which the page gate
    // (`adminOnly`) already requires.
    pagePermissions: ['reports:read', 'org:settings'],
    page: '/dashboard/settings/incident-reporting',
    features: ['advanced_reporting'],
    routes: [
      'reporting GET /reports/settings/incidents',
      'reporting PUT /reports/settings/incidents',
      'reporting GET /reports/incidents',
      'reporting POST /reports/incidents/test',
    ],
  },
  {
    control: 'Per-team usage breakdown',
    file: 'src/components/billing/TeamUsageCard.tsx',
    permissions: [],
    pagePermissions: ['billing:read'],
    page: '/dashboard/billing',
    features: ['team_usage_analytics'],
    routes: ['billing GET /billing/summary/usage-by-team'],
  },
];

/**
 * Routes that enforce a gate beyond plain permissions but are NOT driven by a
 * mapped dashboard control, each with the reason.
 *
 * This is the half that keeps the mapping honest. Every route carrying
 * `features`, `stepUp`, `scopes` or `minAssurance` must be either mapped above
 * or listed here — so adding a `requireFeature(...)` (or a step-up) to a route
 * fails this suite by name until someone decides whether the UI needs a lock.
 * Entries are exact: a new sibling route does not inherit its neighbour's reason.
 */
const GATED_ROUTES_WITHOUT_A_CONTROL: Record<string, string> = {
  // ── Machine credentials: no user session ever reaches these ───────────────
  ...Object.fromEntries([
    'GET /scim/v2/Users', 'POST /scim/v2/Users', 'GET /scim/v2/Users/:id', 'PUT /scim/v2/Users/:id',
    'PATCH /scim/v2/Users/:id', 'DELETE /scim/v2/Users/:id',
    'GET /scim/v2/Groups', 'POST /scim/v2/Groups', 'GET /scim/v2/Groups/:id', 'PUT /scim/v2/Groups/:id',
    'PATCH /scim/v2/Groups/:id', 'DELETE /scim/v2/Groups/:id',
    'GET /scim/v2/Schemas', 'GET /scim/v2/ResourceTypes', 'GET /scim/v2/ServiceProviderConfig',
  ].map((r) => [`platform ${r}`, 'SCIM 2.0 — called by the customer\'s IdP with a `scim`-scoped service-account key. The dashboard mints the key (mapped above) but never calls SCIM.'])),
  ...Object.fromEntries([
    'POST /reports/events', 'POST /reports/incidents', 'POST /reports/incidents/alertmanager', 'POST /reports/ingest-health',
  ].map((r) => [`reporting ${r}`, 'Ingest endpoint — called by CI / Alertmanager with a `reporting:ingest`-scoped token, never by a browser session.'])),

  // ── Ask service: the non-agent answer endpoints are API/CLI surfaces ──────
  // The dashboard's Ask launcher drives only /ask/agent/stream (mapped above).
  'ask POST /ask': 'Non-streaming grounded answer for API / CLI callers; the dashboard Ask panel only drives /ask/agent/stream.',
  'ask POST /ask/stream': 'Tool-less streaming answer for API / CLI callers; the dashboard Ask panel only drives /ask/agent/stream.',

  // ── Soft-delete restore / purge (step-up), driven by RecentlyDeletedPanel ──
  // The pipelines pair IS mapped above; the rest are the same panel on their own
  // page, gated by that page's `:write` permission plus the global step-up resume.
  'pipeline POST /pipeline-templates/:id/restore': 'Recently-deleted panel on the Templates page (templates:write) + global step-up resume.',
  'pipeline POST /pipeline-templates/:id/purge': 'Recently-deleted panel on the Templates page (templates:write) + global step-up resume.',
  'plugin POST /plugins/:id/restore': 'Recently-deleted panel on the Plugins page (plugins:write) + global step-up resume.',
  'plugin POST /plugins/:id/purge': 'Recently-deleted panel on the Plugins page (plugins:write) + global step-up resume.',
  'compliance POST /compliance/rules/:id/restore': 'Recently-deleted panel on the Compliance page (compliance:write) + global step-up resume.',
  'compliance POST /compliance/rules/:id/purge': 'Recently-deleted panel on the Compliance page (compliance:write) + global step-up resume.',
  'compliance POST /compliance/policies/:id/restore': 'Recently-deleted panel on the Compliance page (compliance:write) + global step-up resume.',
  'compliance POST /compliance/policies/:id/purge': 'Recently-deleted panel on the Compliance page (compliance:write) + global step-up resume.',
  'message POST /messages/:id/restore': 'Recently-deleted panel on the Messages page (messages:write) + global step-up resume.',
  'message POST /messages/:id/purge': 'Recently-deleted panel on the Messages page (messages:write) + global step-up resume.',
  'platform POST /dashboards/:id/restore': 'Recently-deleted panel on the Observability pages (dashboards:write) + global step-up resume.',
  'platform POST /dashboards/:id/purge': 'Recently-deleted panel on the Observability pages (dashboards:write) + global step-up resume.',
  'platform POST /observability/alert-rules/:id/restore': 'Recently-deleted panel on the alert-rules page (observability:write) + global step-up resume.',
  'platform POST /observability/alert-rules/:id/purge': 'Recently-deleted panel on the alert-rules page (observability:write) + global step-up resume.',
  'platform POST /observability/alert-destinations/:id/restore': 'Recently-deleted panel on the alert-destinations page (observability:write) + global step-up resume.',
  'platform POST /observability/alert-destinations/:id/purge': 'Recently-deleted panel on the alert-destinations page (observability:write) + global step-up resume.',
  'platform POST /organization/:id/restore': 'Sysadmin organizations page — restore a soft-deleted org; step-up only.',

  // ── Own-account security (step-up), Settings → profile sections ───────────
  'platform POST /user/change-password': 'Profile → password section; step-up only (the user is acting on their own account).',
  'platform DELETE /user/account': 'Profile → delete account; step-up only.',
  'platform POST /user/keys': 'Profile → access keys; step-up only.',
  'platform DELETE /user/sessions/:id': 'Profile → sessions section; step-up only.',
  'platform POST /user/tokens/revoke-all': 'Profile → revoke all tokens; step-up only.',
  'platform POST /auth/totp/enrol': 'Profile → TOTP section; step-up only.',
  'platform DELETE /auth/totp': 'Profile → TOTP section; step-up only.',
  'platform POST /auth/totp/recovery-codes': 'Profile → TOTP recovery codes; step-up only.',
  'platform POST /auth/webauthn/register/options': 'Profile → passkey section; step-up only.',
  'platform DELETE /auth/webauthn/credentials/:id': 'Profile → passkey section; step-up only.',
  'platform POST /auth/device/approve': 'CLI device-approval page; step-up only (the approval IS the authorization).',

  // ── Org administration (step-up), gated by permissions already mapped ─────
  'platform DELETE /organization/:id': 'Sysadmin org drill-down / All Organizations — soft-delete an org; systemAdmin + step-up.',
  'platform PATCH /organization/:id/transfer-owner': 'Org settings — transfer ownership; owner-gated + step-up.',
  'platform PATCH /organization/:id/mfa-policy': 'Org settings → MFA policy section; `org:settings` + step-up.',
  'platform PUT /organization/ai-config': 'Org settings → AI provider config; `org:settings` + step-up.',

  // ── Sysadmin-only surfaces (systemAdmin + step-up, some strong-factor) ────
  'platform POST /admin/impersonate/:userId': 'Sysadmin impersonation start; systemAdmin + consent + step-up with a strong factor.',
  'platform POST /admin/impersonate/:userId/breakglass': 'Sysadmin break-glass impersonation; systemAdmin + step-up with a strong factor.',
  'platform POST /admin/impersonate/requests/:id/redeem': 'Sysadmin redeems an approved access request; systemAdmin + step-up with a strong factor.',
  'platform PUT /admin/org-idp/:orgId': 'Sysadmin IdP admin page; systemAdmin + step-up with a strong factor.',
  'platform PATCH /admin/org-idp/:orgId': 'Sysadmin IdP admin page; systemAdmin + step-up with a strong factor.',
  'platform DELETE /admin/org-idp/:orgId': 'Sysadmin IdP admin page; systemAdmin + step-up with a strong factor.',
  'platform PUT /admin/orgs/:orgId/kms-config': 'Sysadmin per-org KMS modal; systemAdmin + step-up with a strong factor.',
  'platform DELETE /admin/orgs/:orgId/kms-config': 'Sysadmin per-org KMS modal; systemAdmin + step-up with a strong factor.',
  'platform POST /admin/users/:id/grants': 'Sysadmin superadmin-grant editor; systemAdmin + step-up with a strong factor.',
  'platform DELETE /admin/users/:id/grants': 'Sysadmin superadmin-grant editor; systemAdmin + step-up with a strong factor.',
  'platform GET /admin/orgs/:orgId/k8s-namespace.yaml': 'Sysadmin org drill-down — namespace manifest download; systemAdmin + step-up.',
  'platform PUT /users/:id': 'Sysadmin users page — edit a user; systemAdmin + step-up.',
  'platform DELETE /users/:id': 'Sysadmin users page — delete a user; systemAdmin + step-up.',
  'platform POST /users/bulk-delete': 'Sysadmin users page — bulk delete; systemAdmin + step-up.',
  'platform PUT /users/:id/features': 'Sysadmin per-user feature-override editor; systemAdmin + step-up.',
  'platform PATCH /organization/:id/tier': 'Sysadmin change-tier dialog; systemAdmin + step-up.',
  'quota DELETE /quotas/:orgId': 'Sysadmin quota admin — delete an org\'s quota row; systemAdmin + step-up.',
  'quota POST /quotas/:orgId/reset': 'Sysadmin quota admin — reset a period; systemAdmin + step-up.',
  'billing PUT /billing/admin/subscriptions/:id': 'Billing-admin page — fleet-wide subscription edit; systemAdmin + step-up.',
};

/** Every route that enforces something beyond plain permissions / systemAdmin. */
function gatedRoutes(): string[] {
  return Object.entries(tables)
    .flatMap(([service, table]) => table
      .filter((e) => e.features.length > 0 || e.stepUp || e.scopes.length > 0 || e.minAssurance > 0)
      .map((e) => `${service} ${e.method} ${e.path}`))
    .sort();
}

/** Resolve `<service> <METHOD> <path>` against the generated tables. */
function lookup(route: string): { service: string; entry: RouteTableEntry | undefined } {
  const [service, method, ...rest] = route.split(' ');
  const path = rest.join(' ');
  return { service, entry: tables[service]?.find((e) => e.method === method && e.path === path) };
}

/** Whether holding `held` satisfies every permission gate on the route. */
function satisfies(entry: RouteTableEntry, held: string[]): boolean {
  return entry.permissions.every((gate) => (gate.mode === 'all'
    ? gate.permissions.every((p) => held.includes(p))
    : gate.permissions.some((p) => held.includes(p))));
}

/** Everything a holder of this control's declared gates would have. */
function heldBy(control: Control): string[] {
  return [
    ...control.permissions,
    ...(control.pagePermissions ?? []),
    ...(control.implicitPermissions ?? []).map((p) => p.permission),
  ];
}

/** Read a control's own source plus any `gateFiles` it delegates part of the gate to. */
function gateSources(control: Control): string {
  return [control.file, ...(control.gateFiles ?? [])]
    .map((f) => readFileSync(resolve(FRONTEND_DIR, f), 'utf8'))
    .join('\n');
}

describe('generated route tables', () => {
  it('are published for every backend app', () => {
    // Each service's route-coverage test writes its own file; a missing one means
    // that suite never ran (or the service was renamed).
    expect(Object.keys(tables).sort()).toEqual([
      'ask', 'billing', 'compliance', 'image-registry', 'message',
      'pipeline', 'platform', 'plugin', 'quota', 'reporting',
    ]);
  });

  it('carry entries with resolved gate metadata', () => {
    for (const [service, table] of Object.entries(tables)) {
      expect(table.length).toBeGreaterThan(0);
      for (const entry of table) {
        expect(typeof entry.method).toBe('string');
        expect(entry.path.startsWith('/')).toBe(true);
        expect(Array.isArray(entry.permissions)).toBe(true);
        expect(Array.isArray(entry.internalCallers)).toBe(true);
        expect(service).not.toBe('');
      }
    }
  });

  it('never routes a UI control at an INTERNAL route', () => {
    // An internal route (#14) refuses every user token, so a `can(...)`-gated
    // control that called one could only ever 403 — and the fact that it would
    // is exactly the kind of thing this file exists to catch before a user does.
    const internal = new Set(
      Object.entries(tables).flatMap(([service, table]) =>
        table.filter((e) => e.internalCallers.length > 0).map((e) => `${service} ${e.method} ${e.path}`)),
    );
    expect([...internal].filter((r) => CONTROLS.some((c) => c.routes.includes(r)))).toEqual([]);
    // And the set is not vacuously empty — the tables really do carry them.
    expect(internal.size).toBeGreaterThan(0);
  });
});

describe('UI gates match the routes they call', () => {
  it.each(CONTROLS.map((c) => [c.control, c] as const))('%s', (_name, control) => {
    const source = readFileSync(resolve(FRONTEND_DIR, control.file), 'utf8');
    for (const permission of control.permissions) {
      // The UI must really check this permission (catches a rename on either side).
      expect(source).toContain(
        control.via === 'nav' ? `requiredPermission: '${permission}'`
          : control.via === 'has' ? `hasPermission(user, '${permission}')`
            : `can('${permission}')`,
      );
    }
    // Permissions the control leans on the PAGE gate for: verified against the
    // real resolver, not a grep, so renaming the nav entry fails here.
    if (control.pagePermissions?.length) {
      if (!control.page) throw new Error(`${control.control}: pagePermissions needs a \`page\``);
      const gate = resolvePageGate(control.page);
      for (const permission of control.pagePermissions) {
        // An admin-gated page grants every org-assignable permission, so an
        // `adminOnly` gate covers any of them.
        const covered = gate.permission === permission || !!gate.adminOnly || !!gate.systemAdminOnly;
        expect({ page: control.page, permission, covered, gate }).toEqual({ page: control.page, permission, covered: true, gate });
      }
    }
    // Every implicit permission must carry its justification.
    for (const implicit of control.implicitPermissions ?? []) {
      expect(implicit.why.length).toBeGreaterThan(40);
    }

    const held = heldBy(control);
    const declaredFeatures = control.features ?? [];
    const sources = gateSources(control);

    for (const route of control.routes) {
      const { service, entry } = lookup(route);
      expect(tables[service]).toBeDefined();
      if (!entry) throw new Error(`${route} is not in the ${service} route table — the control calls a route that no longer exists`);

      // 1. PERMISSIONS — holding what the control declares must satisfy every gate.
      expect({ route, gates: entry.permissions, satisfied: satisfies(entry, held) })
        .toEqual({ route, gates: entry.permissions, satisfied: true });

      // 2. The route must be gated at ALL — an ungated write behind a UI gate is
      // the mismatch this whole mechanism exists to prevent.
      expect(entry.permissions.length + (entry.systemAdmin ? 1 : 0) + entry.features.length + entry.scopes.length)
        .toBeGreaterThan(0);

      // 3. FEATURES — every entitlement the route enforces must be declared here,
      // or a non-entitled customer meets it as a 403 on click.
      const undeclared = entry.features.filter((f) => !declaredFeatures.includes(f as FeatureFlag));
      expect({ route, undeclaredFeatures: undeclared }).toEqual({ route, undeclaredFeatures: [] });

      // 4. SCOPES — a scoped route wants a machine credential, so no user-session
      // control may drive one (same reasoning as the INTERNAL-route test).
      expect({ route, scopes: entry.scopes }).toEqual({ route, scopes: [] });
    }

    // 5. STEP-UP / ASSURANCE — declared exactly, so the row records what the
    // click really costs the user (and a newly added step-up fails here).
    const entries = control.routes.map((r) => lookup(r).entry).filter((e): e is RouteTableEntry => !!e);
    expect({ control: control.control, stepUp: !!control.stepUp })
      .toEqual({ control: control.control, stepUp: entries.some((e) => e.stepUp) });
    expect({ control: control.control, minAssurance: control.minAssurance ?? 0 })
      .toEqual({ control: control.control, minAssurance: Math.max(0, ...entries.map((e) => e.minAssurance)) });

    // Each declared feature must (a) be one the API really enforces, and (b) be
    // rendered somewhere in this control's sources — a declared-but-absent lock
    // is the "hidden control" failure mode in a different costume.
    for (const flag of declaredFeatures) {
      expect({ flag, enforcement: FEATURE_GATES[flag].enforcement })
        .not.toEqual({ flag, enforcement: 'entitlement-only' });
      expect({ flag, renderedIn: sources.includes(flag) }).toEqual({ flag, renderedIn: true });
    }
  });

  it('maps at least one control per service that the dashboard writes to', () => {
    const mapped = new Set(CONTROLS.flatMap((c) => c.routes.map((r) => r.split(' ')[0])));
    for (const service of ['pipeline', 'plugin', 'message', 'compliance', 'billing', 'quota', 'reporting', 'platform']) {
      expect([...mapped]).toContain(service);
    }
  });
});

describe('no gated route lands unmapped', () => {
  const mapped = new Set(CONTROLS.flatMap((c) => c.routes));

  it('every feature / step-up / scope / assurance route is mapped or registered', () => {
    const unaccounted = gatedRoutes().filter((r) => !mapped.has(r) && !(r in GATED_ROUTES_WITHOUT_A_CONTROL));
    expect({
      unaccounted,
      fix: 'This route gained a feature/step-up/scope/assurance gate. Either map it to the UI control that '
        + 'calls it in CONTROLS (and give that control the matching lock), or add it to '
        + 'GATED_ROUTES_WITHOUT_A_CONTROL with the reason no dashboard control drives it.',
    }).toEqual({ unaccounted: [], fix: expect.any(String) });
  });

  it('the registry carries no stale or duplicated entries', () => {
    const gated = new Set(gatedRoutes());
    const stale = Object.keys(GATED_ROUTES_WITHOUT_A_CONTROL).filter((r) => !gated.has(r));
    const alsoMapped = Object.keys(GATED_ROUTES_WITHOUT_A_CONTROL).filter((r) => mapped.has(r));
    expect({ stale, alsoMapped }).toEqual({ stale: [], alsoMapped: [] });
  });

  it('every registry entry states a real reason', () => {
    for (const [route, reason] of Object.entries(GATED_ROUTES_WITHOUT_A_CONTROL)) {
      expect({ route, ok: reason.trim().length > 30 }).toEqual({ route, ok: true });
    }
  });

  it('is not vacuous — the tables really do carry these gates', () => {
    expect(gatedRoutes().length).toBeGreaterThan(50);
  });
});

describe('feature entitlements are gated where — and only where — the API gates them', () => {
  /** flag → routes that enforce it, from the generated tables. */
  const routesByFeature = new Map<string, string[]>();
  for (const [service, table] of Object.entries(tables)) {
    for (const entry of table) {
      for (const flag of entry.features) {
        routesByFeature.set(flag, [...(routesByFeature.get(flag) ?? []), `${service} ${entry.method} ${entry.path}`]);
      }
    }
  }

  it('classifies every catalog flag', () => {
    expect(Object.keys(FEATURE_GATES).sort()).toEqual([...ALL_FEATURE_FLAGS].sort());
  });

  it('a route-enforced flag is classified `route` and has a UI control', () => {
    const controlsByFeature = new Set(CONTROLS.flatMap((c) => c.features ?? []));
    for (const [flag, routes] of routesByFeature) {
      expect({ flag, enforcement: FEATURE_GATES[flag as FeatureFlag]?.enforcement })
        .toEqual({ flag, enforcement: 'route' });
      expect({ flag, routes, hasControl: controlsByFeature.has(flag as FeatureFlag) })
        .toEqual({ flag, routes, hasControl: true });
    }
  });

  it('an `entitlement-only` flag gates no route — and therefore nothing in the UI', () => {
    // The other direction of the same honesty rule: locking a control the API
    // serves happily would take capability away from an org that has it.
    for (const flag of ALL_FEATURE_FLAGS) {
      const spec = FEATURE_GATES[flag];
      if (spec.enforcement !== 'entitlement-only') continue;
      expect({ flag, routes: routesByFeature.get(flag) ?? [] }).toEqual({ flag, routes: [] });
      expect({ flag, controls: spec.controls }).toEqual({ flag, controls: [] });
      expect({ flag, hasNote: !!spec.note }).toEqual({ flag, hasNote: true });
    }
  });

  it('every declared gate source really mentions its flag', () => {
    for (const flag of ALL_FEATURE_FLAGS) {
      for (const file of FEATURE_GATES[flag].controls) {
        const source = readFileSync(resolve(FRONTEND_DIR, file), 'utf8');
        expect({ flag, file, mentioned: source.includes(flag) }).toEqual({ flag, file, mentioned: true });
      }
    }
  });
});

describe('step-up refusals are resumable app-wide', () => {
  // Every step-up route is covered by ONE mechanism rather than per-control
  // handling: the fetch core turns a step-up 401 into a `step-up-required`
  // event carrying a `retry`, and the dashboard shell prompts and replays it.
  // The registry above leans on this, so assert it exists.
  it('the fetch core emits a resumable step-up event', () => {
    const core = readFileSync(resolve(FRONTEND_DIR, 'src/lib/api/core.ts'), 'utf8');
    expect(core).toContain("'step-up-required'");
    expect(core).toContain('retry:');
  });

  it('the dashboard shell listens for it', () => {
    const layout = readFileSync(resolve(FRONTEND_DIR, 'src/components/ui/DashboardLayout.tsx'), 'utf8');
    expect(layout).toContain('step-up-required');
    expect(layout).toContain('StepUpModal');
  });
});
