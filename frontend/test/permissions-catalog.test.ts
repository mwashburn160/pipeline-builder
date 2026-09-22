// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The frontend consumes ONE permission catalog: api-core's dependency-free
 * `@pipeline-builder/api-core/permissions` subpath. There is no local mirror to
 * drift any more (the old `src/lib/permissions.ts` copy is gone), so this suite
 * checks the two things that can still break the UI:
 *
 *   1. the subpath resolves and carries the catalog + helpers the picker needs
 *      (a broken `exports`/`typesVersions` entry or a Node-only import creeping
 *      into that module fails here, not at `next build`);
 *   2. the ids the UI gates on are really in the catalog.
 */
import { describe, it, expect } from '@jest/globals';
import {
  ALL_PERMISSIONS,
  ORG_ASSIGNABLE_CATEGORIES,
  PERMISSION_CATALOG,
  isOrgAssignablePermission,
  permissionLabel,
} from '@pipeline-builder/api-core/permissions';

describe('shared permission catalog', () => {
  const ids = PERMISSION_CATALOG.map((p) => p.id);

  it('resolves through the api-core subpath with a complete catalog', () => {
    expect(ids.length).toBeGreaterThan(0);
    expect([...ids].sort()).toEqual([...ALL_PERMISSIONS].sort());
  });

  it('every id is a well-formed resource:action pair, listed once', () => {
    // `resource:action`, both snake_case — the resource may carry an underscore
    // (`service_accounts:manage`); neither half ever carries a separator of its own.
    for (const id of ids) expect(id).toMatch(/^[a-z]+(_[a-z]+)*:[a-z]+(_[a-z]+)*$/);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('exposes labels for the picker and falls back to the raw id', () => {
    expect(permissionLabel('plugins:write')).toBe('Manage plugins');
    expect(permissionLabel('does:notexist')).toBe('does:notexist');
  });

  it('offers only org-assignable permissions in the authoring picker', () => {
    const grouped = ORG_ASSIGNABLE_CATEGORIES.flatMap((c) => c.permissions.map((p) => p.id));
    expect(grouped.every(isOrgAssignablePermission)).toBe(true);
    expect(grouped).not.toContain('registry:read');
    expect(grouped).not.toContain('registry:write');
    // System-org-only ecosystem permissions are never offered to a custom Role.
    expect(grouped).not.toContain('plugins:moderate');
    expect(grouped).not.toContain('publishers:verify');
    expect(grouped).toContain('plugins:install');
  });

  it('contains every permission the dashboard gates on', () => {
    // The ids passed to `can(...)` across the dashboard pages. A rename in
    // api-core that isn't followed here (or vice versa) silently disables a gate.
    const gated = [
      'pipelines:read', 'pipelines:write', 'pipelines:publish',
      'templates:write', 'templates:publish',
      'plugins:write', 'plugins:publish',
      'compliance:write',
      'members:manage', 'roles:manage', 'invitations:manage',
      'dashboards:write', 'observability:write',
      'reports:read', 'reports:rollup',
      'messages:read', 'messages:write',
      'billing:manage',
      'org:settings', 'org:idp', 'org:kms', 'org:impersonation',
    ];
    for (const id of gated) expect(ids).toContain(id);
  });
});
