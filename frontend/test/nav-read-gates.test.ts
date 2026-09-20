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
import { NAV_SECTIONS, isNavItemVisible, navItemLockedFeature, type NavItem } from '../src/lib/nav';
import { resolvePageGate } from '../src/lib/page-access';

const GATED: Record<string, string> = {
  '/dashboard/quotas': 'quotas:read',
  '/dashboard/reports': 'reports:read',
  '/dashboard/billing': 'billing:read',
  '/dashboard/messages': 'messages:read',
};

function findItem(href: string, title?: string): NavItem {
  const item = NAV_SECTIONS.flatMap((s) => s.items).find((i) => i.href === href && (!title || i.title === title));
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

// An entitlement is NOT a read gate. `page-access.ts` refuses to turn
// `requiredFeature` into one because a missing entitlement is "this isn't on
// your plan" — a thing the page says, with an upsell. The nav has to agree:
// hiding the row is how an org that isn't on the SSO tier never learns SSO
// exists. So a feature-gated item stays visible and reports its lock, while the
// PERMISSION beside it still removes it outright.
describe('entitlement-gated nav items are locked, not hidden', () => {
  const SSO = '/dashboard/settings/sso';
  const INCIDENTS = '/dashboard/settings/incident-reporting';

  it('declares the sso feature + org:idp permission', () => {
    const item = findItem(SSO);
    expect(item.requiredFeature).toBe('sso');
    expect(item.requiredPermission).toBe('org:idp');
  });

  it('keeps SSO visible for a permitted-but-non-entitled viewer, and marks it locked', () => {
    const user = { permissions: ['org:idp'], features: [] };
    expect(isNavItemVisible(findItem(SSO), ctx(user))).toBe(true);
    expect(navItemLockedFeature(findItem(SSO), ctx(user))).toBe('sso');
  });

  it('unlocks SSO once the sso entitlement is present', () => {
    const user = { permissions: ['org:idp'], features: ['sso'] };
    expect(isNavItemVisible(findItem(SSO), ctx(user))).toBe(true);
    expect(navItemLockedFeature(findItem(SSO), ctx(user))).toBeUndefined();
  });

  it('still HIDES SSO from a viewer without org:idp — a permission is not an upsell', () => {
    const user = { permissions: [], features: ['sso'] };
    expect(isNavItemVisible(findItem(SSO), ctx(user))).toBe(false);
  });

  it('never locks anything for a superadmin, who holds every entitlement', () => {
    const user = { permissions: [], features: [], isSuperAdmin: true };
    expect(isNavItemVisible(findItem(SSO), ctx(user))).toBe(true);
    expect(navItemLockedFeature(findItem(SSO), ctx(user))).toBeUndefined();
  });

  it('locks Incident Reporting for an admin off the advanced_reporting tier', () => {
    const item = findItem(INCIDENTS);
    expect(item.requiredFeature).toBe('advanced_reporting');
    const admin = { ...ctx({ permissions: [], features: [] }), isAdmin: true };
    expect(isNavItemVisible(item, admin)).toBe(true);
    expect(navItemLockedFeature(item, admin)).toBe('advanced_reporting');
    // …and stays hidden from a non-admin, whose gate is a role, not a plan.
    expect(isNavItemVisible(item, ctx({ permissions: [], features: [] }))).toBe(false);
  });

  it('locks nothing that declares no entitlement', () => {
    for (const item of NAV_SECTIONS.flatMap((s) => s.items).filter((i) => !i.requiredFeature)) {
      expect(navItemLockedFeature(item, ctx({ permissions: [], features: [] }))).toBeUndefined();
    }
  });
});

describe('Teams entry point', () => {
  const TEAMS = findItem('/dashboard/members', 'Teams');

  it('is findable in ⌘K by the words people actually type', () => {
    expect(TEAMS.paletteOnly).toBe(true);
    for (const word of ['team', 'hierarchy', 'sub-organization', 'create team']) {
      expect(TEAMS.keywords).toContain(word);
    }
  });

  it('rides the Members page gate, so it never advertises a page that denies', () => {
    expect(TEAMS.requiredPermission).toBe('members:manage');
    expect(isNavItemVisible(TEAMS, ctx({ permissions: [] }))).toBe(false);
    expect(isNavItemVisible(TEAMS, ctx({ permissions: ['members:manage'] }))).toBe(true);
  });

  it('agrees with every other entry that shares its href', () => {
    // `page-access.ts` keys route gates by href, so two entries on one href must
    // declare the same gate or the second silently redefines the first's page gate.
    const byHref = new Map<string, NavItem[]>();
    for (const item of NAV_SECTIONS.flatMap((s) => s.items)) {
      byHref.set(item.href, [...(byHref.get(item.href) ?? []), item]);
    }
    for (const [href, items] of byHref) {
      const gates = items.map((i) => ({
        permission: i.requiredPermission,
        adminOnly: !!i.adminOnly,
        systemAdminOnly: !!i.systemAdminOnly,
      }));
      expect({ href, gates }).toEqual({ href, gates: gates.map(() => gates[0]) });
    }
    expect(resolvePageGate('/dashboard/members')).toEqual({ permission: 'members:manage' });
  });
});

describe('Access Requests nav entry', () => {
  it('is visible to an ordinary member with NO permissions', () => {
    // The person most often asked to approve is the impersonated user, who is
    // usually not an admin. Gating this entry would leave them no way to answer.
    const item = findItem('/dashboard/access-requests');
    expect(item.requiredPermission).toBeUndefined();
    expect(isNavItemVisible(item, ctx({ permissions: [] }))).toBe(true);
  });
});
