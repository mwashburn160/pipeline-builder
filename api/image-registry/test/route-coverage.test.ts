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
import { jest, describe, it, expect, beforeAll } from '@jest/globals';
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
// `src/config/index.ts` validates these at import; nothing here signs a token
// or talks to a registry — only the route table is built.
process.env.IMAGE_REGISTRY_HOST ||= 'registry.invalid';
process.env.REGISTRY_TOKEN_PRIVATE_KEY ||= 'route-coverage-test-key';
process.env.REGISTRY_TOKEN_CERTIFICATE ||= 'route-coverage-test-cert';

// The token signer parses REGISTRY_TOKEN_CERTIFICATE into an `x5c` chain at
// import time, which needs real x509 material this test has no use for (it
// never issues a token). Stub the two bindings `routes/token.ts` links against;
// the route table is unaffected.
jest.unstable_mockModule('../src/services/token-service.js', () => ({
  authorizeAndIssue: jest.fn(async () => ({ token: '', accessCount: 0 })),
  parseScope: jest.fn(() => null),
}));

const here = dirname(fileURLToPath(import.meta.url));
const snapshotFile = resolve(here, '../../../frontend/src/generated/route-table/image-registry.json');

/** Routes that legitimately can't satisfy a rule, each with its reason. */
const EXCEPTIONS: RouteCoverageException[] = [
  ...INFRA_ROUTE_EXCEPTIONS,
  {
    method: 'GET',
    path: '/token',
    waive: 'all',
    reason: 'The Docker registry token endpoint (Distribution token-auth spec) — pre-auth by design: it verifies `Authorization: Basic` credentials itself (resolveIdentity, rate-limited per IP + username) and mints the scoped registry JWT, so it cannot sit behind requireAuth or a permission a caller does not yet have.',
  },
];

/**
 * This service's INTERNAL routes and the services allowed to call them — the ONE
 * place it is written down. `findInternalRouteViolations` checks it against the
 * code in both directions, so a new internal route, or a widened caller list,
 * cannot land here unnoticed.
 *
 * Plugin-image signing is the plugin build worker's alone: the signing key is
 * what synth trusts, so no user token and no other service may request it.
 */
const INTERNAL_ROUTES: InternalRouteDeclaration[] = [
  { method: 'POST', path: '/internal/plugin-signatures', callers: ['plugin'] },
];

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

describe('image-registry route coverage', () => {
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

  it('admits only the declared callers on every internal route', () => {
    expect(findInternalRouteViolations(table, INTERNAL_ROUTES)).toEqual([]);
  });

  it('declares only audit actions platform accepts from a service', () => {
    const unknown = declaredAuditActions(table).filter((a) => !(REMOTE_AUDIT_ACTIONS as readonly string[]).includes(a));
    expect(unknown).toEqual([]);
  });

  it('matches the route table the frontend reads', () => {
    expect(compareRouteTableSnapshot(table, snapshotFile)).toBeNull();
  });
});
