// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * UI gate ↔ API gate parity.
 *
 * Each service's route-coverage test writes its resolved route table to
 * `src/generated/route-table/<service>.json` (see docs/permissions.md →
 * "Route coverage"). A table entry records EVERY gate the route's MIDDLEWARE
 * runs: `permissions`, `systemAdmin`, `features` (paid entitlements), `stepUp`
 * (recent re-authentication), `scopes` (machine-credential scopes),
 * `minAssurance` (authenticator strength) and `orgAdminAssurance` (the org's
 * "administrative actions require MFA" policy applies).
 *
 * This suite maps every gated control in the dashboard to the route(s) it calls
 * and asserts, for EACH of those dimensions:
 *
 *   1. the control REALLY DISAPPEARS for a viewer without the gate — each row is
 *      rendered twice, holding and not holding the permission (see
 *      "Behavioural control coverage" below), and
 *   2. holding what the control declares SATISFIES what the route enforces — so
 *      a button can never be shown to someone the API will reject, and a gate
 *      rename or a new gate on either side fails here.
 *
 * Controls are mapped explicitly (there is no way to infer which fetch a button
 * makes). `ROUTE_DISPOSITIONS` closes the other half: EVERY write route in
 * every service must be either mapped to a control here or given a disposition
 * there — a named category plus a reason naming the caller — so a new write
 * route cannot land unmapped. The test fails naming the route.
 *
 * ── Behavioural control coverage ──────────────────────────────────────────
 * The "does this control exist" half is not `expect(source).toContain(
 * "can('x')")` — that is text in a file, not behaviour, and passes on a
 * `can('x')` left in a comment after the JSX around it was deleted. Every row
 * carries a `behaviour` block instead, and the check renders the owning page
 * (or, where a page cannot reach the control, the smallest component that owns
 * it — those rows say so in `renders`) with and without the permission.
 *
 * NOT covered on purpose: `:publish` controls (`can('pipelines:publish')` etc.).
 * Publishing is not a separate route — `resolveVisibility` checks the permission
 * inside the write handler — so there is no route requirement to compare against.
 */
import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement, type ComponentType, type ReactElement } from 'react';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import { mockAuthGuard, mockOrgHierarchy, type PageAuthGuard } from './helpers/pageMocks';
import { resolvePageGate } from '../src/lib/page-access';
import { FEATURE_GATES } from '../src/lib/feature-gates';
import { ALL_FEATURE_FLAGS, type FeatureFlag } from '../src/lib/feature-flags';

// ── The page shell every dashboard page needs ──────────────────────────────
// Deliberately uniform, so a control's row supplies only the API payloads and
// auth-guard fields ITS surface needs and stays a few lines of data.
jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/hooks/useOrgHierarchy', () => require('./helpers/pageMocks').orgHierarchyModule());
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());
jest.mock('@/hooks/useAuth', () => ({
  __esModule: true,
  AuthProvider: ({ children }: { children: unknown }) => children,
  useAuth: () => (globalThis as unknown as { __pbAuth: unknown }).__pbAuth,
}));
jest.mock('@/hooks/useFeatures', () => ({
  __esModule: true,
  FeaturesProvider: ({ children }: { children: unknown }) => children,
  // Entitled by default. The FEATURE dimension is asserted separately below;
  // holding features ON here isolates the PERMISSION dimension, so a control
  // that vanished cannot be ambiguous between "no permission" and "no plan".
  useFeatures: () => ({
    isEnabled: () => (globalThis as unknown as { __pbEntitled: boolean }).__pbEntitled !== false,
    isLoaded: true, isSuperAdmin: false, features: [],
    supportAlias: 'support@pipeline.test', supportAliases: ['support@pipeline.test'],
    deployTarget: 'local', tierPresets: undefined,
  }),
}));
// Billing probes a module-level `/config` endpoint outside the API client; the
// Billing page renders "billing is not enabled" until it answers.
jest.mock('@/hooks/useBillingEnabled', () => ({
  __esModule: true,
  useBillingEnabled: () => true,
  useBillingProvider: () => 'stripe',
  useBillingEnabledState: () => true,
  subscribeBillingEnabled: () => () => {},
}));
jest.mock('next/head', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/ui/CommandPalette', () => ({ __esModule: true, CommandPalette: () => null }));
// Two shell children render nothing here but pull in module graphs React 19
// cannot mount under jest (an async module namespace, "async Client
// Component"). Neither carries a gated control, so stubbing them out leaves the
// shell's own chrome — including the Ask launcher — intact.
jest.mock('@/components/ui/ImpersonationBanner', () => ({ __esModule: true, ImpersonationBanner: () => null }));

// ── Leaf components this suite asserts NOTHING about ──────────────────────
// Every row's `find` targets a gate-bearing control, never one of these. They
// are stubbed so the suite renders the gate rather than the whole application:
// the pipeline form-builder graph alone is ~6,000 statements of editors and
// sections that no permission decision passes through. Keeping them out also
// keeps this file's own coverage footprint honest — it measures the surfaces it
// exercises, not every module a page happens to import.
jest.mock('@/components/pipeline/DeployedPipelinesPanel', () => ({ __esModule: true, DeployedPipelinesPanel: () => null }));
jest.mock('@/components/pipeline/PipelineContextCard', () => ({ __esModule: true, PipelineContextCard: () => null }));
jest.mock('@/components/observability/LogEntryRow', () => ({ __esModule: true, LogEntryRow: () => null }));
jest.mock('@/components/observability/LogVolumeChart', () => ({ __esModule: true, LogVolumeChart: () => null }));
jest.mock('@/components/admin/org-detail/OrgSeatsCard', () => ({ __esModule: true, OrgSeatsCard: () => null }));
jest.mock('@/components/admin/org-detail/OrgOperationsCard', () => ({ __esModule: true, OrgOperationsCard: () => null }));
jest.mock('@/components/admin/org-detail/OrgMemberRoster', () => ({ __esModule: true, OrgMemberRoster: () => null }));
jest.mock('@/components/users/SysadminGrantHistory', () => ({ __esModule: true, SysadminGrantHistory: () => null }));
jest.mock('@/components/users/EditUserModal', () => ({ __esModule: true, EditUserModal: () => null }));
jest.mock('@/components/billing/PlanGrid', () => ({ __esModule: true, PlanGrid: () => null }));
jest.mock('@/components/billing/PlanChangeModal', () => ({ __esModule: true, PlanChangeModal: () => null }));
jest.mock('@/components/ui/AuthErrorBanner', () => ({ __esModule: true, AuthErrorBanner: () => null }));

// The shell polls for the unread badge; a live interval keeps `act` busy forever.
jest.mock('@/lib/unread-count-store', () => ({
  ...(jest.requireActual<typeof import('@/lib/unread-count-store')>('@/lib/unread-count-store') as object),
  __esModule: true,
  useUnreadCount: () => ({ unreadCount: 0, hasLiveSource: false }),
  pollUnreadCount: () => () => {},
}));
// `next/dynamic` hands React a bare async function outside Next's build, which
// React 19 refuses ("async Client Component"). This is the same contract
// expressed with `lazy` + `Suspense`, which `settle()` can await.
jest.mock('next/dynamic', () => ({
  __esModule: true,
  default: (loader: () => Promise<unknown>, options?: { loading?: () => unknown }) => {
    const React = require('react') as typeof import('react');
    const Lazy = React.lazy(() => Promise.resolve(loader())
      .then((mod: unknown) => ({ default: (mod as { default?: unknown })?.default ?? mod })) as never);
    return (props: Record<string, unknown>) => React.createElement(
      React.Suspense,
      { fallback: options?.loading ? React.createElement(options.loading as never) : null },
      React.createElement(Lazy as never, props),
    );
  },
}));
// framer-motion keeps exiting content out of the DOM and trips React 19's
// async-component guard here; plain divs render the same tree.
jest.mock('framer-motion', () => {
  const React = require('react') as typeof import('react');
  return {
    __esModule: true,
    // Cached per tag: a fresh component identity on every property read would
    // remount the subtree on every render (and re-run its effects forever).
    motion: new Proxy({} as Record<string, unknown>, {
      get: (cache, tag: string) => (cache[tag] ??= ({ children, ...rest }: { children?: unknown }) =>
        React.createElement('div', rest as object, (children as never) ?? null)),
    }),
    AnimatePresence: ({ children }: { children?: unknown }) => children ?? null,
    useReducedMotion: () => false,
  };
});
jest.mock('next/router', () => require('./helpers/pageMocks').routerModule(() => (globalThis as unknown as { __pbRouter: unknown }).__pbRouter));
jest.mock('@/lib/api', () => {
  const g = globalThis as unknown as { __pbApi: Record<string, unknown> };
  const client = new Proxy({}, {
    get: (_t, prop) => {
      if (prop === '__esModule') return true;
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      const value = g.__pbApi[prop as string];
      // A method the surface consumes as a STREAM (`for await (… of api.x())`)
      // cannot be a resolved payload — it is supplied as the function itself.
      if (typeof value === 'function') return value as unknown;
      // A few client methods resolve the VALUE itself rather than an
      // `ApiResponse` envelope; those payloads are wrapped in `raw(...)`.
      if (value && typeof value === 'object' && '__pbRaw' in (value as object)) {
        return () => Promise.resolve((value as { __pbRaw: unknown }).__pbRaw);
      }
      return () => Promise.resolve({ success: true, data: value ?? {} });
    },
    has: () => true,
  });
  class MockApiError extends Error { statusCode = 404; }
  return {
    __esModule: true,
    default: client,
    api: client,
    ApiError: MockApiError,
    ConflictError: class extends MockApiError {},
    StepUpRequiredError: class extends MockApiError {},
  };
});

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
  /** Non-empty on an INTERNAL route: the services allowed to call it. No
   *  user token reaches such a route, so no UI control can ever drive one. */
  internalCallers: string[];
  stepUp: boolean;
  features: string[];
  scopes: string[];
  /** Minimum authenticator-assurance level (0 = none, 2 = strong factor). */
  minAssurance: number;
  /** Present when the org's "administrative actions require MFA" policy applies
   *  to the route (`requireOrgAdminAssurance`); absent otherwise. */
  orgAdminAssurance?: { machines: 'allow' | 'refuse' };
  audit: string[];
}

const TABLE_DIR = resolve(__dirname, '../src/generated/route-table');
const FRONTEND_DIR = resolve(__dirname, '..');

const tables: Record<string, RouteTableEntry[]> = Object.fromEntries(
  readdirSync(TABLE_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => [f.replace(/\.json$/, ''), JSON.parse(readFileSync(resolve(TABLE_DIR, f), 'utf8')) as RouteTableEntry[]]),
);

/** Every permission id the backend gates on, taken from the tables themselves
 *  so the set cannot drift from the catalog. */
const ALL_PERMISSIONS = [...new Set(
  Object.values(tables).flatMap((t) => t.flatMap((e) => e.permissions.flatMap((g) => g.permissions))),
)].sort();

// ── Behavioural harness ────────────────────────────────────────────────────

/** The viewer being rendered, handed to `mount` so a component row can pass the
 *  same authority down as a prop (the nav rows render the real `<Sidebar/>`,
 *  which reads `hasPermission(user, …)` off its `user` prop, not `can()`). */
interface MountCtx {
  user: { id: string; organizationId: string; role: string; email: string; permissions: string[] };
  can: (permission: string) => boolean;
}

/** Mount the page module's default export. */
const page = (mod: string) => (): ReactElement => createElement(require(mod).default as ComponentType);
/** Mount one named export with fixed props (for controls a page cannot reach). */
const comp = (mod: string, name: string, props: Record<string, unknown> = {}) =>
  (): ReactElement => createElement(require(mod)[name] as ComponentType, props);
/** Mount the UNMOCKED module — for the shell components this file itself mocks. */
const real = (mod: string, name: string, props: Record<string, unknown> = {}) =>
  (): ReactElement => createElement(jest.requireActual<Record<string, unknown>>(mod)[name] as ComponentType, props);

/** Find a control by role + accessible name; `null` when it is not rendered. */
const byRole = (role: string, name: RegExp) => (): HTMLElement | null =>
  screen.queryAllByRole(role, { name })[0] ?? null;
/** Find a control that is not exposed through a role (a plain cell / badge). */
const byText = (name: RegExp) => (): HTMLElement | null => screen.queryAllByText(name)[0] ?? null;
const button = (name: RegExp) => byRole('button', name);

/**
 * What flips the control off in the negative render:
 *  - a permission id — the viewer holds everything else, not this;
 *  - `'systemAdmin'` / `'admin'` — the page's own role gate refuses, which the
 *    auth guard surfaces as `accessDenied` (the page renders AccessDenied).
 *  - `'feature'` — the control carries NO permission gate, only an entitlement
 *    one, so the entitlement is what the two renders differ by. The negative
 *    render must replace the control with the lock, never leave it clickable.
 */
type GatedOn = string;

interface Behaviour {
  /** The page (or smallest owning component) rendered for both cases. */
  mount: (ctx: MountCtx) => ReactElement;
  /**
   * Set when `mount` is NOT the control's own page, saying what is rendered
   * instead and why the page cannot reach the control. Rows without it render
   * the real page, so the page-level mount-site gate runs for real.
   */
  renders?: string;
  /** API payloads this surface needs, `method` → the `data` it resolves with. */
  api?: Record<string, unknown>;
  /** Auth-guard fields the surface needs besides the permission under test. */
  guard?: Partial<PageAuthGuard>;
  /** `useOrgHierarchy()` shape, when the surface only appears for a parent/team. */
  hierarchy?: { childOrgCount?: number; parentOrgId?: string; activeOrg?: { id: string; name: string; tier: string } };
  /** `useRouter()` fields the surface reads (`query`, `pathname`). */
  router?: Record<string, unknown>;
  /**
   * Interaction needed before the control is reachable or meaningful — opening
   * the row's action menu, or filling the field a submit button waits on. Runs
   * in BOTH renders, and must not itself depend on the permission.
   */
  reveal?: () => void;
  /** Locates the control; must return `null` when it is not rendered. */
  find: () => HTMLElement | null;
  /**
   * What the ungated viewer sees instead. `'removed'` (the default) — the
   * control is not in the DOM at all. `'disabled'` — it stays VISIBLE but
   * inert, which some surfaces do deliberately so the reason can be shown
   * (a `title=`) rather than the affordance silently vanishing.
   */
  absence?: 'removed' | 'disabled';
  /** Defaults to the row's first declared permission. See {@link GatedOn}. */
  gatedOn?: GatedOn;
}

const BASE_USER = { id: 'u1', organizationId: 'org-1', role: 'admin', email: 'a@b.test' };
const BASE_ROUTER = {
  query: {} as Record<string, unknown>,
  pathname: '/',
  asPath: '/',
  isReady: true,
  route: '/',
  replace: () => Promise.resolve(true),
  push: () => Promise.resolve(true),
  prefetch: () => Promise.resolve(),
  back: () => {},
  reload: () => {},
  events: { on: () => {}, off: () => {}, emit: () => {} },
};

/**
 * Payloads shared by many surfaces. A page whose list endpoint answers `{}`
 * throws on `.length` / `.total` before it ever renders its controls, so these
 * are the "empty but well-formed" answers that let a page reach first paint.
 */
/** Payload returned AS the method's answer, for the client methods that resolve
 *  the value itself instead of an `ApiResponse` envelope. */
const raw = (value: unknown) => ({ __pbRaw: value });
const EMPTY_PAGE = { total: 0, limit: 25, offset: 0, hasMore: false };
/** A scan still RUNNING — the only state whose cancel action exists at all. */
const RUNNING_SCAN = {
  id: 's1', orgId: 'org-1', target: 'plugin', status: 'running', triggeredBy: 'manual', userId: 'u1',
  totalEntities: 10, processedEntities: 4, passCount: 3, warnCount: 1, blockCount: 0,
  startedAt: '2026-09-01T00:00:00Z', createdAt: '2026-09-01T00:00:00Z',
};
/** The thread behind the message list's first row, authored by the viewer (u1)
 *  in their own org — the shape the edit affordance needs to exist at all. */
const THREAD_MESSAGE = {
  id: 'm1', subject: 'Welcome', content: 'hi there', body: 'hi there',
  orgId: 'org-1', recipientOrgId: 'org-2', createdBy: 'u1', messageType: 'direct',
  priority: 'normal', createdAt: '2026-09-01T00:00:00Z', isRead: true, attachments: [],
};
/** The inbox page the thread rows are opened from. */
const MESSAGE_PAGE = { messages: [THREAD_MESSAGE], pagination: { ...EMPTY_PAGE, total: 1 } };
/** One streamed agent turn that ends in a plugin DRAFT the user may commit. */
const pluginProposalStream = () => (async function* stream() {
  yield { type: 'proposal', data: {
    kind: 'plugin',
    config: { name: 'trivy-scan', version: '1.0.0', pluginType: 'CodeBuildStep', computeType: 'MEDIUM', commands: ['trivy image'] },
    dockerfile: 'FROM aquasec/trivy:0.58.0',
  } };
  yield { type: 'token', data: 'Drafted a plugin.' };
  yield { type: 'done' };
})();
/** A connected OIDC login connection, so the SSO page renders its summary. */
const ORG_DETAIL = {
  id: 'org-2', orgName: 'Child Co', slug: 'child-co', description: '', tier: 'team',
  parentOrgId: null, childOrgCount: 0, memberCount: 3, createdAt: '2026-01-01T00:00:00Z',
};
/** A connected OIDC login connection, so the SSO page renders its summary. */
const SSO_CONFIG = {
  orgId: 'org-1', provider: 'okta', protocol: 'oidc', enabled: true, ssoRequired: false,
  allowedEmailDomains: [], issuer: 'https://idp.test', clientId: 'cid',
};
const API_DEFAULTS: Record<string, unknown> = {
  listPipelines: { pipelines: [], pagination: EMPTY_PAGE },
  listAllPipelines: { pipelines: [], pagination: EMPTY_PAGE },
  listPlugins: { plugins: [], pagination: EMPTY_PAGE },
  getPluginUsage: { counts: {} },
  getPluginShadowing: { shadowing: [] },
  getPreferences: { preferences: {} },
  // One row each: a list page whose body never renders exercises almost none of
  // its own code, and the row actions are where the gated controls live.
  listPipelineTemplates: {
    templates: [{ id: 't1', name: 'Golden path', description: 'd', category: 'build', visibility: 'org', createdBy: 'u1', organizationId: 'org-1', usageCount: 2, updatedAt: '2026-09-01T00:00:00Z' }],
    pagination: { ...EMPTY_PAGE, total: 1 },
  },
  listInvitations: {
    invitations: [{ id: 'i1', email: 'new@acme.test', role: 'member', status: 'pending', invitationType: 'email', createdAt: '2026-09-01T00:00:00Z', expiresAt: '2026-10-01T00:00:00Z', organizationId: 'org-1' }],
    pagination: { ...EMPTY_PAGE, total: 1 },
  },
  getOrganizationRoles: {
    roles: [{ id: 'g1', name: 'Release managers', description: 'd', permissions: ['pipelines:write'], members: [{ userId: 'u2', username: 'bee' }], organizationId: 'org-1', isSystem: false }],
    pagination: { ...EMPTY_PAGE, total: 1 },
  },
  getOrganizationMembers: { members: [], pagination: EMPTY_PAGE },
  getOrganizationSeatUsage: { used: 0, limit: 10 },
  listMfaResets: { requests: [] },
  getComplianceRules: {
    rules: [{ id: 'cr1', name: 'No :latest tags', description: 'd', severity: 'error', target: 'pipeline', isActive: true, organizationId: 'org-1', conditions: [], updatedAt: '2026-09-01T00:00:00Z' }],
    pagination: { ...EMPTY_PAGE, total: 1 },
  },
  getCompliancePolicies: { policies: [], pagination: EMPTY_PAGE },
  getComplianceScans: { scans: [], pagination: EMPTY_PAGE },
  getComplianceAuditLog: { entries: [], pagination: EMPTY_PAGE },
  getExemptions: { exemptions: [] },
  listAlertRules: {
    rules: [{ id: 'r1', name: 'High error rate', expr: 'rate(x[5m]) > 1', severity: 'warning', enabled: true, forDuration: '5m', organizationId: 'org-1', createdAt: '2026-09-01T00:00:00Z' }],
    pagination: { ...EMPTY_PAGE, total: 1 },
  },
  listDeletedAlertRules: { items: [] },
  listAlertDestinations: {
    destinations: [{ id: 'd1', name: 'Ops Slack', type: 'slack', target: 'https://hooks.example/x', enabled: true, organizationId: 'org-1', createdAt: '2026-09-01T00:00:00Z' }],
    pagination: { ...EMPTY_PAGE, total: 1 },
  },
  listDeletedAlertDestinations: { items: [] },
  listSessions: { sessions: [] },
  listPasskeys: { credentials: [] },
  getTotpStatus: { enabled: false },
  listServiceAccounts: {
    serviceAccounts: [{ id: 'sa1', name: 'ci-deploy', description: 'd', enabled: true, organizationId: 'org-1', keys: [], createdAt: '2026-09-01T00:00:00Z' }],
  },
  getOwnOrgIdpConfig: { config: null },
  getIncidentSettings: { settings: {} },
  listIncidents: {
    incidents: [{ id: 'in1', source: 'alertmanager', title: 'API latency', startedAt: '2026-09-01T00:00:00Z', resolvedAt: null, severity: 'high' }],
    pagination: { ...EMPTY_PAGE, total: 1 },
  },
  getOwnQuotas: { quotas: [] },
  getOrgAtRisk: { orgs: [] },
  getUnreadCount: { count: 0 },
  getExecutionCount: { pipelines: [] },
  getReportRetention: { days: 30 },
  getIngestHealth: { lastEventAt: null },
  getSuccessRate: { pipelines: [] },
  logSearch: { entries: [{ ts: '2026-09-01T00:00:00Z', line: 'hello', level: 'info', labels: {} }] },
  logVolume: { buckets: [] },
  getAccessToken: { token: null },
  getBillingUsage: { period: { start: '2026-09-01', end: '2026-09-30' }, usage: {}, lines: [], totalCents: 0 },
  listMessages: {
    messages: [{ id: 'm1', subject: 'Welcome', body: 'hi', orgId: 'org-1', recipientOrgId: 'org-1', createdBy: 'u2', createdAt: '2026-09-01T00:00:00Z', isRead: false, attachments: [] }],
    pagination: { ...EMPTY_PAGE, total: 1 },
  },
  getMarketplaceEntitlements: { entitlements: [] },
  getDora: raw({
    coverage: { registered: 1, deploying: 1, withoutDeploys: 0 },
    headline: 'production',
    environments: [{
      environment: 'production',
      deploymentFrequency: { deployments: 4, perDay: 1, level: 'high' },
      leadTime: { deployments: 4, medianSeconds: 3600, level: 'high' },
      changeFailureRate: { rate: 0, deployTimeFailures: 0, postDeployFailures: 0, attempts: 4, level: 'elite' },
      timeToRestore: { incidents: 0, restored: 0, medianSeconds: null, level: 'elite' },
    }],
    filters: { pipelineId: null, environment: null },
    meanTimeToRestore: { incidents: 0, restored: 0, medianSeconds: null },
    window: { from: '2026-09-01', to: '2026-09-30' },
  }),
  getDoraTrend: raw([]),
  getBuildHealth: raw(null),
  getReportEnvironments: { environments: [] },
  listPipelineExecutions: { executions: [] },
  listUsers: { users: [{ id: 'u2', username: 'bee', email: 'b@c.test', isSuperAdmin: false, organizationId: 'org-1', role: 'member' }], pagination: EMPTY_PAGE },
  getOrgAIConfig: { providers: {} },
  getMyOrganization: { organization: { id: 'org-1', orgName: 'Acme', slug: 'acme' } },
  getImpersonationPolicy: { own: { policy: 'consent', allowSelfApproval: false }, effective: { policy: 'consent', source: 'own' } },
  getPasswordPolicy: { policy: {} },
  getAuthenticatorPolicy: { own: [], effective: [], inheritedFrom: [], mds: { models: [] }, compliance: { modelsInUse: [] } },
  getMfaPolicy: { own: { required: false }, effective: { required: false }, inheritedFrom: [] },
  listOrgDomains: { domains: [] },
  listOrgJoinRequests: { requests: [] },
  listIdpGroupMappings: { mappings: [] },
};

// jsdom has no EventSource, and several pages open a live stream on mount.
// Without this the page throws in an effect, which reads like a component bug.
class InertEventSource {
  close() {}
  addEventListener() {}
  removeEventListener() {}
}
(globalThis as unknown as { EventSource?: unknown }).EventSource ??= InertEventSource;
// jsdom implements no scrolling at all; the message thread scrolls its tail into
// view whenever the thread changes, which would otherwise throw in an effect.
if (typeof Element !== 'undefined' && typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}
// Chrome components (the dashboard shell) ask about reduced motion on mount.
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  (window as unknown as { matchMedia: unknown }).matchMedia = () => ({
    matches: false, media: '', onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  });
}

/** Flush mount-effect fetches AND lazy/Suspense chunks (a macrotask tick), so a
 *  surface reaches first paint before the control is looked for. */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
}

/** Render one case of a control: the given `can()` and auth-guard overrides. */
async function renderCase(b: Behaviour, can: (p: string) => boolean, guard: Partial<PageAuthGuard>, entitled = true) {
  const g = globalThis as unknown as Record<string, unknown>;
  g.__pbEntitled = entitled;
  // The same authority in both shapes: `can()` for the hook, `user.permissions`
  // for anything reading `hasPermission(user, …)` off a prop.
  const user = { ...BASE_USER, permissions: ALL_PERMISSIONS.filter(can) };
  g.__pbApi = { ...API_DEFAULTS, ...(b.api ?? {}) };
  g.__pbRouter = { ...BASE_ROUTER, ...(b.router ?? {}) };
  g.__pbAuth = {
    user, isAuthenticated: true, isLoading: false, organizations: [],
    logout: () => {}, refreshUser: () => {}, switchOrganization: () => {},
  };
  mockOrgHierarchy(b.hierarchy ?? {});
  mockAuthGuard({ user, ...(b.guard ?? {}), ...guard, can });
  // Inside `act`: a surface that SUSPENDS (the lazily-loaded dashboard shell)
  // never resolves if the render itself is not awaited.
  await act(async () => { render(b.mount({ user, can })); });
  await settle();
  if (b.reveal) {
    await act(async () => { b.reveal!(); });
    await settle();
  }
}

// ── The mapping ────────────────────────────────────────────────────────────

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
  /**
   * The routes are subject to the org's "administrative actions require MFA"
   * policy: while it is on, a single-factor session gets 401 `MFA_REQUIRED`,
   * which the shell turns into the enrol / sign-in dialog app-wide (see the
   * "MFA refusals" suite below) — so declaring it records what the click can
   * cost, the same way `stepUp` does.
   */
  orgAdminAssurance?: boolean;
  /** `<service> <METHOD> <path>` entries from the generated tables. */
  routes: string[];
  /** Render-with / render-without proof that the gate is real. */
  behaviour: Behaviour;
}

// ── Plugin-ecosystem fixtures (the Publisher page and the Ecosystem console) ──
const ECO_PUBLISHER = {
  id: 'pub1', handle: 'acme', displayName: 'Acme Corp', description: null, homepageUrl: null, tier: 'community',
  verifiedAt: null, verifiedGraceUntil: null, termsVersion: '1', termsAcceptedAt: '2026-01-01', suspendedAt: null,
  suspendReason: null, ownerOrgId: 'org-1', createdAt: '2026-01-01', updatedAt: '2026-01-01',
};
/** `GET /plugins/publisher` for a root org; `over` flips one state. */
const publisherCtx = (over: Record<string, unknown> = {}) => ({
  publisher: ECO_PUBLISHER, isRootOrg: true, terms: { currentVersion: '2', accepted: true },
  verifiedEligible: false, listingsQuota: { used: 1, limit: 3 }, publishingEnabled: true, ...over,
});
const ECO_VERSION = {
  id: 'v1', version: '1.0.0', imageDigest: null, imageRepository: null, breaking: false, pausedAt: null, yankedAt: null,
  yankReason: null, vulnCritical: 0, vulnHigh: 0, publishedAt: '2026-01-01T00:00:00Z', changelog: null,
};
const ECO_LISTING = {
  id: 'l1', publisherId: 'pub1', publisherHandle: 'acme', publisherTier: 'community', name: 'eslint', category: 'quality',
  summary: 'Lint JS', description: null, license: 'MIT', homepageUrl: null, sourceUrl: null, icon: null, keywords: [],
  state: 'listed', pausedAt: null, featured: false, latestVersion: '1.0.0', createdAt: '2026-01-01', updatedAt: '2026-01-01',
  openRequests: 0, versions: [ECO_VERSION],
};
const ECO_REQUEST = {
  id: 'r1', kind: 'new_listing', status: 'pending', lane: 'standard', publisherId: 'pub1', publisherHandle: 'acme',
  publisherTier: 'community', listingId: null, listingName: 'eslint', pluginId: 'p1', version: '1.0.0', digest: null,
  payload: { name: 'eslint' }, submittedBy: 'u1', submittedOrgId: 'org-1', submittedAt: '2026-09-01T00:00:00Z',
  firstApprovedBy: null, secondApprovedBy: null, decidedBy: null, decidedAt: null, reason: null, autoRuleId: null,
  securityFixAdvisoryId: null,
};
/** A queue item a moderator may decide (no conflict, one approver, no step-up). */
const ECO_QUEUE_ITEM = {
  ...ECO_REQUEST, submittedOrgId: 'org-9', ageHours: 2, slaHours: 48, slaBreached: false, requiresTwoPerson: false,
  requiresStepUp: false, requiredPermission: 'plugins:moderate', conflictOfInterest: false, conflictReason: null,
};
const ECO_REVIEW = {
  previousVersion: null, metadata: [], contract: null, vuln: null, dockerfile: null, sbom: null, icon: null, gates: [],
  publisherHistory: { tier: 'community', createdAt: '2026-01-01', listings: 1, approved: 0, rejected: 0 },
  autoApproval: { eligible: false, ruleId: null, ruleName: null, reasons: [] },
};
const ECO_APPROVERS = { permission: 'plugins:moderate', count: { holders: 3, eligible: 3, superadmins: 1 }, belowMinimum: false, belowTwoPerson: false };
const ECO_OVERVIEW = {
  approvers: { minimum: 3, twoPersonMinimum: 2, moderate: ECO_APPROVERS, verify: { ...ECO_APPROVERS, permission: 'publishers:verify' } },
  pending: { standard: 1, security: 0, secondApproval: 0, verify: 0 },
  bootstrap: { state: 'closed', openedAt: null, closedAt: null, reason: null },
  officialAutoApprovalEnabled: true, termsVersion: '2',
};
/** The console panels take the viewer's `can` as a prop (the page hands it down). */
const ecoPanel = (mod: string, name: string, extra: Record<string, unknown> = {}) =>
  (ctx: MountCtx) => comp(mod, name, { can: ctx.can, ...extra })();
/** Why the console rows mount the panel, not the page. */
const ECO_PANEL_RENDERS = 'the panel in isolation — the console page (pages/dashboard/admin/ecosystem.tsx) additionally '
  + 'requires the SYSTEM org and an aal2 session (useSessionAssurance) before it renders any tab, neither of which this '
  + 'harness models; the page hands `can` straight to the panel, which is what gates the control.';

const CONTROLS: Control[] = [
  {
    control: 'New / edit / delete pipeline',
    file: 'pages/dashboard/pipelines.tsx',
    permissions: ['pipelines:write'],
    routes: ['pipeline POST /pipelines', 'pipeline PUT /pipelines/:id', 'pipeline DELETE /pipelines/:id'],
    behaviour: { mount: page('../pages/dashboard/pipelines'), find: button(/^create pipeline$/i) },
  },
  {
    control: 'Restore / purge a deleted pipeline',
    file: 'pages/dashboard/pipelines.tsx',
    gateFiles: ['src/components/RecentlyDeletedPanel.tsx'],
    permissions: ['pipelines:write'],
    stepUp: true,
    routes: ['pipeline POST /pipelines/:id/restore', 'pipeline POST /pipelines/:id/purge'],
    behaviour: {
      // The panel is a tab of the page; the tab itself is the gated control
      // (no `pipelines:write`, no "Recently deleted" tab and no restore path).
      mount: page('../pages/dashboard/pipelines'),
      find: byRole('tab', /recently deleted/i),
    },
  },
  {
    control: 'Run / cancel a pipeline execution',
    file: 'pages/dashboard/pipelines/[id].tsx',
    permissions: ['pipelines:write'],
    routes: [
      'pipeline POST /pipelines/:pipelineId/executions',
      'pipeline POST /pipelines/:pipelineId/executions/:executionId/stop',
    ],
    behaviour: {
      mount: page('../pages/dashboard/pipelines/[id]'),
      router: { query: { id: 'p1' }, pathname: '/dashboard/pipelines/[id]' },
      api: { getPipelineById: { pipeline: { id: 'p1', pipelineName: 'p', organizationId: 'org-1', visibility: 'private', createdBy: 'u1' } } },
      // Rendered either way — disabled with a reason, so a read-only viewer is
      // told why instead of the action silently disappearing.
      absence: 'disabled',
      find: button(/^run pipeline$/i),
    },
  },
  {
    control: 'Pipeline list + detail reads',
    file: 'src/lib/nav.ts',
    permissions: ['pipelines:read'],
    routes: ['pipeline GET /pipelines', 'pipeline GET /pipelines/:id'],
    behaviour: {
      renders: 'the real <Sidebar/>: a read gate IS the nav entry, and the nav link is the control.',
      mount: (ctx) => comp('../src/components/ui/Sidebar', 'Sidebar', {
        isSuperAdmin: false, isAdmin: false, user: ctx.user, unreadCount: 0,
        currentPath: '/dashboard', isDark: false, onToggleDark: () => {}, onLogout: () => {},
      })(),
      find: byRole('link', /^pipelines$/i),
    },
  },
  {
    control: 'Template gallery reads',
    file: 'src/lib/nav.ts',
    permissions: ['templates:read'],
    routes: ['pipeline GET /pipeline-templates', 'pipeline GET /pipeline-templates/:id'],
    behaviour: {
      renders: 'the real <Sidebar/> (see "Pipeline list + detail reads").',
      mount: (ctx) => comp('../src/components/ui/Sidebar', 'Sidebar', {
        isSuperAdmin: false, isAdmin: false, user: ctx.user, unreadCount: 0,
        currentPath: '/dashboard', isDark: false, onToggleDark: () => {}, onLogout: () => {},
      })(),
      find: byRole('link', /^templates$/i),
    },
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
    behaviour: { mount: page('../pages/dashboard/templates'), find: button(/^new template$/i) },
  },
  {
    control: 'Upload / edit / delete a plugin',
    file: 'pages/dashboard/plugins.tsx',
    permissions: ['plugins:write'],
    // `POST /plugins/inspect` is the upload dialog's Catalog details step (a dry run
    // of the same package, same plugins:write gate).
    routes: ['plugin POST /plugins', 'plugin POST /plugins/inspect', 'plugin PUT /plugins/:id', 'plugin DELETE /plugins/:id'],
    behaviour: { mount: page('../pages/dashboard/plugins'), find: button(/^upload plugin$/i) },
  },
  {
    control: 'Deprecate / yank a plugin version',
    file: 'src/components/plugin/usePluginColumns.tsx',
    permissions: ['plugins:write'],
    // Per-row actions in the plugins table (gated by the same `canWriteRow` as
    // edit/delete), confirmed in src/components/plugin/PluginLifecycleModal.tsx.
    routes: ['plugin POST /plugins/:id/deprecate', 'plugin POST /plugins/:id/yank'],
    behaviour: {
      mount: page('../pages/dashboard/plugins'),
      api: { listPlugins: { plugins: [{ id: 'pl1', name: 'one', version: '1.0.0', organizationId: 'org-1', visibility: 'private', createdBy: 'u1' }], pagination: { ...EMPTY_PAGE, total: 1 } } },
      find: button(/^yank version$/i),
    },
  },
  {
    control: 'Install / upgrade / uninstall a catalog listing',
    file: 'pages/dashboard/plugins.tsx',
    gateFiles: ['src/components/plugin-installs/InstallControls.tsx'],
    permissions: ['plugins:install'],
    // The shared install controls (Catalog / Installs tabs and the public plugin
    // page); with approval required, POST only REQUESTS the install.
    routes: ['plugin POST /plugins/installs', 'plugin PATCH /plugins/installs/:id', 'plugin DELETE /plugins/installs/:id'],
    behaviour: {
      mount: page('../pages/dashboard/plugins'),
      router: { query: { tab: 'catalog' }, pathname: '/dashboard/plugins' },
      api: {
        getPluginCatalog: { listings: [{
          listing: { id: 'l1', publisherHandle: 'acme', publisherDisplayName: 'Acme', publisherTier: 'verified', name: 'tf', summary: null, category: 'deploy', icon: null, latestVersion: '1.0.0', state: 'listed', paused: false, license: null },
          install: null, installable: true, needsApproval: false, blocked: null, resolved: null,
          reference: { publisher: 'acme', name: 'tf' }, shadowedBy: null,
        }] },
      },
      find: button(/^install$/i),
    },
  },
  {
    control: 'Approve / deny a plugin install request',
    file: 'pages/dashboard/plugins.tsx',
    gateFiles: ['src/components/plugin-installs/ApprovalsTab.tsx'],
    permissions: ['plugin_installs:manage'],
    routes: ['plugin POST /plugins/installs/:id/approve', 'plugin POST /plugins/installs/:id/deny'],
    behaviour: {
      mount: page('../pages/dashboard/plugins'),
      router: { query: { tab: 'approvals' }, pathname: '/dashboard/plugins' },
      api: {
        listPluginInstalls: { installs: [{
          id: 'i1', listingId: 'l1', publisherHandle: 'acme', publisherDisplayName: 'Acme', publisherTier: 'community', name: 'tf',
          summary: null, category: 'deploy', icon: null, state: 'listed', paused: false, versionPolicy: 'minor', pinnedVersion: '1.0.0',
          resolvedVersion: null, latestVersion: '1.0.0', status: 'pending_approval', implicit: false, inherited: false,
          installedBy: 'u2', approvedBy: null, createdAt: '2026-09-01T00:00:00Z', decidedAt: null, upgrade: null, blocked: null,
          warnings: [], advisories: [],
        }], policy: {} },
      },
      find: button(/^approve$/i),
    },
  },
  {
    control: 'Request an install change that needs an approver',
    file: 'pages/dashboard/plugins.tsx',
    gateFiles: ['src/components/plugin-installs/InstallControls.tsx'],
    permissions: ['plugins:install'],
    // A major / breaking upgrade (or a move to `latest`) the org's policy tier
    // needs an approver for: the member REQUESTS it instead of the PATCH.
    routes: ['plugin POST /plugins/installs/:id/change-requests'],
    behaviour: {
      mount: page('../pages/dashboard/plugins'),
      router: { query: { tab: 'catalog' }, pathname: '/dashboard/plugins' },
      api: {
        getPluginCatalog: { listings: [{
          listing: { id: 'l1', publisherHandle: 'acme', publisherDisplayName: 'Acme', publisherTier: 'community', name: 'tf', summary: null, category: 'deploy', icon: null, latestVersion: '2.0.0', state: 'listed', paused: false, license: null },
          install: {
            id: 'i1', listingId: 'l1', publisherHandle: 'acme', publisherDisplayName: 'Acme', publisherTier: 'community', name: 'tf',
            summary: null, category: 'deploy', icon: null, state: 'listed', paused: false, versionPolicy: 'minor', pinnedVersion: '1.0.0',
            resolvedVersion: '1.0.0', latestVersion: '2.0.0', status: 'active', implicit: false, inherited: false,
            installedBy: 'u2', approvedBy: null, createdAt: '2026-09-01T00:00:00Z', decidedAt: null,
            upgrade: { version: '2.0.0', breaking: false, changelog: null, vulnDelta: { newCritical: 0, newHigh: 0 } },
            blocked: null, warnings: [], advisories: [], pendingChange: null,
          },
          installable: false, needsApproval: true, blocked: null, resolved: null,
          reference: { publisher: 'acme', name: 'tf' }, shadowedBy: null,
        }] },
      },
      find: button(/^request upgrade to 2\.0\.0$/i),
    },
  },
  {
    control: 'Approve / reject a requested install change',
    file: 'pages/dashboard/plugins.tsx',
    gateFiles: ['src/components/plugin-installs/ApprovalsTab.tsx'],
    permissions: ['plugin_installs:manage'],
    routes: ['plugin POST /plugins/installs/:id/change-requests/approve', 'plugin POST /plugins/installs/:id/change-requests/reject'],
    behaviour: {
      mount: page('../pages/dashboard/plugins'),
      router: { query: { tab: 'approvals' }, pathname: '/dashboard/plugins' },
      api: {
        listPluginInstalls: { installs: [], policy: {} },
        listInstallChangeRequests: { changeRequests: [{
          installId: 'i1', listing: 'acme/tf', from: { version: '1.0.0', versionPolicy: 'minor' }, to: { version: '2.0.0', versionPolicy: 'minor' },
          requestedBy: 'u2', requestedAt: '2026-09-01T00:00:00Z', note: null,
        }] },
      },
      find: button(/^approve the change to acme\/tf$/i),
    },
  },
  {
    control: 'Edit the plugin consumption policy',
    file: 'pages/dashboard/plugins.tsx',
    gateFiles: ['src/components/plugin-installs/PolicyTab.tsx'],
    permissions: ['plugin_installs:manage'],
    stepUp: true,
    routes: ['plugin PUT /plugins/install-policy'],
    behaviour: {
      mount: page('../pages/dashboard/plugins'),
      router: { query: { tab: 'policy' }, pathname: '/dashboard/plugins' },
      api: {
        getInstallPolicy: {
          policy: { allowedTiers: ['official'], requireApprovalTiers: [], secretsAllowedTiers: [], blockOnAdvisory: 'critical', officialInstalls: 'implicit', blockedListings: [] },
          effective: { allowedTiers: ['official'], requireApprovalTiers: [], secretsAllowedTiers: [], blockOnAdvisory: 'critical', officialInstalls: 'implicit', blockedListings: [] },
          inheritsFromRoot: false, updatedBy: null, updatedAt: null, canEdit: true,
        },
      },
      find: button(/^save policy$/i),
    },
  },
  {
    control: 'Plugin list + detail reads',
    file: 'src/lib/nav.ts',
    permissions: ['plugins:read'],
    routes: ['plugin GET /plugins', 'plugin GET /plugins/:id'],
    behaviour: {
      renders: 'the real <Sidebar/> (see "Pipeline list + detail reads").',
      mount: (ctx) => comp('../src/components/ui/Sidebar', 'Sidebar', {
        isSuperAdmin: false, isAdmin: false, user: ctx.user, unreadCount: 0,
        currentPath: '/dashboard', isDark: false, onToggleDark: () => {}, onLogout: () => {},
      })(),
      find: byRole('link', /^plugins$/i),
    },
  },
  {
    control: 'Send / delete a message',
    file: 'pages/dashboard/messages.tsx',
    permissions: ['messages:write'],
    routes: ['message POST /messages', 'message DELETE /messages/:id'],
    behaviour: {
      // Without `messages:write` the same button becomes "Contact Support" —
      // a different control that drives a different flow, so the composer's
      // accessible name is the thing that must disappear.
      mount: page('../pages/dashboard/messages'),
      find: byRole('button', /^new message$/i),
    },
  },
  {
    control: 'Contact support',
    file: 'pages/dashboard/messages.tsx',
    gateFiles: ['src/components/message/ComposeModal.tsx'],
    // NOTHING inline gates this one, and saying otherwise would be a lie: the
    // composer is offered to everyone who can open the inbox. `messages:write`
    // only decides WHICH form opens — full compose, or the support-only contact
    // form — so the support route's floor is the page's own `messages:read`.
    permissions: [],
    pagePermissions: ['messages:read'],
    page: '/dashboard/messages',
    routes: ['message POST /messages/support'],
    behaviour: {
      // One button, two accessible names: "New Message" for a writer and
      // "Contact Support" for a reader. Both open the composer that drives this
      // route, so the control is the button under either name — and without
      // `messages:read` the page itself refuses and neither is rendered.
      mount: page('../pages/dashboard/messages'),
      find: byRole('button', /^(new message|contact support)$/i),
      gatedOn: 'messages:read',
    },
  },
  {
    control: 'Compose recipient list (account orgs + teams)',
    file: 'pages/dashboard/messages.tsx',
    permissions: ['messages:write'],
    routes: ['message GET /messages/recipients/orgs'],
    behaviour: {
      mount: page('../pages/dashboard/messages'),
      find: byRole('button', /^new message$/i),
    },
  },
  {
    control: 'Edit your own message in a thread',
    file: 'pages/dashboard/messages.tsx',
    gateFiles: ['src/components/message/ThreadView.tsx'],
    permissions: ['messages:write'],
    routes: ['message PATCH /messages/:id'],
    behaviour: {
      // Authorship alone used to decide this; the route checks `messages:write`
      // BEFORE it looks at authorship, so a read-only author saw a 404-on-save.
      mount: page('../pages/dashboard/messages'),
      api: { getMessages: MESSAGE_PAGE, getThread: { messages: [THREAD_MESSAGE] } },
      reveal: () => fireEvent.click(screen.getAllByRole('button', { name: /hi there/i })[0]),
      find: button(/^edit message$/i),
    },
  },
  {
    control: 'Reply in a message thread',
    file: 'pages/dashboard/messages.tsx',
    gateFiles: ['src/components/message/ThreadView.tsx'],
    permissions: ['messages:write'],
    routes: ['message POST /messages/:id/reply'],
    behaviour: {
      mount: page('../pages/dashboard/messages'),
      api: { getMessages: MESSAGE_PAGE, getThread: { messages: [THREAD_MESSAGE] } },
      reveal: () => fireEvent.click(screen.getAllByRole('button', { name: /hi there/i })[0]),
      // Disabled rather than removed: the viewer is already reading the thread,
      // so an empty footer would read as a broken page. The composer's input is
      // the control (Send is inert until something is typed either way).
      absence: 'disabled',
      find: byRole('textbox', /^reply to conversation$/i),
    },
  },
  {
    control: 'Attach a file to a message or reply',
    file: 'pages/dashboard/messages.tsx',
    gateFiles: ['src/components/message/ThreadView.tsx', 'src/components/message/ComposeModal.tsx'],
    permissions: ['messages:write'],
    routes: ['message POST /messages/attachments'],
    behaviour: {
      // Two callers: the thread composer (disabled with the reason, below) and
      // ComposeModal, which is handed `onUploadAttachment` only for a writer —
      // so the support-only contact form a reader gets has no attach control.
      mount: page('../pages/dashboard/messages'),
      api: { getMessages: MESSAGE_PAGE, getThread: { messages: [THREAD_MESSAGE] } },
      reveal: () => fireEvent.click(screen.getAllByRole('button', { name: /hi there/i })[0]),
      absence: 'disabled',
      find: button(/^attach files$/i),
    },
  },
  {
    control: 'Message reads',
    file: 'src/lib/nav.ts',
    permissions: ['messages:read'],
    routes: ['message GET /messages', 'message GET /messages/:id'],
    behaviour: {
      renders: 'the real <Sidebar/> (see "Pipeline list + detail reads").',
      mount: (ctx) => comp('../src/components/ui/Sidebar', 'Sidebar', {
        isSuperAdmin: false, isAdmin: false, user: ctx.user, unreadCount: 0,
        currentPath: '/dashboard', isDark: false, onToggleDark: () => {}, onLogout: () => {},
      })(),
      find: byRole('link', /^messages$/i),
    },
  },
  {
    control: 'Review a compliance exemption',
    file: 'pages/dashboard/inbox.tsx',
    permissions: ['compliance:write'],
    routes: ['compliance PUT /compliance/exemptions/:id/review', 'compliance DELETE /compliance/exemptions/:id'],
    behaviour: {
      mount: page('../pages/dashboard/inbox'),
      api: { getExemptions: { exemptions: [{ id: 'ex1', entityType: 'plugin', reason: 'legacy build' }] } },
      find: byText(/exemption request pending review/i),
    },
  },
  {
    control: 'Author / delete a compliance rule or policy',
    file: 'pages/dashboard/compliance.tsx',
    gateFiles: ['src/components/compliance/ComplianceDashboard.tsx', 'src/components/compliance/RuleList.tsx'],
    permissions: ['compliance:write'],
    routes: [
      'compliance POST /compliance/rules',
      'compliance DELETE /compliance/rules/:id',
      'compliance POST /compliance/policies',
      'compliance DELETE /compliance/policies/:id',
    ],
    behaviour: {
      mount: page('../pages/dashboard/compliance'),
      router: { query: { view: 'rules' }, pathname: '/dashboard/compliance' },
      find: button(/^new rule$/i),
    },
  },
  {
    control: 'Cancel a running compliance scan',
    file: 'pages/dashboard/compliance.tsx',
    gateFiles: ['src/components/compliance/ComplianceDashboard.tsx', 'src/components/compliance/ScanDetail.tsx'],
    permissions: ['compliance:write'],
    routes: ['compliance POST /compliance/scans/:id/cancel'],
    behaviour: {
      // The list's own cancel icon (ScanManager) was already `!readOnly`; this
      // renders the DETAIL twin behind "View scan details", which is where the
      // ungated button lived — the page passes `readOnly={!canManage}` to both.
      mount: page('../pages/dashboard/compliance'),
      router: { query: { view: 'scans' }, pathname: '/dashboard/compliance' },
      api: {
        getScans: { scans: [RUNNING_SCAN], pagination: { ...EMPTY_PAGE, total: 1 } },
        getScan: { scan: RUNNING_SCAN },
        getComplianceAuditLog: { entries: [], pagination: EMPTY_PAGE },
      },
      reveal: () => fireEvent.click(screen.getAllByRole('button', { name: /view scan details/i })[0]),
      find: button(/^cancel scan$/i),
    },
  },
  {
    control: 'Compliance reads (rules, policies, scans)',
    file: 'src/lib/nav.ts',
    permissions: ['compliance:read'],
    routes: ['compliance GET /compliance/rules', 'compliance GET /compliance/policies', 'compliance GET /compliance/scans'],
    behaviour: {
      renders: 'the real <Sidebar/> (see "Pipeline list + detail reads").',
      mount: (ctx) => comp('../src/components/ui/Sidebar', 'Sidebar', {
        isSuperAdmin: false, isAdmin: false, user: ctx.user, unreadCount: 0,
        currentPath: '/dashboard', isDark: false, onToggleDark: () => {}, onLogout: () => {},
      })(),
      find: byRole('link', /^compliance$/i),
    },
  },
  {
    control: 'Change / cancel the subscription',
    file: 'pages/dashboard/billing.tsx',
    gateFiles: ['src/components/billing/SubscriptionStatusCard.tsx'],
    permissions: ['billing:manage'],
    // Cancelling is step-up gated; the resume path is global (see the
    // "step-up refusals are resumable app-wide" test).
    stepUp: true,
    orgAdminAssurance: true,
    routes: [
      'billing POST /billing/subscriptions',
      'billing PUT /billing/subscriptions/:id',
      'billing POST /billing/subscriptions/:id/cancel',
      'billing POST /billing/subscriptions/:id/reactivate',
      'billing POST /billing/subscriptions/checkout',
      'billing POST /billing/portal',
    ],
    behaviour: {
      mount: page('../pages/dashboard/billing'),
      api: {
        getSubscription: { subscription: { id: 'sub1', planId: 'pro', status: 'active', interval: 'month' } },
        getPlans: { plans: [] },
        getBundles: { bundles: [] },
      },
      find: button(/^manage billing$/i),
    },
  },
  {
    control: 'Redeem / remove a discount code',
    file: 'pages/dashboard/billing.tsx',
    gateFiles: ['src/components/billing/DiscountRedeem.tsx'],
    permissions: ['billing:manage'],
    orgAdminAssurance: true,
    routes: [
      'billing POST /billing/subscriptions/:id/discounts',
      'billing DELETE /billing/subscriptions/:id/discounts/:discountId',
    ],
    behaviour: {
      mount: page('../pages/dashboard/billing'),
      router: { query: { tab: 'addons' }, pathname: '/dashboard/billing' },
      api: {
        getSubscription: { subscription: { id: 'sub1', planId: 'pro', status: 'active', interval: 'month' } },
        getPlans: { plans: [] },
        getBundles: { bundles: [] },
      },
      // Redeem/remove stay mounted but inert without `billing:manage`, with the
      // "contact an organization admin" reason beside them.
      absence: 'disabled',
      find: byRole('textbox', /discount code/i),
    },
  },
  {
    control: 'Add / remove a billing add-on',
    // NOT pages/dashboard/quotas.tsx: that page only LINKS to billing. The
    // add-on writes are driven by `useAddonChange` under the Billing page's
    // Add-ons tab (the render proves it — quotas.tsx never reaches them).
    file: 'pages/dashboard/billing.tsx',
    gateFiles: ['src/components/billing/AddonGrid.tsx', 'src/components/billing/useAddonChange.ts'],
    permissions: ['billing:manage'],
    orgAdminAssurance: true,
    routes: [
      'billing POST /billing/subscriptions/:id/addons',
      'billing DELETE /billing/subscriptions/:id/addons/:bundleId',
    ],
    behaviour: {
      mount: page('../pages/dashboard/billing'),
      router: { query: { tab: 'addons' }, pathname: '/dashboard/billing' },
      api: {
        getSubscription: { subscription: { id: 'sub1', planId: 'pro', status: 'active', interval: 'month' } },
        getPlans: { plans: [] },
        getBundles: { bundles: [{ id: 'seat_pack', name: 'Seat pack', prices: { month: 900, year: 9000 }, dimension: 'seats', quantityStep: 1 }] },
      },
      find: byText(/^seat pack$/i),
    },
  },
  {
    control: 'Create / edit a custom dashboard',
    file: 'pages/dashboard/observability/new.tsx',
    permissions: ['dashboards:write'],
    routes: ['platform POST /dashboards', 'platform POST /dashboards/:id/clone'],
    behaviour: {
      // Kept on screen but inert without `dashboards:write`, with the reason in
      // its `title` rather than the form silently having no submit.
      mount: page('../pages/dashboard/observability/new'),
      // The submit also waits on a name, so give it one — otherwise "disabled"
      // would prove nothing about the permission.
      reveal: () => fireEvent.change(screen.getAllByRole('textbox')[0], { target: { value: 'My board' } }),
      absence: 'disabled',
      find: button(/create & add panels/i),
    },
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
    behaviour: { mount: page('../pages/dashboard/observability/alert-rules'), find: button(/^add rule$/i) },
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
    behaviour: { mount: page('../pages/dashboard/observability/alert-destinations'), find: button(/^add destination$/i) },
  },
  {
    control: "Change a member's role / remove a member",
    file: 'pages/dashboard/members.tsx',
    permissions: ['members:manage'],
    orgAdminAssurance: true,
    routes: [
      'platform POST /organization/:id/members',
      'platform DELETE /organization/:id/members/:userId',
      'platform PATCH /organization/:id/members/:userId/deactivate',
      'platform PATCH /organization/:id/members/:userId/activate',
      'platform POST /organization/:id/members/bulk-add',
    ],
    behaviour: { mount: page('../pages/dashboard/members'), find: button(/^add member$/i) },
  },
  {
    control: 'Request a two-factor reset for a member (Members → Reset MFA…)',
    file: 'pages/dashboard/members.tsx',
    gateFiles: ['src/components/members/RequestMfaResetModal.tsx'],
    permissions: ['members:manage'],
    stepUp: true,
    minAssurance: 2,
    routes: ['platform POST /organization/:id/mfa-resets'],
    behaviour: {
      // `canResetMfa` is `members:manage` AND an admin role; the panel below the
      // roster only mounts for a holder, so the panel's heading is the control.
      mount: page('../pages/dashboard/members'),
      guard: { isAdmin: true, isOrgAdminUser: true },
      api: { getOrganizationMembers: { members: [{ id: 'm1', userId: 'u2', username: 'bee', email: 'b@c.test', role: 'member', isActive: true }], pagination: { ...EMPTY_PAGE, total: 1 } } },
      find: byRole('button', /reset two-factor authentication for/i),
    },
  },
  {
    control: 'Approve / deny a pending two-factor reset (Members → Pending two-factor resets)',
    file: 'pages/dashboard/members.tsx',
    gateFiles: ['src/components/members/MfaResetPanel.tsx'],
    permissions: ['members:manage'],
    // Approval: step-up with a second factor on an MFA-grade session; denial
    // needs neither (it only removes a pending action).
    stepUp: true,
    minAssurance: 2,
    routes: [
      'platform GET /organization/:id/mfa-resets',
      'platform POST /organization/:id/mfa-resets/:requestId/approve',
      'platform POST /organization/:id/mfa-resets/:requestId/deny',
    ],
    behaviour: {
      mount: page('../pages/dashboard/members'),
      guard: { isAdmin: true, isOrgAdminUser: true },
      api: { listMfaResets: { requests: [{ id: 'r1', userId: 'u2', userEmail: 'b@c.test', reason: 'lost phone', requestedBy: 'u3', requestedAt: '2026-09-01T00:00:00Z', status: 'pending' }] } },
      find: button(/^approve$/i),
    },
  },
  {
    control: "Reset a user's two-factor authentication directly (sysadmin users page)",
    file: 'pages/dashboard/users.tsx',
    gateFiles: ['src/components/users/DirectMfaResetModal.tsx'],
    // Sysadmin-only route (`systemAdmin`) on a sysadmin-only page.
    permissions: [],
    page: '/dashboard/users',
    stepUp: true,
    minAssurance: 2,
    routes: ['platform POST /admin/users/:id/mfa-reset'],
    behaviour: {
      mount: page('../pages/dashboard/users'),
      guard: { isSuperAdmin: true },
      gatedOn: 'systemAdmin',
      find: button(/^reset mfa$/i),
    },
  },
  {
    control: 'Create / edit / delete a Role, and add / remove its members',
    file: 'pages/dashboard/roles.tsx',
    permissions: ['roles:manage'],
    orgAdminAssurance: true,
    routes: [
      'platform POST /organization/:id/roles',
      'platform PUT /organization/:id/roles/:roleId',
      'platform DELETE /organization/:id/roles/:roleId',
      'platform POST /organization/:id/roles/:roleId/members',
      'platform DELETE /organization/:id/roles/:roleId/members/:userId',
    ],
    behaviour: { mount: page('../pages/dashboard/roles'), find: button(/^new role$/i) },
  },
  {
    control: 'Add / edit / delete an IdP group → role mapping',
    file: 'pages/dashboard/settings/sso.tsx',
    gateFiles: ['src/components/settings/SsoGroupMappings.tsx'],
    permissions: ['roles:manage'],
    orgAdminAssurance: true,
    routes: [
      'platform POST /organization/:id/idp/group-mappings',
      'platform PUT /organization/:id/idp/group-mappings/:mappingId',
      'platform DELETE /organization/:id/idp/group-mappings/:mappingId',
    ],
    behaviour: {
      mount: page('../pages/dashboard/settings/sso'),
      api: { getOwnOrgIdpConfig: { config: SSO_CONFIG } },
      find: byText(/group .* role mapping/i),
    },
  },
  {
    control: 'Issue / revoke a SCIM provisioning key',
    file: 'pages/dashboard/settings/sso.tsx',
    gateFiles: ['src/components/settings/ScimProvisioning.tsx'],
    permissions: ['service_accounts:manage'],
    stepUp: true,
    // Creating the account and minting its key always need an MFA-grade session.
    minAssurance: 2,
    // The SCIM endpoints themselves are driven by the identity provider, never
    // by the dashboard — what the UI drives is the service-account key mint that
    // produces the credential, so those are the routes to compare against.
    routes: [
      'platform POST /organization/:id/service-accounts',
      'platform POST /organization/:id/service-accounts/:accountId/keys',
      'platform DELETE /organization/:id/service-accounts/:accountId/keys/:keyId',
    ],
    behaviour: {
      mount: page('../pages/dashboard/settings/sso'),
      api: { getOwnOrgIdpConfig: { config: SSO_CONFIG } },
      find: byText(/scim/i),
    },
  },
  {
    control: 'Send / revoke an invitation',
    file: 'pages/dashboard/invitations.tsx',
    permissions: ['invitations:manage'],
    orgAdminAssurance: true,
    routes: [
      'platform POST /invitation/send',
      'platform DELETE /invitation/:invitationId',
      'platform POST /invitation/:invitationId/resend',
    ],
    behaviour: { mount: page('../pages/dashboard/invitations'), find: button(/^send invitations?$/i) },
  },
  {
    control: 'Edit organization identity / AI settings',
    file: 'pages/dashboard/settings.tsx',
    // `OrgIdentitySettings` is a local function in the page itself.
    gateFiles: ['src/components/settings/DomainJoinSettings.tsx'],
    permissions: ['org:settings'],
    routes: ['platform PATCH /organization/:id/identity', 'platform POST /organization/:id/domains'],
    behaviour: {
      mount: page('../pages/dashboard/settings'),
      router: { query: { tab: 'organization' }, pathname: '/dashboard/settings' },
      find: button(/^save organization$/i),
    },
  },
  {
    control: 'Edit the impersonation policy',
    file: 'pages/dashboard/settings.tsx',
    gateFiles: ['src/components/settings/ImpersonationPolicySettings.tsx'],
    permissions: ['org:impersonation'],
    stepUp: true,
    routes: ['platform PATCH /organization/:id/impersonation-policy'],
    behaviour: {
      mount: page('../pages/dashboard/settings'),
      router: { query: { tab: 'organization' }, pathname: '/dashboard/settings' },
      find: byText(/^administrator access$/i),
    },
  },
  {
    control: 'Edit the password policy / approved authenticators (Settings → Organization)',
    file: 'pages/dashboard/settings.tsx',
    gateFiles: ['src/components/settings/PasswordPolicySettings.tsx', 'src/components/settings/AuthenticatorPolicySettings.tsx'],
    permissions: ['org:settings'],
    stepUp: true,
    routes: ['platform PATCH /organization/:id/password-policy', 'platform PATCH /organization/:id/authenticator-policy'],
    behaviour: {
      mount: page('../pages/dashboard/settings'),
      router: { query: { tab: 'organization' }, pathname: '/dashboard/settings' },
      find: byText(/^password policy$/i),
    },
  },
  {
    control: "Connect / edit / enable / require / disconnect the org's own SSO (setup wizard + summary)",
    file: 'pages/dashboard/settings/sso.tsx',
    gateFiles: [
      'src/components/sso/SsoSetupWizard.tsx',
      'src/components/sso/SsoStatusSummary.tsx',
      'src/components/sso/SsoEnableToggle.tsx',
      'src/components/sso/SsoRequiredToggle.tsx',
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
    behaviour: {
      mount: page('../pages/dashboard/settings/sso'),
      api: { getOwnOrgIdpConfig: { config: null } },
      find: byText(/single sign-on/i),
    },
  },
  {
    control: 'SSO setup helpers: service-provider values, IdP metadata import, test connection',
    file: 'pages/dashboard/settings/sso.tsx',
    gateFiles: [
      'src/components/sso/SpValues.tsx',
      'src/components/sso/SamlMetadataImport.tsx',
      'src/components/sso/SsoTestConnection.tsx',
    ],
    // Same page gate as the connection itself; none of these WRITES the
    // connection, so none carries the step-up / assurance the writes do.
    permissions: [],
    pagePermissions: ['org:idp'],
    page: '/dashboard/settings/sso',
    features: ['sso'],
    routes: [
      'platform GET /organization/:id/idp/sp-info',
      'platform POST /organization/:id/idp/metadata/import',
      'platform POST /organization/:id/idp/test',
      'platform POST /organization/:id/idp/test/complete',
    ],
    behaviour: {
      mount: page('../pages/dashboard/settings/sso'),
      api: { getOwnOrgIdpConfig: { config: null } },
      find: byText(/single sign-on/i),
    },
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
    behaviour: {
      // The TAB itself is the gate: `SECURITY_TABS` drops "Service accounts"
      // for anyone without the permission, so it is what must disappear.
      mount: page('../pages/dashboard/security'),
      find: byRole('tab', /service accounts/i),
    },
  },
  {
    control: 'Download logs (.log / .jsonl)',
    file: 'pages/dashboard/logs.tsx',
    permissions: ['logs:export'],
    orgAdminAssurance: true,
    routes: ['platform GET /observability/logs/export'],
    behaviour: { mount: page('../pages/dashboard/logs'), find: button(/^\.log$/i) },
  },
  {
    control: 'Quota usage reads',
    file: 'src/lib/nav.ts',
    permissions: ['quotas:read'],
    routes: ['quota GET /quotas', 'quota GET /quotas/:orgId'],
    behaviour: {
      renders: 'the real <Sidebar/> (see "Pipeline list + detail reads").',
      mount: (ctx) => comp('../src/components/ui/Sidebar', 'Sidebar', {
        isSuperAdmin: false, isAdmin: false, user: ctx.user, unreadCount: 0,
        currentPath: '/dashboard', isDark: false, onToggleDark: () => {}, onLogout: () => {},
      })(),
      find: byRole('link', /^quotas$/i),
    },
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
    behaviour: {
      renders: 'the real <Sidebar/> (see "Pipeline list + detail reads").',
      mount: (ctx) => comp('../src/components/ui/Sidebar', 'Sidebar', {
        isSuperAdmin: false, isAdmin: false, user: ctx.user, unreadCount: 0,
        currentPath: '/dashboard', isDark: false, onToggleDark: () => {}, onLogout: () => {},
      })(),
      find: byRole('link', /^reports$/i),
    },
  },
  // ── Teams, managed from their parent (Members → Teams) ────────────────────
  {
    control: 'Create a team (Members → Create Team)',
    file: 'pages/dashboard/members.tsx',
    permissions: ['org:settings'],
    routes: ['platform POST /organization'],
    behaviour: {
      mount: page('../pages/dashboard/members'),
      hierarchy: { childOrgCount: 1, activeOrg: { id: 'org-1', name: 'Acme', tier: 'team' } },
      find: button(/^create team$/i),
    },
  },
  {
    control: 'Export / delete a team, list and restore deleted teams (Members → Teams)',
    file: 'pages/dashboard/members.tsx',
    gateFiles: ['src/components/teams/TeamsCard.tsx'],
    permissions: ['org:settings'],
    stepUp: true,
    routes: [
      'platform GET /organization/:id/export',
      'platform DELETE /organization/:id/teams/:teamId',
      'platform GET /organization/:id/teams/deleted',
      'platform POST /organization/:id/restore',
    ],
    behaviour: {
      mount: page('../pages/dashboard/members'),
      hierarchy: { childOrgCount: 1, activeOrg: { id: 'org-1', name: 'Acme', tier: 'team' } },
      api: {
        // The live-team list additionally needs `members:manage`; the
        // recently-deleted list is the `org:settings` half, and restoring from
        // it is one of this row's routes.
        getOrganizationTeams: { teams: [] },
        listDeletedTeams: { teams: [{ orgId: 'team-1', orgName: 'Team One', deletedAt: '2026-09-01T00:00:00Z', purgeAfter: '2026-10-01T00:00:00Z' }] },
      },
      find: byText(/^restore$/i),
    },
  },
  {
    control: "Rename a team / edit its two-factor policy (team settings drawer)",
    file: 'src/components/teams/TeamSettingsDrawer.tsx',
    gateFiles: ['src/components/settings/MfaPolicySettings.tsx'],
    permissions: ['org:settings'],
    stepUp: true,
    routes: ['platform PATCH /organization/:id/identity', 'platform PATCH /organization/:id/mfa-policy'],
    behaviour: {
      renders: 'the drawer itself: it opens from a per-team row menu inside TeamsCard, and each section keeps its own `can()` gate.',
      mount: comp('../src/components/teams/TeamSettingsDrawer', 'TeamSettingsDrawer', {
        team: { orgId: 'team-1', orgName: 'Team One' }, onClose: () => {}, onRenamed: () => {},
      }),
      find: button(/^rename team$/i),
    },
  },
  {
    control: "Edit a team's impersonation policy (team settings drawer)",
    file: 'src/components/teams/TeamSettingsDrawer.tsx',
    gateFiles: ['src/components/settings/ImpersonationPolicySettings.tsx'],
    permissions: ['org:impersonation'],
    stepUp: true,
    routes: ['platform PATCH /organization/:id/impersonation-policy'],
    behaviour: {
      renders: 'the drawer itself (see "Rename a team …").',
      mount: comp('../src/components/teams/TeamSettingsDrawer', 'TeamSettingsDrawer', {
        team: { orgId: 'team-1', orgName: 'Team One' }, onClose: () => {}, onRenamed: () => {},
      }),
      find: byText(/^administrator access$/i),
    },
  },
  {
    control: "Connect / edit / disconnect a team's SSO (team settings drawer)",
    file: 'src/components/teams/TeamSettingsDrawer.tsx',
    gateFiles: [
      'src/components/settings/OrgSsoSettings.tsx',
      'src/components/settings/OrgSamlSettings.tsx',
      'src/components/settings/SsoDisconnect.tsx',
    ],
    permissions: ['org:idp'],
    // Enforced inside the handlers (`requireOwnOrgSso`); the drawer renders the
    // `sso` FeatureLock in place of the editors.
    features: ['sso'],
    stepUp: true,
    minAssurance: 2,
    routes: [
      'platform PUT /organization/:id/idp',
      'platform PATCH /organization/:id/idp',
      'platform DELETE /organization/:id/idp',
    ],
    behaviour: {
      renders: 'the drawer itself (see "Rename a team …").',
      mount: comp('../src/components/teams/TeamSettingsDrawer', 'TeamSettingsDrawer', {
        team: { orgId: 'team-1', orgName: 'Team One' }, onClose: () => {}, onRenamed: () => {},
      }),
      api: { getOrgIdpConfig: { config: null }, getOwnOrgIdpConfig: { config: null } },
      find: byText(/single sign-on/i),
    },
  },
  {
    control: 'Move an organization in the hierarchy (sysadmin drill-down)',
    file: 'src/components/admin/org-detail/OrgHierarchyCard.tsx',
    // Sysadmin-only route on a sysadmin-only page.
    permissions: [],
    page: '/dashboard/admin/orgs/[orgId]',
    stepUp: true,
    routes: ['platform POST /organization/:id/move'],
    behaviour: {
      mount: page('../pages/dashboard/admin/orgs/[orgId]'),
      router: { query: { orgId: 'org-2' }, pathname: '/dashboard/admin/orgs/[orgId]' },
      guard: { isSuperAdmin: true },
      gatedOn: 'systemAdmin',
      api: { getOrganization: { organization: ORG_DETAIL } },
      find: button(/^move organization$/i),
    },
  },
  {
    control: "Edit an org's name / slug / description (sysadmin drill-down)",
    file: 'src/components/admin/org-detail/OrgIdentityCard.tsx',
    // Sysadmin-only route (`systemAdmin` in the table) on a sysadmin-only page
    // (`/dashboard/admin/orgs/[orgId]` is `systemAdminOnly` in page-access).
    permissions: [],
    page: '/dashboard/admin/orgs/[orgId]',
    stepUp: true,
    routes: ['platform PUT /organization/:id'],
    behaviour: {
      mount: page('../pages/dashboard/admin/orgs/[orgId]'),
      router: { query: { orgId: 'org-2' }, pathname: '/dashboard/admin/orgs/[orgId]' },
      guard: { isSuperAdmin: true },
      gatedOn: 'systemAdmin',
      api: { getOrganization: { organization: ORG_DETAIL } },
      find: button(/^edit$/i),
    },
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
    behaviour: {
      renders: 'the UNMOCKED DashboardLayout — the launcher is its chrome, so no page owns it.',
      mount: real('../src/components/ui/DashboardLayout', 'DashboardLayout', { title: 'Ask host', children: null }),
      // No permission gates it (see `implicitPermissions`); the entitlement does,
      // and losing the entitlement must swap the button for the upsell lock.
      gatedOn: 'feature',
      find: byRole('button', /^ask$/i),
    },
  },
  {
    control: 'Create a plugin the Ask agent drafted',
    file: 'src/components/ask/AskPanel.tsx',
    permissions: ['plugins:write'],
    // The panel itself is entitlement-gated (see "Ask assistant"), but the
    // COMMIT is an ordinary create: `POST /plugins/deploy-generated` carries no
    // feature gate, only `plugins:write`.
    routes: ['plugin POST /plugins/deploy-generated'],
    behaviour: {
      renders: 'the Ask panel itself — it is opened from the dashboard chrome, so no page owns it.',
      mount: comp('../src/components/ask/AskPanel', 'AskPanel', { onClose: () => {} }),
      api: { askAgentStream: pluginProposalStream },
      // Ask for a plugin and let the agent answer with a draft; identical in
      // both renders (the stream is the same, only `can()` differs).
      reveal: () => {
        fireEvent.change(screen.getByLabelText('Ask a question'), { target: { value: 'draft me a trivy plugin' } });
        fireEvent.click(screen.getByLabelText('Send'));
      },
      // Disabled with the reason: the draft is still worth reading, and hiding
      // the only action on a card the agent just produced reads as a bug.
      absence: 'disabled',
      find: button(/^create plugin$/i),
    },
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
    behaviour: {
      // PERMISSION half, rendered: no `pipelines:write`, no way to open the
      // modal that holds the AI tabs. The ENTITLEMENT half is the same
      // `FeatureLock flag="ai_generation"` the plugin modal renders — that one
      // IS proven by render in "Generate a plugin with AI", and this modal's
      // own lock is checked by the feature-source assertion below.
      mount: page('../pages/dashboard/pipelines'),
      find: button(/^create pipeline$/i),
    },
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
    behaviour: {
      renders: 'the create modal itself (see "Generate a pipeline with AI").',
      mount: comp('../src/components/plugin/CreatePluginModal', 'default', {
        onClose: () => {}, onCreated: () => {}, canPublish: false,
      }),
      gatedOn: 'feature',
      // The tab label always renders; the entitlement decides whether the panel
      // holds the builder or the upsell lock.
      find: byText(/describe your plugin/i),
    },
  },
  {
    control: 'Bulk create / update / delete pipelines',
    file: 'pages/dashboard/pipelines.tsx',
    permissions: ['pipelines:write'],
    features: ['bulk_operations'],
    routes: ['pipeline POST /pipelines/bulk/create', 'pipeline PUT /pipelines/bulk/update', 'pipeline POST /pipelines/bulk/delete'],
    behaviour: {
      // `canBulk` drives `selectable` on the table, so the row checkboxes ARE
      // the control — without them there is no way to start a bulk action.
      mount: page('../pages/dashboard/pipelines'),
      api: { listPipelines: { pipelines: [{ id: 'p1', pipelineName: 'one', project: 'proj', organizationId: 'org-1', visibility: 'private', createdBy: 'u1' }], pagination: { ...EMPTY_PAGE, total: 1 } } },
      find: byRole('checkbox', /select/i),
    },
  },
  {
    control: 'Bulk update / delete plugins',
    file: 'pages/dashboard/plugins.tsx',
    permissions: ['plugins:write', 'plugins:publish'],
    features: ['bulk_operations'],
    routes: ['plugin PUT /plugins/bulk/update', 'plugin POST /plugins/bulk/delete'],
    behaviour: {
      mount: page('../pages/dashboard/plugins'),
      api: { listPlugins: { plugins: [{ id: 'pl1', name: 'one', organizationId: 'org-1', visibility: 'private', createdBy: 'u1' }], pagination: { ...EMPTY_PAGE, total: 1 } } },
      find: byRole('checkbox', /select/i),
    },
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
    behaviour: {
      // Mounted through the page: `enabled` is computed there from the
      // entitlement, so passing it as a prop would test nothing.
      mount: page('../pages/dashboard/reports'),
      router: { query: { tab: 'dora' }, pathname: '/dashboard/reports' },
      gatedOn: 'feature',
      // The non-entitled teaser renders a blurred, aria-hidden copy of the
      // metric tiles, so match on body copy the teaser does not carry.
      find: byText(/deployment-scoped/i),
    },
  },
  {
    control: 'Mark a deployment outcome (DORA change-failure rate)',
    file: 'src/components/reports/tabs/DoraTab.tsx',
    gateFiles: ['pages/dashboard/reports.tsx'],
    // The Reports page passes `hasPermission(user, 'pipelines:write')` rather
    // than `can()`, so a read-only impersonation session still SEES the control.
    permissions: ['pipelines:write'],
    features: ['advanced_reporting'],
    routes: ['reporting POST /reports/deployments/:executionId/outcome'],
    behaviour: {
      renders: 'the Reports page, so the `hasPermission(user, …)` that computes `canMark` really runs.',
      mount: page('../pages/dashboard/reports'),
      router: { query: { tab: 'dora' }, pathname: '/dashboard/reports' },
      api: {
        listPipelines: { pipelines: [{ id: 'p1', pipelineName: 'one', project: 'proj', organizationId: 'org-1' }], pagination: { ...EMPTY_PAGE, total: 1 } },
        listPipelineExecutions: { executions: [{ execution_id: 'e1', status: 'succeeded', started_at: '2026-09-02T00:00:00Z', ended_at: '2026-09-02T00:10:00Z', duration_ms: 600000, failing_stage: null, failing_action: null }] },
      },
      // The deploy list (and so the outcome control) only exists once a single
      // pipeline is scoped.
      reveal: () => fireEvent.change(screen.getByLabelText(/filter dora by pipeline/i), { target: { value: 'p1' } }),
      find: byText(/^outcome$/i),
    },
  },
  {
    control: 'Per-pipeline maturity scorecard',
    file: 'src/components/pipeline/ScorecardCard.tsx',
    permissions: [],
    pagePermissions: ['pipelines:read'],
    page: '/dashboard/pipelines/[id]',
    features: ['advanced_reporting'],
    routes: ['pipeline GET /pipelines/:id/scorecard'],
    behaviour: {
      renders: 'the card in isolation — it is one section of the pipeline detail page.',
      mount: comp('../src/components/pipeline/ScorecardCard', 'ScorecardCard', { pipelineId: 'p1' }),
      gatedOn: 'feature',
      api: { getPipelineScorecard: { scorecard: { grade: 'B', compliance: { score: 80, passed: 4, total: 5 }, dora: {}, signals: [] } } },
      // The heading renders either way — the entitled body is what must go.
      find: byText(/^compliance$/i),
    },
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
    behaviour: {
      mount: page('../pages/dashboard/reports'),
      find: button(/^scorecard$/i),
    },
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
    behaviour: {
      mount: page('../pages/dashboard/settings/incident-reporting'),
      guard: { isAdmin: true, isOrgAdminUser: true },
      gatedOn: 'reports:read',
      api: { getIncidentSettings: { settings: { mode: 'generic' } }, listIncidents: { incidents: [], pagination: EMPTY_PAGE } },
      find: byRole('tab', /test & history/i),
    },
  },
  {
    control: 'Per-team usage breakdown',
    file: 'src/components/billing/TeamUsageCard.tsx',
    permissions: [],
    pagePermissions: ['billing:read'],
    page: '/dashboard/billing',
    features: ['team_usage_analytics'],
    routes: ['billing GET /billing/summary/usage-by-team'],
    behaviour: {
      renders: 'the card in isolation — it is one section of the Billing page.',
      mount: comp('../src/components/billing/TeamUsageCard', 'TeamUsageCard'),
      gatedOn: 'feature',
      // The card only exists for an org WITH teams; the entitlement then decides
      // whether it shows the breakdown or the lock.
      hierarchy: { childOrgCount: 1 },
      api: { getTeamUsage: { teams: [{ orgId: 'team-1', orgName: 'Team One', usage: {} }] } },
      // Only the entitled branch renders the breakdown; the lock branch keeps
      // the heading and nothing else.
      find: byText(/current period/i),
    },
  },
  // ── Plugin ecosystem: the tenant Publisher page ──
  {
    control: 'Create the publisher profile (claim a handle, accept the terms)',
    file: 'src/components/publisher/PublisherProfilePanel.tsx',
    permissions: ['publishers:manage'],
    pagePermissions: ['plugins:read'],
    page: '/dashboard/publisher',
    routes: ['plugin POST /plugins/publisher'],
    behaviour: {
      mount: page('../pages/dashboard/publisher'),
      router: { pathname: '/dashboard/publisher' },
      api: { getPublisher: publisherCtx({ publisher: null }) },
      // The button waits on a handle, a display name and the terms box.
      reveal: () => {
        fireEvent.change(screen.getByLabelText(/^handle/i), { target: { value: 'acme' } });
        fireEvent.change(screen.getByLabelText(/^display name/i), { target: { value: 'Acme' } });
        fireEvent.click(screen.getByRole('checkbox', { name: /accept the publisher terms/i }));
      },
      // Kept on screen (the form explains the permission it needs) but inert.
      absence: 'disabled',
      find: button(/^create publisher$/i),
    },
  },
  {
    control: 'Edit the publisher profile / re-accept changed terms',
    file: 'src/components/publisher/PublisherProfilePanel.tsx',
    permissions: ['publishers:manage'],
    pagePermissions: ['plugins:read'],
    page: '/dashboard/publisher',
    routes: ['plugin PATCH /plugins/publisher', 'plugin POST /plugins/publisher/terms'],
    behaviour: {
      mount: page('../pages/dashboard/publisher'),
      router: { pathname: '/dashboard/publisher' },
      // Terms changed since acceptance: the banner carries the accept action,
      // rendered beside the profile's Save under the same `publishers:manage` check.
      api: { getPublisher: publisherCtx({ terms: { currentVersion: '2', accepted: false } }) },
      find: button(/^accept the new terms$/i),
    },
  },
  {
    control: 'Pause a listing or one of its versions',
    file: 'src/components/publisher/PublisherListingsPanel.tsx',
    permissions: ['plugins:publish'],
    pagePermissions: ['plugins:read'],
    page: '/dashboard/publisher',
    routes: ['plugin POST /plugins/publisher/listings/:listingId/pause'],
    behaviour: {
      mount: page('../pages/dashboard/publisher'),
      router: { pathname: '/dashboard/publisher', query: { tab: 'listings' } },
      api: { getPublisher: publisherCtx(), listPublisherListings: { listings: [ECO_LISTING] } },
      find: button(/^pause eslint$/i),
    },
  },
  {
    control: 'Submit a publish request (yank / unpause / listing update / new listing or version)',
    file: 'src/components/publisher/PublisherListingsPanel.tsx',
    gateFiles: ['pages/dashboard/publisher.tsx', 'src/components/publisher/PublisherProfilePanel.tsx'],
    // The route admits `plugins:publish` OR `publishers:manage` and checks the
    // kind's own permission in the handler; this row proves the publish half
    // (the yank request), the profile rows prove the manage half.
    permissions: ['plugins:publish'],
    pagePermissions: ['plugins:read'],
    page: '/dashboard/publisher',
    routes: ['plugin POST /plugins/publish-requests'],
    behaviour: {
      mount: page('../pages/dashboard/publisher'),
      router: { pathname: '/dashboard/publisher', query: { tab: 'listings' } },
      api: { getPublisher: publisherCtx(), listPublisherListings: { listings: [ECO_LISTING] } },
      find: button(/^request yank of eslint v1\.0\.0$/i),
    },
  },
  {
    control: 'Withdraw an open publish request',
    file: 'src/components/publisher/PublishRequestsPanel.tsx',
    // A new-listing request is withdrawn under `plugins:publish`; the route
    // admits either permission and re-checks the kind in the handler.
    permissions: ['plugins:publish'],
    pagePermissions: ['plugins:read'],
    page: '/dashboard/publisher',
    routes: ['plugin POST /plugins/publish-requests/:id/withdraw'],
    behaviour: {
      mount: page('../pages/dashboard/publisher'),
      router: { pathname: '/dashboard/publisher', query: { tab: 'requests' } },
      api: { getPublisher: publisherCtx(), listPublishRequests: { requests: [ECO_REQUEST] }, listIncomingTransfers: { requests: [] } },
      find: button(/^withdraw new listing request/i),
    },
  },
  {
    control: 'Accept / decline an incoming listing transfer',
    file: 'src/components/publisher/PublishRequestsPanel.tsx',
    permissions: ['publishers:manage'],
    pagePermissions: ['plugins:read'],
    page: '/dashboard/publisher',
    stepUp: true,
    routes: ['plugin POST /plugins/publish-requests/:id/transfer-response'],
    behaviour: {
      mount: page('../pages/dashboard/publisher'),
      router: { pathname: '/dashboard/publisher', query: { tab: 'requests' } },
      api: {
        getPublisher: publisherCtx(),
        listPublishRequests: { requests: [] },
        listIncomingTransfers: { requests: [{
          ...ECO_REQUEST, id: 't1', kind: 'transfer', publisherHandle: 'other',
          payload: { transfer: { targetPublisherId: 'pub1', targetOrgId: 'org-1', response: 'pending' } },
        }] },
      },
      find: button(/^accept$/i),
    },
  },
  // ── Plugin ecosystem: the system org's Ecosystem console ──
  {
    control: 'Ecosystem console: review, approve / second-approve / reject a publish request',
    file: 'src/components/ecosystem/PublishQueuePanel.tsx',
    // Every route admits `plugins:moderate` OR `publishers:verify`; the panel
    // shows the decision only to holders of the item's `requiredPermission`
    // (here `plugins:moderate`). Step-up is asked per request KIND by the
    // handler (the item's `requiresStepUp`), not at the route.
    permissions: ['plugins:moderate'],
    minAssurance: 2,
    routes: [
      'plugin GET /plugins/ecosystem/overview',
      'plugin GET /plugins/ecosystem/requests',
      'plugin GET /plugins/ecosystem/requests/:id',
      'plugin POST /plugins/ecosystem/requests/:id/approve',
      'plugin POST /plugins/ecosystem/requests/:id/second-approve',
      'plugin POST /plugins/ecosystem/requests/:id/reject',
    ],
    behaviour: {
      renders: ECO_PANEL_RENDERS,
      mount: ecoPanel('../src/components/ecosystem/PublishQueuePanel', 'PublishQueuePanel'),
      api: {
        getEcosystemOverview: ECO_OVERVIEW,
        listEcosystemRequests: { requests: [ECO_QUEUE_ITEM] },
        getEcosystemRequest: { request: ECO_QUEUE_ITEM, review: ECO_REVIEW, approvers: ECO_APPROVERS, eligibility: null },
      },
      // Opening the review is a read anyone in the console may do.
      reveal: () => fireEvent.click(screen.getByRole('button', { name: /^review/i })),
      find: button(/^approve$/i),
    },
  },
  {
    control: 'Ecosystem console: suspend / unsuspend a publisher, change its tier',
    file: 'src/components/ecosystem/PublisherVerificationPanel.tsx',
    permissions: ['publishers:verify'],
    stepUp: true,
    minAssurance: 2,
    routes: [
      'plugin GET /plugins/ecosystem/publishers',
      'plugin POST /plugins/ecosystem/publishers/:id/suspend',
      'plugin POST /plugins/ecosystem/publishers/:id/unsuspend',
      'plugin POST /plugins/ecosystem/publishers/:id/tier',
    ],
    behaviour: {
      renders: ECO_PANEL_RENDERS,
      mount: ecoPanel('../src/components/ecosystem/PublisherVerificationPanel', 'PublisherVerificationPanel'),
      api: {
        listEcosystemRequests: { requests: [] },
        listEcosystemPublishers: { publishers: [{ ...ECO_PUBLISHER, listingCount: 1 }] },
      },
      find: button(/^suspend acme$/i),
    },
  },
  {
    control: 'Ecosystem console: set a listing state, yank / request unyank a version, re-sign published images',
    file: 'src/components/ecosystem/ListingStatePanel.tsx',
    permissions: ['plugins:moderate'],
    stepUp: true,
    minAssurance: 2,
    routes: [
      'plugin GET /plugins/ecosystem/listings',
      'plugin POST /plugins/ecosystem/listings/:id/state',
      'plugin POST /plugins/ecosystem/listings/:id/versions/:version/yank',
      'plugin POST /plugins/ecosystem/listings/:id/versions/:version/unyank',
      // "Re-sign all published images" sits in the same panel's header, behind the same check.
      'plugin POST /plugins/ecosystem/resign',
    ],
    behaviour: {
      renders: ECO_PANEL_RENDERS,
      mount: ecoPanel('../src/components/ecosystem/ListingStatePanel', 'ListingStatePanel'),
      api: { listEcosystemListings: { listings: [ECO_LISTING] } },
      find: button(/^yank eslint v1\.0\.0$/i),
    },
  },
  {
    control: 'Ecosystem console: create / edit / disable / delete an auto-approval rule, approve its change',
    file: 'src/components/ecosystem/AutoApprovalRulesPanel.tsx',
    permissions: ['plugins:moderate'],
    stepUp: true,
    minAssurance: 2,
    routes: [
      'plugin GET /plugins/ecosystem/rules',
      'plugin POST /plugins/ecosystem/rules',
      'plugin PATCH /plugins/ecosystem/rules/:id',
      'plugin DELETE /plugins/ecosystem/rules/:id',
      'plugin POST /plugins/ecosystem/rules/:id/approve-change',
    ],
    behaviour: {
      renders: ECO_PANEL_RENDERS,
      mount: ecoPanel('../src/components/ecosystem/AutoApprovalRulesPanel', 'AutoApprovalRulesPanel', { currentUserId: 'u1' }),
      api: { listAutoRules: { rules: [] } },
      find: button(/new rule/i),
    },
  },
  {
    control: 'Ecosystem console: reserve / release a handle or listing name',
    file: 'src/components/ecosystem/ReservedNamesPanel.tsx',
    permissions: ['plugins:moderate'],
    minAssurance: 2,
    routes: [
      'plugin GET /plugins/ecosystem/reserved-names',
      'plugin PUT /plugins/ecosystem/reserved-names/:name',
      'plugin DELETE /plugins/ecosystem/reserved-names/:name',
    ],
    behaviour: {
      renders: ECO_PANEL_RENDERS,
      mount: ecoPanel('../src/components/ecosystem/ReservedNamesPanel', 'ReservedNamesPanel'),
      api: {
        listReservedNames: { names: [{ name: 'trivy', reason: 'Vendor', publisherId: null, createdAt: '2026-09-01T00:00:00Z' }] },
        listEcosystemPublishers: { publishers: [] },
      },
      find: button(/^remove reserved name trivy$/i),
    },
  },
];


/** Everything a holder of this control's declared gates would have. */
function heldBy(control: Control): string[] {
  return [
    ...control.permissions,
    ...(control.pagePermissions ?? []),
    ...(control.implicitPermissions ?? []).map((p) => p.permission),
  ];
}

/** What the negative render takes away, and how that refusal reaches the page. */
function negativeCase(control: Control): { gatedOn: GatedOn; guard: Partial<PageAuthGuard> } {
  const b = control.behaviour;
  const gatedOn = b.gatedOn ?? control.permissions[0] ?? control.pagePermissions?.[0];
  if (!gatedOn) throw new Error(`${control.control}: behaviour needs a \`gatedOn\` (the row declares no permission)`);
  // A role gate, or a permission the PAGE (not the control) enforces, refuses
  // before render: the auth guard reports `accessDenied` and the page renders
  // AccessDenied instead of its body. A permission the control checks inline
  // just makes `can()` false.
  if (gatedOn === 'feature') return { gatedOn, guard: {} };
  if (gatedOn === 'systemAdmin') return { gatedOn, guard: { isSuperAdmin: false, accessDenied: { kind: 'systemAdmin', pathname: control.page ?? '/' } } };
  if (gatedOn === 'admin') return { gatedOn, guard: { isAdmin: false, isOrgAdminUser: false, accessDenied: { kind: 'admin', pathname: control.page ?? '/' } } };
  if ((control.pagePermissions ?? []).includes(gatedOn)) {
    return { gatedOn, guard: { accessDenied: { kind: 'permission', permission: gatedOn, pathname: control.page ?? '/' } } };
  }
  return { gatedOn, guard: {} };
}

describe('a mapped control is really gated — rendered with and without the permission', () => {
  afterEach(() => cleanup());

  it.each(CONTROLS.map((c) => [c.control, c] as const))('%s', async (_name, control) => {
    const b = control.behaviour;
    const held = heldBy(control);
    const { gatedOn, guard } = negativeCase(control);

    // 1. A viewer holding the gate SEES the control.
    await renderCase(b, (p) => held.includes(p), {});
    const shown = b.find();
    if (shown && b.absence === 'disabled') {
      expect({ control: control.control, enabledForHolder: !(shown as HTMLButtonElement).disabled })
        .toEqual({ control: control.control, enabledForHolder: true });
    }
    if (!shown) {
      const seen = [...screen.queryAllByRole('button'), ...screen.queryAllByRole('link'), ...screen.queryAllByRole('tab')]
        .map((e) => e.textContent?.trim()).filter(Boolean);
      throw new Error(`${control.control}: not rendered for a viewer holding [${held.join(', ')}]. Rendered controls: ${seen.join(' | ') || '(none)'}`);
    }
    cleanup();

    // 2. The same viewer WITHOUT it does not — the point the old source grep
    // could not make.
    await renderCase(b, (p) => held.includes(p) && p !== gatedOn, guard, gatedOn !== 'feature');
    const after = b.find();
    if (b.absence === 'disabled') {
      // Deliberately still on screen — but inert, so the click cannot 403.
      expect({ control: control.control, withheld: gatedOn, present: !!after, inert: !!after && (after as HTMLButtonElement).disabled })
        .toEqual({ control: control.control, withheld: gatedOn, present: true, inert: true });
    } else {
      expect({ control: control.control, withheld: gatedOn, stillRendered: after?.textContent?.trim() ?? null })
        .toEqual({ control: control.control, withheld: gatedOn, stillRendered: null });
    }
  });

  it('covers every mapped control', () => {
    expect(CONTROLS.filter((c) => !c.behaviour).map((c) => c.control)).toEqual([]);
    expect(CONTROLS.length).toBeGreaterThan(50);
  });
});

// ── Every write route is accounted for ─────────────────────────────────────
/**
 * The other half of the mapping. A route that WRITES must be either driven by a
 * mapped control above or given a disposition here: a named category plus the
 * reason, found by looking, not by guessing. A new write route fails the suite
 * by name until someone decides which it is.
 *
 * `same-control` additionally names the CONTROLS row whose render-with /
 * render-without proof covers the SAME gate, and that name is checked against
 * the mapping — so the category cannot be used as a rubber stamp for a gate
 * nothing proves.
 */
type Category =
  /** Internal service-principal route; no user token ever reaches it. */
  | 'machine-only'
  /** Driven by a scoped machine credential (a SCIM key, an ingest token). */
  | 'machine-credential'
  /** An external system POSTs straight to the backend; no frontend code runs. */
  | 'external-callback'
  /** A sign-in / sign-up / invite / device surface, driven before any permission exists. */
  | 'pre-session'
  /** Session lifecycle driven by app chrome or the fetch core, not by a gated control. */
  | 'session-plumbing'
  /** The viewer acting on their OWN account; no org permission applies. */
  | 'own-account'
  /** Soft-delete restore / purge panels, covered by the global step-up resume. */
  | 'step-up-resume'
  /** A control on a `systemAdminOnly` page (a sysadmin holds every permission). */
  | 'sysadmin-console'
  /** Driven by a control whose gate a mapped row already proves behaviourally. */
  | 'same-control'
  /** NOTHING in the dashboard calls it — a CLI / CDK / operator surface. */
  | 'no-ui';

interface Disposition {
  category: Category;
  /** The control and its gate, or why no control exists. Names a file when there is one. */
  why: string;
  /** Required by `same-control`: the CONTROLS row proving that gate. */
  coveredBy?: string;
}

/** Shorthand for a group of routes that share one disposition. */
function group(service: string, routes: string[], d: Disposition): Record<string, Disposition> {
  return Object.fromEntries(routes.map((r) => [`${service} ${r}`, d]));
}

const ROUTE_DISPOSITIONS: Record<string, Disposition> = {
  // ── Plugin ecosystem ──────────────────────────────────────────────────────
  'image-registry DELETE /internal/quarantine/:submissionId': {
    category: 'machine-only',
    why: 'Service-principal route (callers: plugin): the plugin service drops a rejected / expired anonymous submission\'s quarantine/<id> image; no user token is admitted.',
  },
  ...group('plugin', [
    'POST /public/plugin-submissions',
    'POST /public/plugin-submissions/inspect',
    'POST /public/plugin-submissions/verify',
  ], {
    category: 'pre-session',
    why: 'Anonymous plugin submission: the not-signed-in submit and verify pages (src/lib/api/domains/plugin-submissions.ts) drive them with a proof-of-work and a magic link; there is no session, so no permission applies. Quarantine only — nothing is published without the two-person console decision.',
  }),
  ...group('plugin', [
    'GET /plugins/ecosystem/requests/:id/submission-sbom',
    'GET /plugins/ecosystem/requests/:id/submission-scan',
  ], {
    category: 'same-control',
    why: 'The SBOM / scan links in a submission request\'s review (src/components/ecosystem/SubmissionReviewSection.tsx, from the request detail\'s sbomUrl / scanUrl), shown only inside the Ecosystem console review the mapped row gates on plugins:moderate + aal2.',
    coveredBy: 'Ecosystem console: review, approve / second-approve / reject a publish request',
  }),
  'platform GET /admin/console-check': {
    category: 'no-ui',
    why: 'nginx auth_request target on the AWS gateway (deploy/aws/*/nginx/admin-uis.conf): every request to /pgadmin/ /mongo-express/ /grafana/ /kiali/ is checked here (sysadmin + aal2) before it is proxied. No dashboard code calls it; the browser only carries the pb_admin_console cookie nginx turns into the bearer.',
  },
  'platform GET /internal/notify-email/status': {
    category: 'machine-only',
    why: 'Service-principal route (callers: plugin): the plugin service asks whether outbound email is configured before it enables anonymous submissions; no user token is admitted.',
  },
  // A signed-in person's OWN review of a listing: write, edit, delete, vote
  // helpful, report. `plugins:read` + a human session; the controls are on the
  // public plugin page's Reviews tab (src/components/reviews/ReviewsSection.tsx,
  // ReviewItem.tsx), shown to any signed-in viewer.
  ...group('plugin', [
    'POST /plugins/listings/:publisher/:name/reviews',
    'PATCH /plugins/reviews/:id',
    'DELETE /plugins/reviews/:id',
    'PUT /plugins/reviews/:id/helpful',
    'DELETE /plugins/reviews/:id/helpful',
    'POST /plugins/reviews/:id/report',
  ], { category: 'own-account', why: 'The viewer\'s own review, helpful vote or report on the public plugin page (src/components/reviews/ReviewsSection.tsx / ReviewItem.tsx): plugins:read plus a human session; the server refuses self-promotion (REVIEW_SELF_PROMOTION).' }),
  ...group('plugin', [
    'PUT /plugins/reviews/:id/reply',
    'DELETE /plugins/reviews/:id/reply',
  ], {
    category: 'same-control',
    coveredBy: 'Edit the publisher profile / re-accept changed terms',
    why: 'Reply / delete reply on the public plugin page (src/components/reviews/ReviewItem.tsx) shows only when review-state returns canReply, which the server derives from publishers:manage in the listing\'s publisher org — the gate the profile-edit row proves.',
  }),
  'plugin POST /plugins/publisher/listings/:listingId/deprecate': {
    category: 'same-control',
    coveredBy: 'Pause a listing or one of its versions',
    why: 'Deprecate a listed version from the Publisher page\'s Listings tab (src/components/publisher/PublisherListingsPanel.tsx), under the same plugins:publish check as its Pause button.',
  },
  // Ecosystem console panels that sit behind the same `can('plugins:moderate')`
  // check as the publish queue (system org, aal2).
  ...group('plugin', [
    'GET /plugins/ecosystem/reviews',
    'POST /plugins/ecosystem/reviews/:id/hold',
    'POST /plugins/ecosystem/reviews/:id/release',
    'POST /plugins/ecosystem/reviews/:id/remove',
    'POST /plugins/ecosystem/reviews/:id/remove-reply',
  ], {
    category: 'same-control',
    coveredBy: 'Ecosystem console: review, approve / second-approve / reject a publish request',
    why: 'Ecosystem console → Review moderation (src/components/ecosystem/ReviewModerationPanel.tsx) acts only when can(\'plugins:moderate\'), the gate the publish-queue row proves; the routes add requireSystemOrg and aal2.',
  }),
  ...group('plugin', [
    'GET /plugins/ecosystem/advisories',
    'POST /plugins/ecosystem/advisories',
    'PATCH /plugins/ecosystem/advisories/:id',
    'POST /plugins/ecosystem/advisories/:id/withdraw',
  ], {
    category: 'same-control',
    coveredBy: 'Ecosystem console: review, approve / second-approve / reject a publish request',
    why: 'Ecosystem console → Advisories (src/components/ecosystem/AdvisoriesPanel.tsx) acts only when can(\'plugins:moderate\'), the gate the publish-queue row proves; writes add a step-up (AdvisoryFormDialog), system org and aal2.',
  }),
  'plugin POST /plugins/ecosystem/listings/:id/versions/:version/deprecate': {
    category: 'same-control',
    coveredBy: 'Ecosystem console: set a listing state, yank / request unyank a version, re-sign published images',
    why: 'Deprecate a version from Ecosystem console → Listings (src/components/ecosystem/ListingStatePanel.tsx), behind the same can(\'plugins:moderate\') and step-up as the yank control that row proves.',
  },
  // ── Internal, service-principal only ──────────────────────────────────────
  ...group('compliance', [
    'PUT /compliance/entitlements/:orgId',
    'POST /compliance/events/entity',
    'POST /compliance/subscriptions/auto-subscribe',
  ], { category: 'machine-only', why: 'Service-principal route (billing / pipeline / plugin / platform call it); the route table lists its internal callers and no user token is admitted.' }),
  ...group('message', [
    'POST /messages/internal/notify',
    'DELETE /messages/internal/org/:orgId/attachments',
  ], { category: 'machine-only', why: 'Service-principal route called by platform (notifications, org purge); no user token is admitted.' }),
  ...group('platform', [
    'POST /audit/events',
    'POST /internal/notify-email',
  ], { category: 'machine-only', why: 'Service-principal route: every service spools audit events here, and compliance posts notification email; no user token is admitted.' }),
  ...group('platform', [
    'GET /internal/ecosystem/approvers',
    'GET /internal/ecosystem/publisher-eligibility/:orgId',
  ], { category: 'machine-only', why: 'Internal route (callers: plugin): the plugin ecosystem reads the Ecosystem Manager approver count and a Verified applicant\'s verified domains / owner MFA; no user token is admitted.' }),
  ...group('quota', [
    'POST /quotas/:orgId/decrement',
    'POST /quotas/:orgId/increment',
  ], { category: 'machine-only', why: 'Service-principal quota accounting called by every service on a write; no user token is admitted.' }),
  ...group('image-registry', [
    'POST /internal/plugin-publications',
    'POST /internal/plugin-publications/resign',
    'POST /internal/plugin-publications/yank',
    'POST /internal/plugin-publications/retag',
    'POST /internal/plugin-publications/gc',
    'GET /internal/plugin-publications/verify',
    'POST /internal/plugin-publications/verify-cache/invalidate',
  ], { category: 'machine-only', why: 'Service-principal route: the plugin service drives the public/* namespace (publish = copy + fresh sign with tier annotations, resign, yank, gc, verify) when the system org decides a publish request; no user token is admitted.' }),
  'image-registry POST /internal/plugin-signatures': { category: 'machine-only', why: 'Service-principal route: the plugin build worker asks image-registry (the plugin-signing key\'s only holder) to sign + SBOM-attest each pushed image; no user token is admitted.' },
  'reporting PUT /reports/retention-sync/:orgId': { category: 'machine-only', why: 'Service-principal route: billing pushes the org\'s effective retention here when a plan or retention pack changes.' },
  'reporting GET /reports/retention-sync/:orgId': { category: 'machine-only', why: 'Service-principal route (callers: billing): the entitlement drift reconciler (api/billing/src/helpers/entitlement-drift.ts) reads the retention reporting enforces to compare it with the plan; no user token is admitted.' },
  'image-registry POST /internal/quarantine/:submissionId/credential': { category: 'machine-only', why: 'Service-principal route (callers: plugin): api/plugin/src/services/ecosystem/registry.ts asks for a short-lived, registry-only pull credential scoped to one anonymous submission\'s quarantine image, for the submission build; no user token is admitted.' },
  'plugin GET /internal/plugins/public-names': { category: 'machine-only', why: 'Service-principal route (callers: image-registry): api/image-registry/src/services/parent-public-plugins.ts reads the names of an org\'s live public plugins — the only repositories of its namespace its teams may pull (E22); no user token is admitted.' },

  // ── Machine credentials: a scoped key, never a session ────────────────────
  ...group('platform', [
    'GET /scim/v2/Users', 'POST /scim/v2/Users', 'GET /scim/v2/Users/:id', 'PUT /scim/v2/Users/:id',
    'PATCH /scim/v2/Users/:id', 'DELETE /scim/v2/Users/:id',
    'GET /scim/v2/Groups', 'POST /scim/v2/Groups', 'GET /scim/v2/Groups/:id', 'PUT /scim/v2/Groups/:id',
    'PATCH /scim/v2/Groups/:id', 'DELETE /scim/v2/Groups/:id',
    'GET /scim/v2/Schemas', 'GET /scim/v2/ResourceTypes', 'GET /scim/v2/ServiceProviderConfig',
  ], { category: 'machine-credential', why: 'SCIM 2.0 — called by the customer\'s IdP with a `scim`-scoped service-account key. The dashboard mints the key (mapped above) but never calls SCIM.' }),
  ...group('reporting', [
    'POST /reports/events', 'POST /reports/incidents', 'POST /reports/incidents/alertmanager', 'POST /reports/ingest-health',
  ], { category: 'machine-credential', why: 'Ingest endpoint — called by CI / Alertmanager with a `reporting:ingest`-scoped token, never by a browser session.' }),

  // ── External systems POST straight to the backend ─────────────────────────
  'billing POST /billing/stripe/webhook': { category: 'external-callback', why: 'Stripe → backend, signature-verified over the raw body. Nothing in the frontend references it.' },
  'billing POST /billing/marketplace/sns': { category: 'external-callback', why: 'AWS SNS → backend (Marketplace entitlement notifications). Nothing in the frontend references it.' },
  'platform POST /auth/sso/:orgId/saml/acs': { category: 'external-callback', why: 'The IdP form-POSTs the SAML assertion to this SERVER endpoint; the browser never runs frontend code for it (pages/auth/sso/[orgId]/saml.tsx documents exactly this, and redeems the resulting handoff instead).' },
  'platform POST /auth/sso/:orgId/saml/slo': { category: 'external-callback', why: 'IdP-initiated single logout: an IdP form POST to the backend. The dashboard-initiated leg is POST /auth/sso/logout, which api.logout() fires.' },
  'platform POST /observability/alert-webhook': { category: 'external-callback', why: 'Inbound webhook from an external alert source; no frontend reference exists.' },

  // ── Pre-session: the sign-in / sign-up / invite / device surfaces ─────────
  'platform POST /auth/login': { category: 'pre-session', why: 'Sign-in form (src/components/landing/LandingPage.tsx via useAuth.login).' },
  'platform POST /auth/register': { category: 'pre-session', why: 'Sign-up form (pages/auth/register.tsx via useAuth.register).' },
  'platform POST /auth/mfa/verify': { category: 'pre-session', why: 'Second leg of the sign-in form (TOTP / recovery code) — holds only the challengeId.' },
  'platform POST /auth/password/change-required': { category: 'pre-session', why: 'Sign-in form\'s "your password no longer meets policy" step (LandingPage.tsx).' },
  'platform POST /auth/verify-email': { category: 'pre-session', why: 'pages/auth/verify-email.tsx fires it on mount from the emailed ?token=; single-use.' },
  'platform POST /auth/oauth/:provider/callback': { category: 'pre-session', why: 'pages/auth/callback/[provider].tsx POSTs the code/state the provider redirected the browser back with.' },
  'platform POST /auth/sso/start': { category: 'pre-session', why: '"Continue with single sign-on" on the sign-in form, once the typed email resolves to an SSO org.' },
  'platform POST /auth/sso/discover': { category: 'pre-session', why: 'Debounced email-domain probe on the sign-in form that decides whether to offer SSO.' },
  'platform POST /auth/sso/:orgId/callback': { category: 'pre-session', why: 'pages/auth/sso/[orgId]/callback.tsx POSTs the OIDC code/state (the IdP only redirects the browser to that page).' },
  'platform POST /auth/sso/:orgId/saml/complete': { category: 'pre-session', why: 'pages/auth/sso/[orgId]/saml.tsx redeems the single-use ?handoff= the backend put in the redirect; redeeming is what mints the session in this browser.' },
  'platform POST /auth/webauthn/login/options': { category: 'pre-session', why: 'Passkey sign-in on the landing page (conditional-UI autofill and the explicit button).' },
  'platform POST /auth/webauthn/login/verify': { category: 'pre-session', why: 'Completion of the same passkey sign-in ceremony.' },
  'platform POST /invitation/accept': { category: 'pre-session', why: '"Accept invitation" on pages/invite/accept.tsx; authenticated but ungated — the backend matches the invite email against the caller.' },
  'platform POST /invitation/accept-oauth': { category: 'pre-session', why: 'pages/auth/callback/[provider].tsx completes an invite whose OAuth state is kind:"invite".' },
  'billing POST /billing/marketplace/resolve': { category: 'pre-session', why: 'pages/marketplace/register.tsx fires it on mount from the x-amzn-marketplace-token; the authenticated leg is POST /billing/marketplace/claim.' },
  ...group('platform', ['POST /auth/onboarding/complete', 'POST /auth/onboarding/join'], {
    category: 'pre-session',
    why: 'pages/dashboard/onboarding.tsx — the first-run wizard, and (for /join) the durable "join an organization" surface the same page serves once onboarded. Neither is gatable: the target org is one the caller is NOT yet in, so there is no permission there to hold. Eligibility is re-derived server-side from the caller\'s verified email domain, never from the request.',
  }),
  'platform POST /auth/device/deny': { category: 'pre-session', why: '"Deny" on the CLI device-approval page (pages/auth/device.tsx); deliberately NOT step-up gated — approve is.' },

  // ── Session plumbing: chrome and the fetch core, not a gated control ──────
  'platform POST /auth/refresh': { category: 'session-plumbing', why: 'The fetch core alone (src/lib/api/core.ts): proactive pre-expiry timer, pre-request check and the one-shot 401 retry. No UI.' },
  'platform POST /auth/logout': { category: 'session-plumbing', why: 'User-menu sign-out (DashboardLayout → useAuth.logout) and the forced sign-out in MfaRequiredDialog.' },
  'platform POST /auth/sso/logout': { category: 'session-plumbing', why: 'Fired best-effort inside api.logout() before the local logout; no separate control.' },
  'platform POST /auth/switch-org': { category: 'session-plumbing', why: 'Org-switcher dropdown (src/components/ui/OrgSwitcher.tsx) and "switch to this team" on the Members page; membership is enforced server-side.' },
  ...group('platform', [
    'POST /auth/step-up', 'POST /auth/step-up/reauth', 'POST /auth/step-up/reauth/callback',
    'POST /auth/step-up/totp', 'POST /auth/step-up/webauthn/options', 'POST /auth/step-up/webauthn/verify',
  ], { category: 'session-plumbing', why: 'The step-up modal itself (src/components/admin/StepUpModal.tsx + src/lib/step-up-reauth.ts / passkeys.ts). The modal IS the gate for whatever action opened it; these legs carry no permission of their own.' }),
  'platform POST /auth/send-verification': { category: 'session-plumbing', why: '"Resend verification email" beside the unverified-email badge on Settings → Profile.' },
  'platform POST /auth/mark-email-verified': { category: 'session-plumbing', why: 'Settings → Profile, gated in the UI on isSuperAdmin (the backend requires superadmin too) rather than on a permission id.' },
  'plugin POST /logs/ticket': { category: 'session-plumbing', why: 'SSE ticket minted by src/hooks/useBuildStatus.ts once a build requestId exists; no permission gate on either side, and it is reachable only after the plugins:write-gated create flow.' },

  // ── The viewer acting on their own account ───────────────────────────────
  'platform POST /auth/totp/activate': { category: 'own-account', why: 'Authenticator-app enrolment card (src/components/settings/TotpSection.tsx); the preceding /auth/totp/enrol is the step-up gated leg.' },
  'platform PATCH /auth/webauthn/credentials/:id': { category: 'own-account', why: 'Inline passkey rename (src/components/settings/PasskeySection.tsx); rename is deliberately not step-up gated, delete is.' },
  'platform POST /auth/webauthn/register/verify': { category: 'own-account', why: 'Completion of "Add a passkey"; the options leg carries the step-up token.' },
  'platform DELETE /user/keys/:id': { category: 'own-account', why: '"Revoke" on your own access key (src/components/settings/AccessKeysSection.tsx). The same row routes a SERVICE-ACCOUNT key to revokeServiceAccountKey, which is service_accounts:manage gated.' },
  'platform PUT /user/preferences': { category: 'own-account', why: 'The "mute quota warnings" toggle (pages/dashboard/notifications.tsx) and the plugin favourites star; both are personal preferences.' },
  ...group('platform', [
    'POST /user/mfa-prompt/snooze',
    'POST /user/mfa-prompt/decline',
    'DELETE /user/mfa-prompt',
  ], {
    category: 'own-account',
    why: 'The "not now" / "don\'t ask again" buttons on the password-only banner (src/components/ui/MfaEnrolmentNudge.tsx) and "Remind me again" on Security → Factors (src/components/settings/MfaPromptPreference.tsx). Own account and deliberately ungated: all three decide only whether the shell offers to help this person enrol, never what their session may do — so there is no permission to hold and step-up would cost more than the question does.',
  }),
  'platform PATCH /user/profile': { category: 'own-account', why: '"Save changes" on Settings → Profile; own account, so only the read-only-impersonation notice applies.' },
  'platform POST /user/change-password': { category: 'own-account', why: 'Profile → password section; step-up only (the user is acting on their own account).' },
  'platform DELETE /user/account': { category: 'own-account', why: '"Delete account" on Settings → Profile; own account, so step-up is the only gate.' },
  'platform POST /user/keys': { category: 'own-account', why: 'Profile → access keys; step-up, plus the org\'s admin-actions MFA policy (only a person may mint a key while it is on).' },
  'platform POST /auth/recovery-codes': { category: 'own-account', why: 'Profile → recovery codes (Passkeys / Authenticator panels); step-up only.' },
  'platform DELETE /user/sessions/:id': { category: 'own-account', why: 'Revoke one of your own sessions (Security → Sessions); step-up is the only gate.' },
  'platform POST /user/tokens/revoke-all': { category: 'own-account', why: '"Revoke all tokens" in Security → Keys; own account, so step-up is the only gate.' },
  'platform POST /auth/totp/enrol': { category: 'own-account', why: 'Authenticator-app enrol / remove in Security → Factors; step-up is the only gate.' },
  'platform DELETE /auth/totp': { category: 'own-account', why: 'Authenticator-app enrol / remove in Security → Factors; step-up is the only gate.' },
  'platform POST /auth/webauthn/register/options': { category: 'own-account', why: 'Passkey add / remove in Security → Factors; own account, so step-up is the only gate.' },
  'platform DELETE /auth/webauthn/credentials/:id': { category: 'own-account', why: 'Passkey add / remove in Security → Factors; own account, so step-up is the only gate.' },
  'platform POST /auth/device/approve': { category: 'own-account', why: 'CLI device-approval page; step-up only (the approval IS the authorization).' },
  ...group('platform', ['POST /admin/impersonate/requests/:id/decide', 'POST /admin/impersonate/requests/:id/revoke'], {
    category: 'own-account',
    why: 'Approve / Deny / End session on pages/dashboard/access-requests.tsx — the SUBJECT consenting to (or ending) access to their own data. The page is deliberately ungated in nav.ts because the person being impersonated is usually not an admin; the server scopes the list to them.',
  }),

  // ── Soft-delete restore / purge, covered by the global step-up resume ─────
  // The pipelines pair IS mapped above; the rest are the same panel on their own
  // page, gated by that page's `:write` permission plus the global resume.
  ...group('pipeline', ['POST /pipeline-templates/:id/restore', 'POST /pipeline-templates/:id/purge'], {
    category: 'step-up-resume', why: 'Recently-deleted panel on the Templates page (templates:write) + global step-up resume.',
  }),
  ...group('plugin', ['POST /plugins/:id/restore', 'POST /plugins/:id/purge'], {
    category: 'step-up-resume', why: 'Recently-deleted panel on the Plugins page (plugins:write) + global step-up resume.',
  }),
  ...group('compliance', [
    'POST /compliance/rules/:id/restore', 'POST /compliance/rules/:id/purge',
    'POST /compliance/policies/:id/restore', 'POST /compliance/policies/:id/purge',
  ], { category: 'step-up-resume', why: 'Recently-deleted panel on the Compliance page (compliance:write) + global step-up resume.' }),
  ...group('message', ['POST /messages/:id/restore', 'POST /messages/:id/purge'], {
    category: 'step-up-resume', why: 'Recently-deleted panel on the Messages page (messages:write) + global step-up resume.',
  }),
  ...group('platform', ['POST /dashboards/:id/restore', 'POST /dashboards/:id/purge'], {
    category: 'step-up-resume', why: 'Recently-deleted panel on the Observability pages (dashboards:write) + global step-up resume.',
  }),
  ...group('platform', [
    'POST /observability/alert-rules/:id/restore', 'POST /observability/alert-rules/:id/purge',
    'POST /observability/alert-destinations/:id/restore', 'POST /observability/alert-destinations/:id/purge',
  ], { category: 'step-up-resume', why: 'Recently-deleted panel on the alert-rules / alert-destinations pages (observability:write) + global step-up resume.' }),

  // ── Sysadmin consoles ────────────────────────────────────────────────────
  // Every page here is `systemAdminOnly` in src/lib/page-access.ts, and a
  // sysadmin satisfies `hasPermission` for every id — so a route asking for a
  // permission is still satisfied by the operator holding the page.
  ...group('billing', [
    'POST /billing/admin/discounts', 'PUT /billing/admin/discounts/:id', 'DELETE /billing/admin/discounts/:id',
    'POST /billing/admin/discounts/:id/apply', 'POST /billing/admin/discounts/:id/preview',
    'POST /billing/admin/discounts/:id/token',
  ], { category: 'sysadmin-console', why: 'Discounts console (pages/dashboard/discounts.tsx + src/components/discounts/*): New Discount, Edit, Revoke, Apply to org, Preview, Issue code.' }),
  ...group('billing', [
    'POST /billing/admin/promotions', 'PUT /billing/admin/promotions/:id', 'DELETE /billing/admin/promotions/:id',
    'POST /billing/admin/promotions/:id/activate', 'POST /billing/admin/promotions/:id/grant',
    'POST /billing/admin/promotions/:id/preview',
  ], { category: 'sysadmin-console', why: 'Promotions console (pages/dashboard/promotions.tsx): New promotion, Activate/Revoke, grant-to-existing-base, manual grant, preview reach.' }),
  'billing DELETE /billing/subscriptions/by-org/:orgId': { category: 'sysadmin-console', why: '"Purge" row action on pages/dashboard/admin/billing.tsx, behind a typed-action confirm.' },
  'billing PUT /billing/admin/subscriptions/:id': { category: 'sysadmin-console', why: 'Billing-admin page — fleet-wide subscription edit; systemAdmin + step-up.' },
  'plugin DELETE /plugins/queue/dlq': { category: 'sysadmin-console', why: '"Purge DLQ" on pages/dashboard/build-queue.tsx, additionally wrapped in an explicit `isSuperAdmin` check.' },
  ...group('plugin', ['POST /plugins/queue/dlq/:jobId/replay', 'POST /plugins/queue/failed/:jobId/retry'], {
    category: 'sysadmin-console',
    why: '"Replay" / "Retry" on pages/dashboard/build-queue.tsx (and triage.tsx). The routes ask for plugins:write; the UI requires system admin, who holds it — see KNOWN_UI_GATE_MISMATCHES for the org-admin direction.',
  }),
  'quota PUT /quotas/:orgId': { category: 'sysadmin-console', why: '"Save" in src/components/quotas/QuotasAdmin.tsx, rendered only when `isSuperAdmin`. Note the PAGE gate is quotas:read — the control-level check is what matches the route.' },
  'quota POST /quotas/:orgId/reset': {
    category: 'sysadmin-console',
    why: '"Reset usage counters" on pages/dashboard/quotas.tsx → QuotasAdmin.tsx (step-up dialog as the confirm + api.resetOrgQuota with its token); systemAdmin + step-up.',
  },
  'platform POST /users': { category: 'sysadmin-console', why: '"Add user" on pages/dashboard/users.tsx. The route asks for members:manage; the page is systemAdminOnly — see KNOWN_UI_GATE_MISMATCHES.' },
  'platform POST /admin/orgs/:orgId/kms-config/test': { category: 'sysadmin-console', why: '"Test" in src/components/admin/OrgKmsConfigModal.tsx, opened from the sysadmin org pages behind `can(\'org:kms\')` — the same gate the route carries.' },
  'platform PUT /organization/:id/seat-limit': { category: 'sysadmin-console', why: '"Set limit" in src/components/admin/org-detail/OrgSeatsCard.tsx on the systemAdminOnly org drill-down; the handler admits only a service principal or a system admin.' },
  ...group('platform', [
    'PUT /admin/org-idp/:orgId', 'PATCH /admin/org-idp/:orgId', 'DELETE /admin/org-idp/:orgId',
  ], { category: 'sysadmin-console', why: 'Sysadmin IdP admin page; systemAdmin + step-up with a strong factor.' }),
  ...group('platform', ['PUT /admin/orgs/:orgId/kms-config', 'DELETE /admin/orgs/:orgId/kms-config'], {
    category: 'sysadmin-console', why: 'Sysadmin per-org KMS modal; systemAdmin + step-up with a strong factor.',
  }),
  ...group('platform', ['POST /admin/users/:id/grants', 'DELETE /admin/users/:id/grants'], {
    category: 'sysadmin-console', why: 'Sysadmin superadmin-grant editor; systemAdmin + step-up with a strong factor.',
  }),
  ...group('platform', [
    'POST /admin/impersonate/:userId', 'POST /admin/impersonate/:userId/breakglass',
    'POST /admin/impersonate/requests/:id/redeem',
  ], { category: 'sysadmin-console', why: 'Sysadmin impersonation start / break-glass / redeem; systemAdmin + consent + step-up with a strong factor.' }),
  ...group('platform', ['PUT /users/:id', 'DELETE /users/:id', 'POST /users/bulk-delete', 'PUT /users/:id/features'], {
    category: 'sysadmin-console', why: 'Sysadmin users page — edit / delete / bulk delete / per-user feature overrides; systemAdmin + step-up on an MFA-grade session.',
  }),
  'platform DELETE /organization/:id': { category: 'sysadmin-console', why: 'Sysadmin org drill-down / All Organizations — soft-delete an org; systemAdmin + step-up.' },
  'platform PATCH /organization/:id/tier': { category: 'sysadmin-console', why: 'Sysadmin change-tier dialog; systemAdmin + step-up.' },
  'platform GET /admin/orgs/:orgId/k8s-namespace.yaml': { category: 'sysadmin-console', why: 'Sysadmin org drill-down — namespace manifest download; systemAdmin + step-up.' },
  ...group('image-registry', [
    'POST /api/admin/gc', 'DELETE /api/images/:name', 'DELETE /api/images/:name/manifests/:reference',
    'POST /api/images/copy',
  ], { category: 'sysadmin-console', why: 'Registry console (pages/dashboard/registry.tsx, systemAdminOnly): Run GC, delete repository, delete tag / bulk delete, copy tag. Nothing under src/components/registry/ checks registry:read|write — the page gates on system admin, who holds both. See KNOWN_UI_GATE_MISMATCHES.' }),

  // ── Driven by a control whose gate a mapped row already proves ───────────
  ...group('compliance', [
    'PUT /compliance/rules/:id', 'PUT /compliance/policies/:id',
    'POST /compliance/scan-schedules', 'PUT /compliance/scan-schedules/:id',
    'DELETE /compliance/scan-schedules/:id', 'PATCH /compliance/scan-schedules/:id/active',
    'POST /compliance/scans', 'PUT /compliance/notification-preferences',
    'POST /compliance/templates/apply',
    'DELETE /compliance/subscriptions/:ruleId', 'POST /compliance/subscriptions/:ruleId/pin',
    'DELETE /compliance/subscriptions/:ruleId/pin', 'POST /compliance/subscriptions/clone',
  ], {
    category: 'same-control',
    coveredBy: 'Author / delete a compliance rule or policy',
    why: 'Rule/policy editors, scan + schedule managers, template onboarding and the subscription row actions under src/components/compliance/. Every one renders inside `!readOnly`, and `readOnly` is `!canManage` where ComplianceDashboard is given `canManage={can(\'compliance:write\')}` by pages/dashboard/compliance.tsx.',
  }),
  ...group('compliance', [
    'POST /compliance/exemptions', 'POST /compliance/exemptions/bulk',
    'POST /compliance/subscriptions', 'PATCH /compliance/subscriptions/:ruleId',
    'POST /compliance/subscriptions/bulk', 'POST /compliance/subscriptions/preview',
    'POST /compliance/subscriptions/preview/impact',
  ], {
    category: 'same-control',
    coveredBy: 'Compliance reads (rules, policies, scans)',
    why: 'Catalog Subscribe / Preview impact and the exemption request + CSV import, on the compliance:read-gated page. Most sit inside the same `!readOnly` block as the writes above, i.e. the UI asks for MORE (compliance:write) than the route does — safe, and noted rather than relaxed.',
  }),
  ...group('compliance', ['POST /compliance/validate/pipeline/dry-run', 'POST /compliance/validate/plugin/dry-run'], {
    category: 'same-control',
    coveredBy: 'Compliance reads (rules, policies, scans)',
    why: '"Dry run" in src/components/compliance/RuleEditor.tsx (compliance:write — stricter than the route), "Check compliance" in CreatePipelineModal, and an auto-fire in src/components/pipeline/PipelineContextCard.tsx on the pipelines:read-gated detail page. The last one is best-effort: a viewer without compliance:read gets a silent 403 and an empty card.',
  }),
  ...group('message', ['PUT /messages/:id/read', 'PUT /messages/:id/thread/read', 'POST /messages/notifications/ticket'], {
    category: 'same-control',
    coveredBy: 'Message reads',
    why: 'Implicit reads: opening a message / thread marks it read, and the Messages page mints an SSE ticket on mount. All three need exactly the messages:read the page is gated on.',
  }),
  ...group('billing', ['POST /billing/subscriptions/:id/addons/preview', 'POST /billing/subscriptions/:id/discounts/preview'], {
    category: 'same-control',
    coveredBy: 'Add / remove a billing add-on',
    why: 'Price previews fired by the add-on card and the discount-code "Preview" button, both behind `canChangePlan` (isAdmin || billing:manage). The routes ask only for billing:read, so the UI is stricter.',
  }),
  'billing POST /billing/marketplace/claim': { category: 'same-control', coveredBy: 'Change / cancel the subscription', why: 'AWS Marketplace landing page (pages/marketplace/register.tsx) binds the purchase to the org; billing:manage plus the org\'s admin-actions MFA policy.' },
  ...group('platform', ['PUT /dashboards/:id', 'DELETE /dashboards/:id'], {
    category: 'same-control',
    coveredBy: 'Create / edit a custom dashboard',
    why: 'Save on pages/dashboard/observability/[id]/edit.tsx (`disabled={!can(\'dashboards:write\')}`) and Delete on [id].tsx. The route table shows no permission because the gate is deliberately in the HANDLER: `dashboardService.canWrite` is dynamic — it also admits the dashboard\'s own creator — so it cannot move to a route middleware (platform/src/routes/dashboards.ts says so).',
  }),
  ...group('platform', ['POST /observability/silences', 'DELETE /observability/silences/:id', 'POST /observability/alert-destinations/:id/test'], {
    category: 'same-control',
    coveredBy: 'Create / edit / delete an alert rule',
    why: '"Silence" / "Expire" on pages/dashboard/observability/alerts.tsx and "Send test" on the destinations row, each wrapped in `canWrite = can(\'observability:write\')` — the same gate the mapped row proves.',
  }),
  ...group('platform', [
    'PATCH /organization/:id/domains/:domainId', 'DELETE /organization/:id/domains/:domainId',
    'POST /organization/:id/domains/:domainId/verify', 'POST /organization/:id/join-requests/:reqId/:decision',
  ], {
    category: 'same-control',
    coveredBy: 'Edit organization identity / AI settings',
    why: 'src/components/settings/DomainJoinSettings.tsx (verify, who-can-join select, delete domain, approve/deny a join request). It has no internal check: its mount site is `{can(\'org:settings\') && …}` in pages/dashboard/settings.tsx — the gate the mapped row renders with and without.',
  }),
  'platform PUT /organization/ai-config': { category: 'same-control', coveredBy: 'Edit organization identity / AI settings', why: 'src/components/settings/AIProviderConfig.tsx, mounted with `canEdit={can(\'org:settings\')}`; the write is additionally step-up gated.' },
  'platform PATCH /organization/:id/transfer-owner': { category: 'same-control', coveredBy: "Change a member's role / remove a member", why: 'Transfer ownership on the Members page; owner-gated + step-up on an MFA-grade session.' },
  ...group('pipeline', ['POST /pipelines/registry', 'DELETE /pipelines/registry/:id'], {
    category: 'same-control',
    coveredBy: 'New / edit / delete pipeline',
    why: '"Register deployment" / "Deregister" on pages/dashboard/deployments.tsx and the remove action in src/components/pipeline/DeployedPipelinesPanel.tsx — both behind `canWrite = can(\'pipelines:write\')`.',
  }),
  'reporting POST /reports/execution/stream/ticket': { category: 'same-control', coveredBy: 'Report reads', why: 'SSE ticket minted on mount by src/hooks/useExecutionStatusStream.ts for pages/dashboard/executions.tsx; needs exactly the reports:read that page is gated on.' },

  // ── Ask: the dashboard drives only the agent stream ──────────────────────
  'ask POST /ask': { category: 'no-ui', why: 'Non-streaming grounded answer for API / CLI callers; the dashboard Ask panel only drives /ask/agent/stream.' },
  'ask POST /ask/stream': { category: 'no-ui', why: 'Tool-less streaming answer for API / CLI callers; the dashboard Ask panel only drives /ask/agent/stream.' },

  // ── No UI reaches these at all (see docs/testing.md → "Write routes with
  //    no UI caller"). Each is a CLI / CDK / unattended-machine surface.
  'platform POST /auth/device/code': { category: 'no-ui', why: 'Device-authorization grant START — issued to the CLI (packages/pipeline-manager/src/utils/device-auth.ts), not a browser. The dashboard only drives the human half (GET /auth/device/authorize, approve, deny).' },
  'platform POST /auth/device/token': { category: 'no-ui', why: 'Device-grant token POLL — the CLI polls it (packages/pipeline-manager/src/utils/device-auth.ts, `pollDeviceToken`); no frontend reference exists.' },
  'platform POST /auth/token/exchange': { category: 'no-ui', why: 'Service-account token exchange; a machine surface with no frontend reference (api.generateNewToken is a different route).' },
  'platform POST /auth/key/rotate': { category: 'no-ui', why: 'Unattended service-account key self-rotation — the audit-event description says explicitly that no person is present.' },
  'platform POST /auth/key/revoke': { category: 'no-ui', why: 'Service-account key self-revocation; a machine surface with no frontend reference.' },
  'plugin POST /plugins/lookup': { category: 'no-ui', why: 'Deploy-time PluginLookup Lambda call from the CDK; no client function exists for it.' },
  ...group('compliance', ['GET /compliance/rules/:id', 'GET /compliance/policies/:id'], {
    category: 'no-ui',
    why: 'Read-one-by-id, for API / CLI callers. The dashboard never re-reads a single rule or policy: src/lib/api/domains/compliance.ts has only the list, PUT and DELETE by id — the list response already carries the whole row the drawer renders.',
  }),
  ...group('pipeline', ['GET /pipelines/find'], {
    category: 'no-ui',
    why: 'Exact-match lookup by project/organization, documented in docs/api-reference.md as a curl/CLI surface (the CDK resolves a pipeline this way). The dashboard uses the filtered list (GET /pipelines) instead; no client function exists.',
  }),
  'plugin GET /plugins/find': { category: 'no-ui', why: 'Exact-match lookup by name/version — the CLI / CDK surface documented in docs/api-reference.md. The dashboard filters GET /plugins instead; no client function exists.' },
  'billing GET /billing/subscriptions/by-org/:orgId/billable': {
    category: 'no-ui',
    why: 'Service-to-service pre-flight: platform/src/services/org-hierarchy-service.ts calls it before nesting a root under another org (a root with a billable subscription is refused). Authenticated + permission-gated rather than service-principal-only, so it cannot be `machine-only`, but nothing in the frontend references it.',
  },
  'quota GET /quotas/:orgId/:quotaType': {
    category: 'no-ui',
    why: 'Single-dimension quota status read by the shared service client (packages/api-core/src/services/quota.ts `getQuotaStatus`) — the gate allows a service principal for exactly that. The dashboard reads the whole document via GET /quota[/:orgId]; no client function exists for one dimension.',
  },
  ...group('platform', ['GET /organization/:id/descendants', 'GET /organization/:id/members/:userId/exists'], {
    category: 'no-ui',
    why: 'Org-hierarchy reads for PEER SERVICES — packages/api-core/src/helpers/org-hierarchy-http.ts fetches the subtree id list and the membership probe (the reporting rollup and the authz boundary use them). Authenticated but not service-principal-only, so not `machine-only`. The dashboard had a `getOrganizationDescendants` client method with zero callers; it was deleted rather than left looking like a product capability.',
  }),
  'platform GET /organization/:id/parent': {
    category: 'no-ui',
    why: 'Least-privilege internal read (service principal OR org admin) for peer services: api/compliance/src/helpers/org-hierarchy-client.ts needs the parent to evaluate `propagateToChildren` rules on scheduled scans that run detached from any request JWT. No frontend reference exists.',
  },
  'compliance GET /compliance/entitlements/:orgId': {
    category: 'no-ui',
    why: 'The billing↔compliance entitlement sync leg: api/compliance/src/routes/entitlements.ts gates it with `requireBillingService`, so only the billing service reads it. The dashboard reads subscriptions, not the synced entitlement row.',
  },

  // `POST /user/generate-token` is not a no-UI machine mint: it has the
  // "Generate machine token" panel on pages/dashboard/security.tsx, with lifetime, capability scope and
  // permission-subset selection. It belongs with the other own-account rows.
  'platform POST /user/generate-token': { category: 'own-account', why: 'Settings → Security, "Generate machine token" (pages/dashboard/security.tsx → MachineTokenSection, api.generateNewToken). Own account: the credential carries a subset of the caller\'s OWN permissions, so no org permission gates it — the org\'s admin-actions MFA policy does, and renewal by the machine session does not re-prompt.' },
  'platform POST /organization/names': { category: 'machine-only', why: 'Batch org-id → name resolver called service-to-service (packages/api-core org-hierarchy-http.ts, api/compliance org-hierarchy-client.ts). Gated by requireServicePrincipal on the route (not in the controller), so a user token can never reach it and the route table says servicePrincipal:true.' },
  ...group('compliance', ['POST /compliance/validate/pipeline', 'POST /compliance/validate/plugin'], {
    category: 'no-ui',
    why: 'The enforcing (non dry-run) validation, called by the CDK / service principals at deploy time. The client layer only has the /dry-run variants.',
  }),

  // Filed as `sysadmin-console` beside POST /quotas/:orgId/reset — "Quota admin
  // — delete an org's quota row / reset a period". Reset has that control;
  // delete never did, and should not. api/quota/src/routes/update-quota.ts
  // calls it a CASCADE HOOK and platform/src/services/org-cascade-service.ts
  // drives it with a service token during org purge (requireStepUp waives the
  // factor for a verified service principal, which is why the cascade runs
  // unattended). Offering it to a person would be a one-way door: quotaService
  // .update() and .resetUsage() both throw OrgNotFoundError on a missing
  // document and never upsert, and findByOrgId then serves READ-ONLY defaults
  // — so an org whose row a sysadmin dropped reads plausible numbers, cannot
  // reserve or enforce anything, and cannot be repaired from the dashboard at
  // all. The recreate path belongs to org creation in the platform service.
  'quota DELETE /quotas/:orgId': {
    category: 'no-ui',
    why: 'Org-purge CASCADE hook, not a product capability: platform/src/services/org-cascade-service.ts DELETEs it with a service token while purging an org (idempotent, returns deleted:false when already gone). A human sysadmin is admitted by the gate but no control exists and none should — dropping the document leaves the org unenforceable and unrepairable from the UI (update/reset both throw OrgNotFoundError and never upsert).',
  },
};

/**
 * Routes whose UI control checks a DIFFERENT gate than the route enforces.
 *
 * These are findings, not dispositions: each is recorded so the set cannot grow
 * unnoticed, and removing one (by fixing the UI) fails the suite until it is
 * taken off the list. Nothing here is "fine" — it is "known, and this is what
 * it costs".
 */
const KNOWN_UI_GATE_MISMATCHES: Record<string, string> = {
  'pipeline POST /pipeline-templates/:id/instantiate': 'DIFFERENT: "Use template" is disabled unless `can(\'pipelines:write\')`, but the route requires templates:read. Defensible (it creates a pipeline) yet the two gates are unrelated ids.',
  'platform POST /users': 'STRICTER: the route requires members:manage, the only UI is the systemAdminOnly users page — so an org admin holding members:manage has no UI path to create a user.',
  'plugin POST /plugins/queue/dlq/:jobId/replay': 'STRICTER: route requires plugins:write; the only UI is the systemAdminOnly build-queue / triage pages.',
  'plugin POST /plugins/queue/failed/:jobId/retry': 'STRICTER: route requires plugins:write; the only UI is the systemAdminOnly build-queue page.',
  'quota PUT /quotas/:orgId': 'MIXED: the route is systemAdmin, the control checks isSuperAdmin — but the PAGE gate is quotas:read, so the page loads for anyone holding it and only the in-component check hides the editor.',
  'image-registry POST /api/admin/gc': 'DIFFERENT: route requires registry:write; nothing under src/components/registry/ checks it — the page gates on system admin instead.',
  'image-registry DELETE /api/images/:name': 'DIFFERENT: route requires registry:write; the UI gate is system admin (see above).',
  'image-registry DELETE /api/images/:name/manifests/:reference': 'DIFFERENT: route requires registry:write; the UI gate is system admin (see above).',
  'image-registry POST /api/images/copy': 'DIFFERENT: route requires registry:read AND registry:write; the UI gate is system admin (see above).',
};

// ── Shared lookups ─────────────────────────────────────────────────────────

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

/** Read a control's own source plus any `gateFiles` it delegates part of the gate to. */
function gateSources(control: Control): string {
  return [control.file, ...(control.gateFiles ?? [])]
    .map((f) => readFileSync(resolve(FRONTEND_DIR, f), 'utf8'))
    .join('\n');
}

/** Every route that enforces something beyond plain permissions / systemAdmin. */
function gatedRoutes(): string[] {
  return Object.entries(tables)
    .flatMap(([service, table]) => table
      .filter((e) => e.features.length > 0 || e.stepUp || e.scopes.length > 0 || e.minAssurance > 0 || !!e.orgAdminAssurance)
      .map((e) => `${service} ${e.method} ${e.path}`))
    .sort();
}

/** Every route that WRITES. This is the set the mapping must account for. */
function writeRoutes(): string[] {
  return Object.entries(tables)
    .flatMap(([service, table]) => table
      .filter((e) => e.method !== 'GET')
      .map((e) => `${service} ${e.method} ${e.path}`))
    .sort();
}

/**
 * Every AUTHENTICATED read that `gatedRoutes()` does not already pick up —
 * permission-gated, sysadmin-only, and plain-authenticated alike. These are the
 * routes the surveys kept finding holes in and that neither set above covered:
 * a read the client cannot reach is either a machine surface (fine, say so) or
 * a control that was never built (not fine). Unauthenticated reads (`/health`,
 * `/metrics`, `/ready`, `/warmup`, `/config`, JWKS, the registry `/token`) are
 * excluded — they carry nothing to be in parity with.
 */
function readRoutes(): string[] {
  return Object.entries(tables)
    .flatMap(([service, table]) => table
      .filter((e) => e.method === 'GET' && e.auth
        && !(e.features.length > 0 || e.stepUp || e.scopes.length > 0 || e.minAssurance > 0 || !!e.orgAdminAssurance))
      .map((e) => `${service} ${e.method} ${e.path}`))
    .sort();
}

// ── Client-call index ──────────────────────────────────────────────────────
//
// `<service> <METHOD> <path>` → the api-client file(s) that can drive it.
//
// The dashboard never speaks to a service directly: every call leaves through
// `src/lib/api/domains/*.ts` and hits nginx on `/api/…`, which strips the
// prefix and proxies. Three locations rewrite more than the prefix (see
// deploy/*/nginx/nginx.conf) and are mirrored here, so a route the client CAN
// reach never looks unreachable because of a proxy rewrite.

const CLIENT_DIR = 'src/lib/api/domains';
/** The fetch core drives a few routes itself (refresh, impersonation revoke). */
const CLIENT_CORE = 'src/lib/api/core.ts';

/** The `/api/…` path the browser asks for when it wants `service <path>`. */
function clientPathFor(service: string, path: string): string {
  const p = path.replace(/:[A-Za-z0-9_]+/g, ':p');
  // The image registry is proxied at its own `/api/…` mount, unrewritten.
  if (service === 'image-registry') return p;
  // nginx: `/api/quota[/…]` → the quota service's `/quotas[/…]`.
  if (service === 'quota') return `/api${p.replace('/quotas', '/quota')}`;
  // nginx: `/api/plugins/logs/…` → the plugin service's `/logs/…`.
  if (service === 'plugin' && p.startsWith('/logs')) return `/api/plugins${p}`;
  return `/api${p}`;
}

/**
 * Turn a client endpoint literal into a route path. A `${…}` that follows a
 * slash is a path parameter; one appended to anything else is the query tail
 * (`${buildQuery(params)}`, `${qs}`) and is dropped.
 */
function normaliseEndpoint(literal: string): string {
  let out = '';
  for (let i = 0; i < literal.length; i += 1) {
    if (literal.startsWith('${', i)) {
      let depth = 0;
      let j = i + 1;
      for (; j < literal.length; j += 1) {
        if (literal[j] === '{') {depth += 1;}
        else if (literal[j] === '}') { depth -= 1; if (depth === 0) break; }
      }
      out += out.endsWith('/') ? ':p' : '';
      i = j;
    } else {out += literal[i];}
  }
  return out.split('?')[0].replace(/\/+$/, '') || '/';
}

const CLIENT_CALLS: Map<string, string[]> = (() => {
  const index = new Map<string, string[]>();
  // `${API_URL}` prefixes the handful of raw-`fetch` clients (log raw/export,
  // attachment blobs) that cannot go through `core.request`.
  const endpoint = /[`'](?:\$\{API_URL\})?(\/api[^`'\n]*)[`']/g;
  const files = [
    ...readdirSync(resolve(FRONTEND_DIR, CLIENT_DIR)).filter((n) => n.endsWith('.ts')).map((n) => `${CLIENT_DIR}/${n}`),
    CLIENT_CORE,
  ];
  for (const file of files) {
    const src = readFileSync(resolve(FRONTEND_DIR, file), 'utf8');
    const hits = [...src.matchAll(endpoint)];
    hits.forEach((m, i) => {
      const at = m.index ?? 0;
      // The options object belongs to THIS call: stop at the next endpoint.
      const from = at + m[0].length;
      const to = Math.min(hits[i + 1]?.index ?? src.length, from + 400);
      // `streamRequest` takes no options object — it always POSTs (SSE).
      const before = src.slice(Math.max(0, at - 160), at);
      const streamed = /streamRequest\s*\(\s*$/.test(before);
      // The ecosystem client's `post<T>(path, body, stepUpToken)` helper always POSTs.
      const viaPost = /\bpost\s*(?:<[^\n]*>)?\(\s*$/.test(before);
      const method = streamed || viaPost ? 'POST' : (/method:\s*'(\w+)'/.exec(src.slice(from, to))?.[1] ?? 'GET');
      const key = `${method} ${normaliseEndpoint(m[1])}`;
      index.set(key, [...new Set([...(index.get(key) ?? []), file])]);
    });
  }
  return index;
})();

/** The api-client file(s) a browser session could reach `route` through. */
function clientCallers(route: string): string[] {
  const [service, method, ...rest] = route.split(' ');
  return CLIENT_CALLS.get(`${method} ${clientPathFor(service, rest.join(' '))}`) ?? [];
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
    // An internal route refuses every user token, so a `can(...)`-gated
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
    expect({ control: control.control, orgAdminAssurance: !!control.orgAdminAssurance })
      .toEqual({ control: control.control, orgAdminAssurance: entries.some((e) => !!e.orgAdminAssurance) });

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

describe('no write route lands unmapped', () => {
  const mapped = new Set(CONTROLS.flatMap((c) => c.routes));

  it('every write route is either mapped to a control or given a disposition', () => {
    const unaccounted = writeRoutes()
      .filter((r) => !mapped.has(r) && !(r in ROUTE_DISPOSITIONS) && !(r in KNOWN_UI_GATE_MISMATCHES));
    expect({
      unaccounted,
      fix: 'A write route landed with nothing saying who calls it. Either map it to the UI control that '
        + 'drives it in CONTROLS (with a `behaviour` block proving its gate), or add it to ROUTE_DISPOSITIONS '
        + 'with the category it belongs to and the control you FOUND — look, do not guess. '
        + '"No UI control; called by the CLI only" is a fine answer; a vague one is not.',
    }).toEqual({ unaccounted: [], fix: expect.any(String) });
  });

  it('every feature / step-up / scope / assurance route is accounted for too', () => {
    // The narrower rule this suite started with, kept because it also covers the
    // GET routes that carry an entitlement or a step-up.
    const unaccounted = gatedRoutes()
      .filter((r) => !mapped.has(r) && !(r in ROUTE_DISPOSITIONS) && !(r in KNOWN_UI_GATE_MISMATCHES));
    expect({ unaccounted }).toEqual({ unaccounted: [] });
  });

  it('the registry carries no stale or duplicated entries', () => {
    const known = new Set([...writeRoutes(), ...gatedRoutes(), ...readRoutes()]);
    const stale = Object.keys(ROUTE_DISPOSITIONS).filter((r) => !known.has(r));
    const alsoMapped = Object.keys(ROUTE_DISPOSITIONS).filter((r) => mapped.has(r));
    // A route may hold BOTH a disposition and a mismatch entry: the first says
    // which surface drives it, the second records how its gate diverges.
    expect({ stale, alsoMapped }).toEqual({ stale: [], alsoMapped: [] });
  });

  it('every disposition states a real reason', () => {
    for (const [route, d] of Object.entries(ROUTE_DISPOSITIONS)) {
      // Long enough to name a file or a caller: "N/A" cannot pass.
      expect({ route, ok: d.why.trim().length > 40 }).toEqual({ route, ok: true });
    }
  });

  it('a `same-control` disposition names a control this file really proves', () => {
    // The anti-rubber-stamp rule: leaning on another row's gate is only honest
    // if that row exists AND is covered behaviourally.
    const names = new Set(CONTROLS.map((c) => c.control));
    for (const [route, d] of Object.entries(ROUTE_DISPOSITIONS)) {
      if (d.category !== 'same-control') {
        expect({ route, coveredBy: d.coveredBy }).toEqual({ route, coveredBy: undefined });
        continue;
      }
      expect({ route, namesAMappedControl: !!d.coveredBy && names.has(d.coveredBy) })
        .toEqual({ route, namesAMappedControl: true });
    }
  });

  it('`machine-only` really is machine-only, and `no-ui` really has no client function', () => {
    for (const [route, d] of Object.entries(ROUTE_DISPOSITIONS)) {
      if (d.category === 'machine-only') {
        const { entry } = lookup(route);
        // Claiming "no user token reaches this" must be true in the table.
        expect({ route, internal: !!entry && (entry.internalCallers.length > 0 || entry.servicePrincipal) })
          .toEqual({ route, internal: true });
        continue;
      }
      // The `no-ui` half — it must run for every category, or the assertion the
      // title promises is vacuous.
      // "No UI reaches this" is a claim about the API CLIENT: every dashboard call
      // leaves through src/lib/api/domains, so a client method for the route is
      // exactly what makes the claim false. Reachability from a page/component is
      // then implied — an exported client method is callable from anywhere — and a
      // method with no caller at all is dead code the claim should not hide either.
      if (d.category !== 'no-ui') continue;
      expect({ route, clientMethodIn: clientCallers(route) }).toEqual({ route, clientMethodIn: [] });
    }
  });

  it('a disposition that NAMES a surface can really reach the route', () => {
    // The other direction of the same rule, and the one that catches a false
    // "there is a control for this". `DELETE /quotas/:orgId` sat in the
    // sysadmin-console group next to `POST /quotas/:orgId/reset` — "delete an
    // org's quota row / reset a period" — while no frontend caller for the
    // delete has ever existed. A category that claims a person drives the route
    // is only true if the api client can reach it at all.
    const claimsASurface = new Set<Category>([
      'sysadmin-console', 'same-control', 'own-account', 'session-plumbing', 'step-up-resume', 'pre-session',
    ]);
    const unreachable = Object.entries(ROUTE_DISPOSITIONS)
      .filter(([route, d]) => claimsASurface.has(d.category) && clientCallers(route).length === 0)
      .map(([route, d]) => `${route} (${d.category})`);
    expect({
      unreachable,
      fix: 'The disposition says a dashboard surface drives this route, but src/lib/api has no method '
        + 'that calls it — so the surface it names cannot exist. Either the control is missing, or the '
        + 'route has no UI and the disposition should say `no-ui` with the machine caller you FOUND.',
    }).toEqual({ unreachable: [], fix: expect.any(String) });
  });

  it('the client-call index really resolves calls (it is what `no-ui` leans on)', () => {
    // A broken extractor would silently pass every `no-ui` row. Anchor it on
    // calls of each shape: a plain path, a path parameter, an nginx-rewritten
    // mount, a query-tail template, and an SSE stream.
    expect(CLIENT_CALLS.size).toBeGreaterThan(350);
    expect(clientCallers('platform POST /auth/refresh')).toEqual([CLIENT_CORE]);
    expect(clientCallers('platform POST /user/generate-token')).toEqual([`${CLIENT_DIR}/auth.ts`]);
    expect(clientCallers('quota POST /quotas/:orgId/reset')).toEqual([`${CLIENT_DIR}/admin.ts`]);
    expect(clientCallers('pipeline GET /pipelines')).toEqual([`${CLIENT_DIR}/pipelines.ts`]);
    expect(clientCallers('ask POST /ask/agent/stream')).toEqual([`${CLIENT_DIR}/ask.ts`]);
    expect(clientCallers('image-registry DELETE /api/images/:name')).toEqual([`${CLIENT_DIR}/registry.ts`]);
    expect(clientCallers('platform GET /observability/logs/export')).toEqual([`${CLIENT_DIR}/observability.ts`]);
  });

  it('is not vacuous — the tables really do carry these routes', () => {
    expect(writeRoutes().length).toBeGreaterThan(250);
    expect(gatedRoutes().length).toBeGreaterThan(50);
  });
});

/**
 * ── Reads ──────────────────────────────────────────────────────────────────
 *
 * The mechanism above covers WRITES and the reads that carry a feature /
 * step-up / scope / assurance gate. That left ~156 authenticated GETs unchecked
 * — permission-gated, sysadmin-only and plain-authenticated — the half the
 * surveys kept finding holes in.
 *
 * Mapping each of those to a control the way CONTROLS does is not honest work:
 * a read is not a button, it is whatever a page fetches on mount, and hand-
 * writing 156 dispositions would produce a wall of rubber stamps rather than a
 * contract. So the extension here is deliberately narrower and entirely
 * mechanical: every gated read must be REACHABLE — the api client must have a
 * method for it — or carry a disposition saying which machine surface drives it
 * instead. That catches the two failures that matter and cannot be faked: a
 * read route nothing can call (a control that was never built, or dead backend
 * surface), and a disposition that stops being true once a client method lands.
 *
 * WHAT REMAINS UNCOVERED, deliberately:
 *  - GATE parity on reads. A write route is compared against the control's own
 *    `can(...)`; a read is gated by the PAGE (src/lib/page-access.ts), and a
 *    page pulls from many services, so "the page's gate satisfies this read's
 *    permission" has no single control to compare against. `resolvePageGate` is
 *    asserted per CONTROL row instead, for the pages that own a write.
 *  - Unauthenticated reads (`/health`, `/metrics`, `/ready`, `/warmup`,
 *    `/config`, JWKS, the registry `/token`): no gate, nothing to be in parity
 *    with.
 *  - Which PAGE issues a given read. The client method proves the dashboard CAN
 *    reach it; proving which surface does would mean mapping every mount-time
 *    fetch, which is the CONTROLS exercise again at ten times the size.
 */
describe('no read route is unreachable', () => {
  it('every authenticated GET has an api-client method, or a disposition', () => {
    const unaccounted = readRoutes()
      .filter((r) => clientCallers(r).length === 0 && !(r in ROUTE_DISPOSITIONS));
    expect({
      unaccounted,
      fix: 'A gated read route has no way to be called from the dashboard. Either it is missing its '
        + 'client method (add it, and the surface that uses it), or nothing in the product reads it — '
        + 'in which case add a ROUTE_DISPOSITIONS entry naming the machine / CLI caller you FOUND.',
    }).toEqual({ unaccounted: [], fix: expect.any(String) });
  });

  it('is not vacuous — the tables really do carry these reads', () => {
    expect(readRoutes().length).toBeGreaterThan(150);
    // And most of them really are reachable, so the rule above is doing work
    // rather than being satisfied by an empty client index.
    expect(readRoutes().filter((r) => clientCallers(r).length > 0).length).toBeGreaterThan(100);
  });
});

describe('known UI ↔ route gate mismatches', () => {
  // Findings, pinned. A new mismatch is not silently absorbed, and a fixed one
  // must be removed from the list.
  it('each names a real route and says what the divergence costs', () => {
    const known = new Set(writeRoutes());
    for (const [route, why] of Object.entries(KNOWN_UI_GATE_MISMATCHES)) {
      expect({ route, inTables: known.has(route) }).toEqual({ route, inTables: true });
      expect({ route, explained: /LOOSER|STRICTER|DIFFERENT|MIXED/.test(why) && why.length > 60 })
        .toEqual({ route, explained: true });
    }
  });

  it('the set has not grown', () => {
    // Bump deliberately, with the finding written down above.
    expect(Object.keys(KNOWN_UI_GATE_MISMATCHES)).toHaveLength(9);
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

describe('MFA refusals are handled app-wide', () => {
  // Every `minAssurance` / `orgAdminAssurance` route leans on ONE mechanism: the
  // fetch core turns a 401 `MFA_REQUIRED` into an `mfa-required` event and the
  // dashboard shell opens the MFA-required dialog (with the way to enrol) —
  // never a sign-out, and never just a generic error.
  it('the fetch core emits the mfa-required event', () => {
    const core = readFileSync(resolve(FRONTEND_DIR, 'src/lib/api/core.ts'), 'utf8');
    expect(core).toContain("'mfa-required'");
  });

  it('the dashboard shell listens for it and shows the MFA dialog', () => {
    const layout = readFileSync(resolve(FRONTEND_DIR, 'src/components/ui/DashboardLayout.tsx'), 'utf8');
    expect(layout).toContain('mfa-required');
    expect(layout).toContain('MfaRequiredDialog');
  });

  it('no authenticated endpoint bypasses the fetch core with a raw fetch', () => {
    // File / text / multipart endpoints use core.requestRaw / requestBlob /
    // requestText, so their refusals take the same path. Only the anonymous
    // public-submission client may call fetch itself.
    const dir = resolve(FRONTEND_DIR, 'src/lib/api/domains');
    const rawFetchers = readdirSync(dir)
      .filter((f) => /\bfetch\(/.test(readFileSync(resolve(dir, f), 'utf8')));
    expect(rawFetchers).toEqual(['plugin-submissions.ts']);
  });
});

describe('step-up refusals are resumable app-wide', () => {
  // Every step-up route is covered by ONE mechanism rather than per-control
  // handling: the fetch core turns a step-up 401 into a `step-up-required`
  // event carrying a `retry`, and the dashboard shell prompts and replays it.
  // The `step-up-resume` dispositions lean on this, so assert it exists.
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
