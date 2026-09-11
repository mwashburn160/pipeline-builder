// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The viewer stamp is a security primitive: it is what makes the per-user rungs
 * (template `private`, message per-user targeting) resolve on paths that have
 * nowhere to pass a viewer. These tests pin its two safety properties — it fails
 * CLOSED without a scope, and an explicit value always wins over the context.
 */

import { jest, describe, it, expect } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

const { runWithTenantContext } = await import('../src/database/tenancy.js');
const { withViewerContext, currentViewerUserId } = await import('../src/api/viewer-context.js');

describe('withViewerContext', () => {
  it('stamps the tenant context viewer onto a bare filter', () => {
    const stamped = runWithTenantContext(
      { orgId: 'org-1', userId: 'user-1', isSuperAdmin: false },
      () => withViewerContext({ isActive: true }),
    );
    expect(stamped).toEqual({ isActive: true, viewerUserId: 'user-1', viewerIsSuperAdmin: false });
  });

  it('carries the superadmin flag through', () => {
    const stamped = runWithTenantContext(
      { orgId: 'org-1', userId: 'admin-1', isSuperAdmin: true },
      () => withViewerContext({}),
    );
    expect(stamped.viewerIsSuperAdmin).toBe(true);
  });

  it('fails CLOSED outside a tenant scope', () => {
    // Background jobs, migrations and the retention sweep run scopeless. A
    // viewer-less filter must leave the per-user rung matching NOTHING — an
    // undefined viewer is never a wildcard.
    const stamped = withViewerContext({ isActive: true });
    expect(stamped.viewerUserId).toBeUndefined();
    expect(stamped.viewerIsSuperAdmin).toBe(false);
  });

  it('fails closed when the scope carries no user (service-to-service calls)', () => {
    const stamped = runWithTenantContext(
      { orgId: 'org-1', isSuperAdmin: false },
      () => withViewerContext({}),
    );
    expect(stamped.viewerUserId).toBeUndefined();
  });

  it('lets an EXPLICIT viewer win over the context', () => {
    // Keeps deliberate scoping (and fixed-viewer tests) expressible; the context
    // only fills what the caller left blank.
    const stamped = runWithTenantContext(
      { orgId: 'org-1', userId: 'user-1', isSuperAdmin: false },
      () => withViewerContext({ viewerUserId: 'someone-else', viewerIsSuperAdmin: true }),
    );
    expect(stamped.viewerUserId).toBe('someone-else');
    expect(stamped.viewerIsSuperAdmin).toBe(true);
  });

  it('does not mutate the filter it was given', () => {
    const filter = { isActive: true };
    runWithTenantContext({ orgId: 'org-1', userId: 'user-1', isSuperAdmin: false }, () => withViewerContext(filter));
    expect(filter).toEqual({ isActive: true });
  });
});

describe('currentViewerUserId', () => {
  it('reads the same source the stamp does, so a cache key cannot diverge from its predicate', () => {
    const inside = runWithTenantContext(
      { orgId: 'org-1', userId: 'user-1', isSuperAdmin: false },
      () => ({ direct: currentViewerUserId(), stamped: withViewerContext({}).viewerUserId }),
    );
    expect(inside.direct).toBe('user-1');
    expect(inside.direct).toBe(inside.stamped);
  });

  it('returns undefined outside a scope', () => {
    expect(currentViewerUserId()).toBeUndefined();
  });
});
