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
} from '@pipeline-builder/api-core/testing';

process.env.JWT_SECRET ||= 'route-coverage-test-secret';
// `src/config.ts` throws without it; nothing here connects to Mongo.
process.env.MONGODB_URI ||= 'mongodb://localhost:27017/route-coverage-test';

const here = dirname(fileURLToPath(import.meta.url));
const snapshotFile = resolve(here, '../../../frontend/src/generated/route-table/quota.json');

/** Routes that legitimately can't satisfy a rule, each with its reason. */
const EXCEPTIONS: RouteCoverageException[] = [
  ...INFRA_ROUTE_EXCEPTIONS,
  {
    method: 'POST',
    path: '/quotas/:orgId/increment',
    waive: 'all',
    reason: 'Internal S2S counter reserve (#14): `requireInternalCaller` admits only a named internal service — no user token, not even a superadmin\'s — and a usage-counter tick carries no audit value; the ACTION that consumed the quota is audited by its own service.',
  },
  {
    method: 'POST',
    path: '/quotas/:orgId/decrement',
    waive: 'all',
    reason: 'Internal S2S rollback of a reserve — same `requireInternalCaller` gate and same reasoning as /increment (it only undoes a counter tick).',
  },
];

/**
 * The INTERNAL routes this service exposes (#14) and the services allowed to
 * call them — the same list `deploy/*​/k8s/istio-internal-routes.yaml` names, and
 * the ONE place it is written down. `findInternalRouteViolations` checks it
 * against the code in both directions, so a new internal route, or a widened
 * caller list, cannot land here unnoticed.
 *
 * Every service meters its own inbound traffic through api-core's quota client,
 * so the caller list is the whole internal fleet. What it excludes is every USER
 * token (a member who could move their own counters would defeat the caps
 * outright) and anything without a service identity.
 */
const INTERNAL_ROUTES: InternalRouteDeclaration[] = (() => {
  const fleet = ['ask', 'billing', 'compliance', 'image-registry', 'message',
    'pipeline', 'platform', 'plugin', 'quota', 'reporting'];
  return [
    { method: 'POST', path: '/quotas/:orgId/increment', callers: fleet },
    { method: 'POST', path: '/quotas/:orgId/decrement', callers: fleet },
  ];
})();

let table: RouteTableEntry[];

beforeAll(async () => {
  const [{ createApp }, { mountRoutes }] = await Promise.all([
    import('@pipeline-builder/api-server'),
    import('../src/app-routes.js'),
  ]);
  const { app } = createApp({ enableOpenApi: false });
  mountRoutes(app);
  table = buildRouteTable(app);
});

describe('quota route coverage', () => {
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
