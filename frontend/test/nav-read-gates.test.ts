// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Read-permission gates on the main nav.
 *
 * `quotas:read`, `reports:read`, `billing:read`, and `messages:read` are
 * enforced backend-side; the nav must not advertise a page a custom role can't
 * load (it would 403). Both the sidebar and the command palette filter with
 * `isNavItemVisible`, wiring `hasPermission: (p) => hasPermission(user, p)` — so
 * this drives the same helper the consumers do (superadmin bypass included).
 */
import { hasPermission } from '../src/lib/auth-helpers';
import { NAV_SECTIONS, isNavItemVisible, type NavItem } from '../src/lib/nav';

const GATED: Record<string, string> = {
  '/dashboard/quotas': 'quotas:read',
  '/dashboard/reports': 'reports:read',
  '/dashboard/billing': 'billing:read',
  '/dashboard/messages': 'messages:read',
};

function findItem(href: string): NavItem {
  const item = NAV_SECTIONS.flatMap((s) => s.items).find((i) => i.href === href);
  if (!item) throw new Error(`nav item not found: ${href}`);
  return item;
}

// Mirrors the wiring in Sidebar/CommandPalette: features on, admin flags off,
// and permission checks delegated to the real `hasPermission(user, ...)`.
type FakeUser = { permissions?: string[]; isSuperAdmin?: boolean };
const ctx = (user: FakeUser | null) => ({
  isAdmin: false,
  isSuperAdmin: !!user?.isSuperAdmin,
  isFeatureEnabled: () => true,
  // Billing SERVICE is enabled in this deployment, so the `requiresBillingEnabled`
  // gate is satisfied and these tests exercise the permission gate in isolation.
  billingEnabled: true,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  hasPermission: (p: string) => hasPermission(user as any, p),
});

describe('nav read-permission gates', () => {
  it.each(Object.entries(GATED))('%s declares requiredPermission %s', (href, perm) => {
    expect(findItem(href).requiredPermission).toBe(perm);
  });

  it.each(Object.entries(GATED))('hides %s when the custom role lacks %s', (href, perm) => {
    expect(isNavItemVisible(findItem(href), ctx({ permissions: [] }))).toBe(false);
    expect(isNavItemVisible(findItem(href), ctx({ permissions: [perm] }))).toBe(true);
  });

  it('a role holding all four reads sees all four items', () => {
    const user = { permissions: Object.values(GATED) };
    for (const href of Object.keys(GATED)) {
      expect(isNavItemVisible(findItem(href), ctx(user))).toBe(true);
    }
  });

  it('superadmin sees the gated items without holding the reads', () => {
    const user = { permissions: [], isSuperAdmin: true };
    for (const href of Object.keys(GATED)) {
      expect(isNavItemVisible(findItem(href), ctx(user))).toBe(true);
    }
  });
});
