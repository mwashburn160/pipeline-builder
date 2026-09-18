// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * UI gate ↔ API gate parity.
 *
 * Each service's route-coverage test writes its resolved route table to
 * `src/generated/route-table/<service>.json` (see docs/permissions.md →
 * "Route coverage"). This suite maps every write control in the dashboard to the
 * route(s) it calls and asserts:
 *
 *   1. the control's page really gates on the permission listed here (`can('…')`
 *      appears in its source), and
 *   2. holding that permission SATISFIES every permission gate the route
 *      actually runs — so a button can never be shown to someone the API will
 *      reject, and a gate rename on either side fails here.
 *
 * Controls are mapped explicitly (there is no way to infer which fetch a button
 * makes). Add a row when you add a gated control; the "every table is mapped"
 * test keeps whole services from going unmapped.
 *
 * NOT covered on purpose: `:publish` controls (`can('pipelines:publish')` etc.).
 * Publishing is not a separate route — `resolveVisibility` checks the permission
 * inside the write handler — so there is no route requirement to compare against.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

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
  audit: string[];
}

const TABLE_DIR = resolve(__dirname, '../src/generated/route-table');
const FRONTEND_DIR = resolve(__dirname, '..');

const tables: Record<string, RouteTableEntry[]> = Object.fromEntries(
  readdirSync(TABLE_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => [f.replace(/\.json$/, ''), JSON.parse(readFileSync(resolve(TABLE_DIR, f), 'utf8')) as RouteTableEntry[]]),
);

/** A gated UI control, the permission(s) it checks, and the routes it drives. */
interface Control {
  /** What the user sees / does. */
  control: string;
  /** Source file holding the permission check. */
  file: string;
  /** Permission ids the control checks (the set a holder would have). */
  permissions: string[];
  /** `<service> <METHOD> <path>` entries from the generated tables. */
  routes: string[];
  /**
   * How the permission appears in `file`. Write controls check it inline with
   * `can('x:y')` (the default); whole-page READS are gated by the nav's
   * `requiredPermission`, so those rows use `'nav'`.
   */
  via?: 'can' | 'nav';
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
    permissions: ['pipelines:write'],
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
    control: 'Report + DORA reads',
    file: 'src/lib/nav.ts',
    permissions: ['reports:read'],
    routes: ['reporting GET /reports/execution/dora', 'reporting GET /reports/execution/list'],
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
    permissions: ['service_accounts:manage'],
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
    permissions: ['org:impersonation'],
    routes: ['platform PATCH /organization/:id/impersonation-policy'],
  },
];

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

describe('UI can(...) gates match the routes they call', () => {
  it.each(CONTROLS.map((c) => [c.control, c] as const))('%s', (_name, control) => {
    const source = readFileSync(resolve(FRONTEND_DIR, control.file), 'utf8');
    for (const permission of control.permissions) {
      // The UI must really check this permission (catches a rename on either side).
      expect(source).toContain(control.via === 'nav'
        ? `requiredPermission: '${permission}'`
        : `can('${permission}')`);
    }
    for (const route of control.routes) {
      const { service, entry } = lookup(route);
      expect(tables[service]).toBeDefined();
      if (!entry) throw new Error(`${route} is not in the ${service} route table — the control calls a route that no longer exists`);
      // Holding the control's permission must satisfy every gate on the route.
      expect({ route, gates: entry.permissions, satisfied: satisfies(entry, control.permissions) })
        .toEqual({ route, gates: entry.permissions, satisfied: true });
      // And the route must be gated at all — an ungated write with a UI gate is
      // the mismatch this whole mechanism exists to prevent.
      expect(entry.permissions.length + (entry.systemAdmin ? 1 : 0)).toBeGreaterThan(0);
    }
  });

  it('maps at least one control per service that the dashboard writes to', () => {
    const mapped = new Set(CONTROLS.flatMap((c) => c.routes.map((r) => r.split(' ')[0])));
    for (const service of ['pipeline', 'plugin', 'message', 'compliance', 'billing', 'quota', 'reporting', 'platform']) {
      expect([...mapped]).toContain(service);
    }
  });
});
