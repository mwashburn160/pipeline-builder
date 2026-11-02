// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `pageGateRefuses` must agree with `useAuthGuard` on every declared page.
 *
 * WHY THIS EXISTS. There are now TWO places that answer "would this route refuse
 * this viewer?": the guard, which renders `<AccessDenied>`, and
 * `pageGateRefuses`, which the org switcher calls after a switch to decide
 * whether the current page can come along. If they disagree the switcher either
 * strands someone on a refusal page (the bug it was added to remove) or
 * redirects away from a page that would have worked.
 *
 * The guard's own logic is not importable in isolation — it is a hook wound
 * through routing, onboarding and enrolment — so this re-states its three
 * requirements, in its order, and checks the helper against them for every
 * declared pathname and a spread of viewers. A change to either side that is
 * not mirrored fails here.
 */

import { describe, it, expect } from '@jest/globals';
import { declaredPagePaths, resolvePageGate, pageGateRefuses } from '../src/lib/page-access';

/**
 * The guard's rule, transcribed from `useAuthGuard` (the `accessDenied` ternary):
 * system-admin first, then admin, then the permission.
 */
function guardWouldRefuse(
  pathname: string,
  v: { isSuperAdmin: boolean; isOrgAdmin: boolean; permissions: string[] },
): 'systemAdmin' | 'admin' | 'permission' | null {
  const gate = resolvePageGate(pathname);
  const isAdmin = v.isSuperAdmin || v.isOrgAdmin;
  if (gate.systemAdminOnly && !v.isSuperAdmin) return 'systemAdmin';
  if (gate.adminOnly && !isAdmin) return 'admin';
  // `hasPermission` grants a superadmin everything.
  if (gate.permission && !(v.isSuperAdmin || v.permissions.includes(gate.permission))) return 'permission';
  return null;
}

const VIEWERS = [
  { name: 'superadmin', isSuperAdmin: true, isOrgAdmin: false, permissions: [] as string[] },
  { name: 'org admin, no permissions', isSuperAdmin: false, isOrgAdmin: true, permissions: [] as string[] },
  { name: 'plain member', isSuperAdmin: false, isOrgAdmin: false, permissions: [] as string[] },
];

describe('pageGateRefuses agrees with useAuthGuard', () => {
  it('matches the guard for every declared page and every viewer shape', () => {
    const disagreements: string[] = [];
    for (const path of declaredPagePaths()) {
      for (const v of VIEWERS) {
        const expected = guardWouldRefuse(path, v);
        const actual = pageGateRefuses(path, {
          isSuperAdmin: v.isSuperAdmin,
          isOrgAdmin: v.isOrgAdmin,
          hasPermission: (p) => v.isSuperAdmin || v.permissions.includes(p),
        });
        if (expected !== actual) {
          disagreements.push(`${path} / ${v.name}: guard=${expected} helper=${actual}`);
        }
      }
    }
    expect(disagreements).toEqual([]);
  });

  // Each viewer also gets the page's OWN permission, so the permission branch is
  // exercised as a pass and not only as a refusal.
  it('matches the guard when the viewer holds exactly the page permission', () => {
    const disagreements: string[] = [];
    for (const path of declaredPagePaths()) {
      const gate = resolvePageGate(path);
      if (!gate.permission) continue;
      const v = { isSuperAdmin: false, isOrgAdmin: true, permissions: [gate.permission] };
      const expected = guardWouldRefuse(path, v);
      const actual = pageGateRefuses(path, {
        isSuperAdmin: false,
        isOrgAdmin: true,
        hasPermission: (p) => v.permissions.includes(p),
      });
      if (expected !== actual) disagreements.push(`${path}: guard=${expected} helper=${actual}`);
    }
    expect(disagreements).toEqual([]);
  });

  it('returns null for an undeclared pathname rather than blacking it out', () => {
    expect(pageGateRefuses('/dashboard/not-a-page', {
      isSuperAdmin: false, isOrgAdmin: false, hasPermission: () => false,
    })).toBeNull();
  });

  it('reports the FIRST unmet requirement, so the message names the strongest one', () => {
    // A system-admin page also carries no permission gate; the sysadmin branch
    // must win over everything else for a plain member.
    const sysadminPage = declaredPagePaths().find((p) => resolvePageGate(p).systemAdminOnly);
    expect(sysadminPage).toBeDefined();
    expect(pageGateRefuses(sysadminPage!, {
      isSuperAdmin: false, isOrgAdmin: true, hasPermission: () => true,
    })).toBe('systemAdmin');
  });
});
