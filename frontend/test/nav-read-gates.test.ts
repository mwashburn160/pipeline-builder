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

// Mirrors the wiring in Sidebar/CommandPalette: admin flags off, and permission
// checks delegated to the real `hasPermission(user, ...)`.
type FakeUser = { permissions?: string[]; isSuperAdmin?: boolean; features?: string[] };
const ctx = (user: FakeUser | null) => ({
  isAdmin: false,
  isSuperAdmin: !!user?.isSuperAdmin,
  // Billing SERVICE is enabled in this deployment, so the `requiresBillingEnabled`
  // gate is satisfied and these tests exercise the permission gate in isolation.
  billingEnabled: true,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  hasPermission: (p: string) => hasPermission(user as any, p),
  // Mirrors `useFeatures().isEnabled` — a per-org entitlement set. Superadmins
  // bypass this in `isNavItemVisible`, so their features list is irrelevant.
  isFeatureEnabled: (f: string) => !!user?.features?.includes(f),
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

// The SSO nav item is feature-gated (`requiredFeature: 'sso'`) on TOP of the
// `org:settings` permission. `isNavItemVisible` bypasses the feature gate for
// superadmins, matching the page which now treats superadmins as entitled — so
// nav visibility and page access agree.
describe('SSO nav feature-entitlement gate', () => {
  const SSO = '/dashboard/settings/sso';

  it('declares the sso feature + org:settings permission', () => {
    const item = findItem(SSO);
    expect(item.requiredFeature).toBe('sso');
    expect(item.requiredPermission).toBe('org:settings');
  });

  it('hides SSO from a permitted-but-non-entitled non-superadmin', () => {
    const user = { permissions: ['org:settings'], features: [] };
    expect(isNavItemVisible(findItem(SSO), ctx(user))).toBe(false);
  });

  it('shows SSO once the sso entitlement is present', () => {
    const user = { permissions: ['org:settings'], features: ['sso'] };
    expect(isNavItemVisible(findItem(SSO), ctx(user))).toBe(true);
  });

  it('shows SSO to a superadmin whose org lacks the sso entitlement', () => {
    const user = { permissions: [], features: [], isSuperAdmin: true };
    expect(isNavItemVisible(findItem(SSO), ctx(user))).toBe(true);
  });
});
