// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Permission + audit coverage for every route this service serves.
 *
 * Builds the REAL route table from `src/app-routes.ts` (the same mount code
 * `index.ts` runs) and fails when a write route has no permission gate or no
 * declared audit action, or a read route has no permission gate. Exceptions are
 * explicit and carry a reason; a stale one fails the test too.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from '@jest/globals';
import { buildRouteTable, REMOTE_AUDIT_ACTIONS, type RouteTableEntry } from '@pipeline-builder/api-core';
import {
  INFRA_ROUTE_EXCEPTIONS,
  compareRouteTableSnapshot,
  declaredAuditActions,
  findInternalRouteViolations,
  findRouteCoverageViolations,
  type InternalRouteDeclaration,
  type RouteCoverageException,
} from '@pipeline-builder/api-core/lib/testing/route-coverage.js';

process.env.JWT_SECRET ||= 'route-coverage-test-secret';

const here = dirname(fileURLToPath(import.meta.url));
const snapshotFile = resolve(here, '../../../frontend/src/generated/route-table/compliance.json');

/** Routes that legitimately can't satisfy a rule, each with its reason. */
const EXCEPTIONS: RouteCoverageException[] = [
  ...INFRA_ROUTE_EXCEPTIONS,
  {
    method: 'POST',
    path: '/compliance/events/entity',
    waive: 'all',
    reason: 'INTERNAL entity-event ingest (#14): requireAuth + requireInternalService({ callers: [pipeline, plugin] }), no user token accepted; the rule evaluation it runs writes the compliance check log, not an admin audit event.',
  },
  {
    method: 'POST',
    path: '/compliance/subscriptions/auto-subscribe',
    waive: 'all',
    reason: 'INTERNAL onboarding hook (#14): requireInternalService({ callers: [platform] }); it creates INACTIVE subscriptions, so nothing is enforced until a separately audited activate.',
  },
  {
    method: 'POST',
    path: /^POST \/compliance\/validate\//,
    waive: 'audit',
    reason: 'Enforcement evaluation: persists a compliance_check_log row (read back via GET /compliance/audit), never an admin mutation — the rules/subscriptions it evaluates are audited where they are authored.',
  },
  {
    method: 'POST',
    path: '/compliance/exemptions',
    waive: 'audit',
    reason: 'Files a PENDING exemption request (no posture change); the decisions are audited — compliance.exemption.approve on review, compliance.exemption.revoke on delete.',
  },
  {
    method: 'POST',
    path: '/compliance/exemptions/bulk',
    waive: 'audit',
    reason: 'Same as POST /compliance/exemptions — bulk-files PENDING requests; approval/revocation carry the audit.',
  },
  {
    method: 'POST',
    path: '/compliance/subscriptions/preview',
    waive: 'audit',
    reason: 'Evaluates a rule against caller-supplied sample attributes and persists nothing.',
  },
  {
    method: 'POST',
    path: '/compliance/subscriptions/preview/impact',
    waive: 'audit',
    reason: 'Counts how many existing org entities a rule would fail; read-only, persists nothing.',
  },
];

/**
 * The INTERNAL routes this service exposes (#14) and the services allowed to
 * call them — the same list `deploy/*​/k8s/istio-internal-routes.yaml` names, and
 * the ONE place it is written down. `findInternalRouteViolations` checks it
 * against the code in both directions.
 */
const INTERNAL_ROUTES: InternalRouteDeclaration[] = [
  { method: 'POST', path: '/compliance/events/entity', callers: ['pipeline', 'plugin'] },
  { method: 'POST', path: '/compliance/subscriptions/auto-subscribe', callers: ['platform'] },
  { method: 'PUT', path: '/compliance/entitlements/:orgId', callers: ['billing'] },
  { method: 'GET', path: '/compliance/entitlements/:orgId', callers: ['billing'] },
];

let table: RouteTableEntry[];

beforeAll(async () => {
  const [{ createApp }, { createQuotaService }, { mountRoutes }] = await Promise.all([
    import('@pipeline-builder/api-server'),
    import('@pipeline-builder/api-core'),
    import('../src/app-routes.js'),
  ]);
  const { app } = createApp({ enableOpenApi: false });
  mountRoutes(app, { quotaService: createQuotaService() });
  table = buildRouteTable(app);
});

describe('compliance route coverage', () => {
  it('serves a non-empty route table', () => {
    expect(table.length).toBeGreaterThan(0);
  });

  it('gates every write route on a permission and declares its audit action', () => {
    const { violations } = findRouteCoverageViolations(table, EXCEPTIONS);
    expect(violations).toEqual([]);
  });

  it('has no stale coverage exceptions', () => {
    const { unusedExceptions } = findRouteCoverageViolations(table, EXCEPTIONS);
    expect(unusedExceptions).toEqual([]);
  });

  it('declares only audit actions platform accepts from a service', () => {
    const unknown = declaredAuditActions(table).filter((a) => !(REMOTE_AUDIT_ACTIONS as readonly string[]).includes(a));
    expect(unknown).toEqual([]);
  });

  it('gates every internal route on requireInternalService, with the declared callers', () => {
    expect(findInternalRouteViolations(table, INTERNAL_ROUTES)).toEqual([]);
  });

  it('matches the route table the frontend reads', () => {
    expect(compareRouteTableSnapshot(table, snapshotFile)).toBeNull();
  });
});
