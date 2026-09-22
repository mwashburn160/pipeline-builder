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
  findSystemOrgGuardViolations,
  type InternalRouteDeclaration,
  type RouteCoverageException,
} from '@pipeline-builder/api-core/testing';

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
  {
    method: 'POST',
    path: '/internal/quarantine/:submissionId/credential',
    waive: 'audit',
    reason: 'Mints the short-lived, registry-only credential ONE anonymous submission build pushes with (E21). It changes no durable state and grants nothing beyond `quarantine/<submissionId>` (+ base-image pulls); the submission gate run it serves is audited by the plugin service, and the quarantine repo\'s deletion by registry.gc. Plugin-only via requireInternalService.',
  },
  {
    method: 'POST',
    path: '/internal/plugin-publications/verify-cache/invalidate',
    waive: 'audit',
    reason: 'Drops in-memory signature-verification cache entries so the next lookup re-verifies. It changes no durable state; the actions that trigger it (yank, takedown, tier re-sign) are audited themselves (registry.image.yank / registry.image.resign). Still plugin-only via requireInternalService.',
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
  // Plugin-ecosystem public/* publications (§3.3): the plugin service drives the
  // copy + fresh sign on approval, the tier re-sign job, yank, GC and verification.
  { method: 'POST', path: '/internal/plugin-publications', callers: ['plugin'] },
  { method: 'POST', path: '/internal/plugin-publications/resign', callers: ['plugin'] },
  { method: 'POST', path: '/internal/plugin-publications/yank', callers: ['plugin'] },
  { method: 'POST', path: '/internal/plugin-publications/retag', callers: ['plugin'] },
  { method: 'POST', path: '/internal/plugin-publications/gc', callers: ['plugin'] },
  { method: 'GET', path: '/internal/plugin-publications/verify', callers: ['plugin'] },
  { method: 'POST', path: '/internal/plugin-publications/verify-cache/invalidate', callers: ['plugin'] },
  // Anonymous submissions (§4.2 / W5): the plugin service drops a decided or
  // expired submission's quarantined build.
  { method: 'DELETE', path: '/internal/quarantine/:submissionId', callers: ['plugin'] },
  // …and mints the registry-only credential its quarantine build pushes with (E21).
  { method: 'POST', path: '/internal/quarantine/:submissionId/credential', callers: ['plugin'] },
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

  // Plugin-ecosystem governance (plan §3.0): every route gated on a
  // system-org-only permission (plugins:moderate, publishers:verify) must also
  // run requireSystemOrg and demand aal2 — use requireEcosystemPermission. No
  // exception list: passes today, bites the day a governance route lacks it.
  it('guards every ecosystem-governance route to the system org with aal2', () => {
    expect(findSystemOrgGuardViolations(table)).toEqual([]);
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
