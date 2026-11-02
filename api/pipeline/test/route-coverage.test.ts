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
  findRouteCoverageViolations, findSystemOrgGuardViolations,
  findQuotaCoverageViolations,
  type QuotaCoverageException,
  type RouteCoverageException,
} from '@pipeline-builder/api-core/testing';

process.env.JWT_SECRET ||= 'route-coverage-test-secret';

const here = dirname(fileURLToPath(import.meta.url));
const snapshotFile = resolve(here, '../../../frontend/src/generated/route-table/pipeline.json');

/** Routes that legitimately can't satisfy a rule, each with its reason. */
const EXCEPTIONS: RouteCoverageException[] = [
  ...INFRA_ROUTE_EXCEPTIONS,
  {
    method: 'POST',
    path: '/pipeline-templates/:id/instantiate',
    waive: 'audit',
    reason: 'Read-only: renders a template\'s props for the editor and persists nothing (gated on templates:read).',
  },
  {
    method: 'POST',
    path: /^POST \/pipelines\/generate/,
    waive: 'audit',
    reason: 'AI generation returns a draft config; nothing is persisted (creating it goes through POST /pipelines, which is audited).',
  },
  {
    method: 'POST',
    path: '/pipelines/:id/plugin-upgrades/preview',
    waive: 'audit',
    reason: 'Read-only: lists the steps an apply would rewrite and persists nothing (gated on pipelines:read). The apply is audited.',
  },
  {
    method: 'POST',
    path: '/pipelines/validate',
    waive: 'audit',
    reason: 'Read-only: reports whether a create would land and persists nothing. Its compliance check is a dryRun (no audit event, no notification) precisely so validating does not appear in the trail as a create attempt.',
  },
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

describe('pipeline route coverage', () => {
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

  it('has no stale coverage exceptions', () => {
    const { unusedExceptions } = findRouteCoverageViolations(table, EXCEPTIONS);
    expect(unusedExceptions).toEqual([]);
  });

  it('declares only audit actions platform accepts from a service', () => {
    const unknown = declaredAuditActions(table).filter((a) => !(REMOTE_AUDIT_ACTIONS as readonly string[]).includes(a));
    expect(unknown).toEqual([]);
  });

  it('matches the route table the frontend reads', () => {
    expect(compareRouteTableSnapshot(table, snapshotFile)).toBeNull();
  });
});
