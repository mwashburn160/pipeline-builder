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
  findRouteCoverageViolations, findSystemOrgGuardViolations,
  findDynamicAuthzViolations,
  type InternalRouteDeclaration,
  findQuotaCoverageViolations,
  type QuotaCoverageException,
  type RouteCoverageException,
} from '@pipeline-builder/api-core/testing';

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
    reason: 'INTERNAL entity-event ingest: requireAuth + requireInternalService({ callers: [pipeline, plugin] }), no user token accepted; the rule evaluation it runs writes the compliance check log, not an admin audit event.',
  },
  {
    method: 'POST',
    path: /^POST \/compliance\/validate\//,
    waive: 'audit',
    reason: 'Enforcement evaluation: persists a compliance_check_log row (read back via GET /compliance/audit), never an admin mutation — the rules/subscriptions it evaluates are audited where they are authored.',
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
 * The INTERNAL routes this service exposes and the services allowed to
 * call them — the same list `deploy/*​/k8s/istio-internal-routes.yaml` names, and
 * the ONE place it is written down. `findInternalRouteViolations` checks it
 * against the code in both directions.
 */
const INTERNAL_ROUTES: InternalRouteDeclaration[] = [
  { method: 'POST', path: '/compliance/events/entity', callers: ['pipeline', 'plugin'] },
  { method: 'POST', path: '/compliance/subscriptions/auto-subscribe', callers: ['platform'] },
  { method: 'PUT', path: '/compliance/entitlements/:orgId', callers: ['billing'] },
  { method: 'GET', path: '/compliance/entitlements/:orgId', callers: ['billing'] },
  // Read-only posture counts for a stakeholder report's compliance panel. The org comes
  // from the caller's token, not a path parameter, so there is nothing to disagree with;
  // nothing here can create a scan, evaluate a rule, or read a rule's conditions.
  { method: 'GET', path: '/compliance/posture', callers: ['reporting'] },
];

/**
 * User routes that deliberately do not meter and/or check apiCalls, each with
 * its reason (docs/quotas.md). The fleet-wide console-polling carve-out lives
 * in api-core `QUOTA_EXEMPT_ROUTES`, not here.
 */
const QUOTA_EXCEPTIONS: QuotaCoverageException[] = [];

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
  it('meters and checks apiCalls on every user route, and meters none twice', () => {
    const { violations } = findQuotaCoverageViolations(table, QUOTA_EXCEPTIONS);
    expect(violations).toEqual([]);
  });

  it('has no stale quota exceptions', () => {
    const { unusedExceptions } = findQuotaCoverageViolations(table, QUOTA_EXCEPTIONS);
    expect(unusedExceptions).toEqual([]);
  });

  it('serves a non-empty route table', () => {
    expect(table.length).toBeGreaterThan(0);
  });

  it('gates every write route on a permission and declares its audit action', () => {
    const { violations } = findRouteCoverageViolations(table, EXCEPTIONS);
    expect(violations).toEqual([]);
  });

  // Every route gated on a SYSTEM-ORG-ONLY permission must also run
  // `requireSystemOrg` and demand an MFA-grade session — i.e. be wired with
  // `requireSystemOrgPermission`, which composes all three so a route cannot
  // forget one. Token confinement already drops those permissions from a
  // tenant-scoped token, so this is the second half of an AND: the claim-only
  // org check costs nothing per request and does not depend on confinement
  // being applied correctly at every minting site.
  //
  // This assertion used to run in only two services, which is exactly how the
  // platform-operations permissions arrived without it. No exception list.
  it('guards every system-org-only route to the system org with aal2', () => {
    expect(findSystemOrgGuardViolations(table)).toEqual([]);
  });

  // The same rule for a route whose authority is resolved in its HANDLER.
  // `dynamicAuthz` is the only thing that puts such a route on the table at all
  // — its row otherwise reads `systemAdmin: false, permissions: []`, which is
  // indistinguishable from "merely authenticated" — so the declaration has to be
  // answerable: every dynamic rule names the principal KINDS it admits, and one
  // admitting a system-org principal names the permission ids it consults.
  //
  // This service has no dynamic route today, so it passes trivially. It is wired
  // anyway, for the same reason `findSystemOrgGuardViolations` is: that check ran
  // in two of ten services, which is exactly how the platform-operations
  // permissions shipped without it. A guard present before the first such route
  // exists bites the day one lands; a guard added afterwards is a guard somebody
  // has to remember.
  it('declares who every dynamically-authorized route admits', () => {
    expect(findDynamicAuthzViolations(table)).toEqual([]);
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
