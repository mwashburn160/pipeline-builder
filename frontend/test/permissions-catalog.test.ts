// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Drift guard for the frontend permission catalog.
 *
 * `src/lib/permissions.ts` is a hand-maintained mirror of api-core's catalog
 * (types/permissions.ts). We deliberately don't import the server package here
 * (it would pull express/jwt into the Next.js test bundle), so instead this
 * test pins the invariant locally:
 *   - every id is a well-formed `resource:action` pair,
 *   - ids are unique,
 *   - the id set matches the known catalog exactly.
 *
 * If you add/rename/remove a permission, update BOTH this list AND the backend
 * catalog in the same change — a mismatch here is the signal that the mirror
 * has drifted. The backend validates every permission against ITS catalog, so
 * an out-of-sync entry can never grant anything unknown, but it can silently
 * fail to gate UI, which is what this test catches.
 */
import { PERMISSION_CATALOG, PERMISSION_CATEGORIES, permissionLabel } from '../src/lib/permissions';

// The canonical id set. Kept in sync with api-core's PERMISSION_CATALOG.
const KNOWN_IDS = [
  'pipelines:read',
  'pipelines:write',
  'plugins:read',
  'plugins:write',
  'compliance:read',
  'compliance:write',
  'members:manage',
  'groups:manage',
  'invitations:manage',
  'dashboards:read',
  'dashboards:write',
  'observability:read',
  'observability:write',
  'reports:read',
  'messages:read',
  'messages:write',
  'billing:read',
  'billing:manage',
  'quotas:read',
  'registry:read',
  'registry:write',
  'org:settings',
] as const;

describe('PERMISSION_CATALOG parity', () => {
  const ids = PERMISSION_CATALOG.map((p) => p.id);

  it('every id matches the resource:action shape', () => {
    const shape = /^[a-z]+:[a-z]+$/;
    for (const id of ids) {
      expect(id).toMatch(shape);
    }
  });

  it('has no duplicate ids', () => {
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('matches the known catalog id set exactly (no drift)', () => {
    // Order-independent equality: a missing OR extra id fails the test and
    // names the offender.
    expect([...ids].sort()).toEqual([...KNOWN_IDS].sort());
  });

  it('gives every entry a non-empty label, description, and category', () => {
    for (const p of PERMISSION_CATALOG) {
      expect(p.label.trim().length).toBeGreaterThan(0);
      expect(p.description.trim().length).toBeGreaterThan(0);
      expect(p.category.trim().length).toBeGreaterThan(0);
    }
  });

  it('groups every catalog entry into exactly one category (no loss)', () => {
    const grouped = PERMISSION_CATEGORIES.flatMap((c) => c.permissions.map((p) => p.id));
    expect([...grouped].sort()).toEqual([...ids].sort());
  });

  it('permissionLabel resolves known ids and falls back to the raw id', () => {
    expect(permissionLabel('plugins:write')).toBe('Manage plugins');
    expect(permissionLabel('does:notexist')).toBe('does:notexist');
  });
});
