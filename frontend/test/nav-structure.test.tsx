// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The dashboard's information architecture.
 *
 * One declaration (`NAV_SECTIONS`) feeds four surfaces: the sidebar, the avatar
 * menu, the Help ("?") menu and ⌘K. This file pins the shape of each:
 *
 *  - the sidebar sections, in order, and Platform's four sub-groups;
 *  - the account and help entries live in the top-bar menus, not the sidebar
 *    (no Settings section);
 *  - every entry points at a page that exists, the tabbed ones by their tab
 *    (Inbox, Members, Usage & billing, Org settings);
 *  - exactly one sidebar row is active for any URL.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, within } from '@testing-library/react';
import type { User } from '../src/types';

jest.mock('@/hooks/useAuth', () => require('./helpers/pageMocks').authModule(() => ({ isReadOnly: false, user: mockViewer })));
jest.mock('@/hooks/useBillingEnabled', () => ({ __esModule: true, useBillingEnabled: () => true }));
jest.mock('@/hooks/useFeatures', () => ({
  __esModule: true,
  useFeatures: () => ({ isEnabled: () => true, isLoaded: true, isSuperAdmin: true }),
}));
jest.mock('@/lib/api', () => ({ __esModule: true, default: { listPlugins: () => Promise.reject(new Error('offline')) } }));
jest.mock('@/lib/api-cache', () => ({ __esModule: true, queries: { listPipelines: () => ({}) }, invalidate: {} }));
jest.mock('@/lib/query-cache', () => ({
  __esModule: true,
  runQuery: () => Promise.reject(new Error('offline')),
  clearQueryCache: () => {},
}));
const push = jest.fn<AnyFn>();
jest.mock('next/router', () => require('./helpers/pageMocks').routerModule(() => ({ push, query: {}, pathname: '/dashboard' })));

import {
  NAV_SECTIONS,
  QUICK_ACTIONS,
  SIDEBAR_SECTIONS,
  ACCOUNT_MENU_SECTION,
  HELP_MENU_SECTION,
  activeNavItem,
  groupNavItems,
  isNavItemVisible,
  type NavItem,
} from '../src/lib/nav';
import { TABBED_PAGES } from '../src/lib/tabbed-pages';
import { Sidebar } from '../src/components/ui/Sidebar';
import { AvatarMenu } from '../src/components/ui/AvatarMenu';
import { HelpMenu } from '../src/components/ui/HelpMenu';
import { CommandPalette } from '../src/components/ui/CommandPalette';

/** A system-org superadmin: sees every row the nav has. */
const mockViewer = {
  id: 'u1',
  username: 'dana',
  email: 'dana@acme.test',
  isSuperAdmin: true,
  role: 'owner',
  organizationId: '000000000000000000000001',
  isSystemOrg: true,
  permissions: [],
};
const viewer = mockViewer as unknown as User;

const sidebarProps = {
  isSuperAdmin: true,
  isAdmin: true,
  user: viewer,
  unreadCount: 0,
  currentPath: '/dashboard',
};

const sidebarTitles = (label: string) =>
  SIDEBAR_SECTIONS.find((s) => s.label === label)!.items.filter((i) => !i.paletteOnly).map((i) => i.title);
const allItems = (): NavItem[] => NAV_SECTIONS.flatMap((s) => s.items);
const byTitle = (title: string) => {
  const item = allItems().find((i) => i.title === title);
  if (!item) throw new Error(`no nav item titled ${title}`);
  return item;
};

beforeEach(() => { push.mockClear(); });

describe('sidebar sections', () => {
  it('runs Home → Build → Run → Insights → Organization → Platform, with no Settings section', () => {
    expect(SIDEBAR_SECTIONS.map((s) => s.label)).toEqual(['Home', 'Build', 'Run', 'Insights', 'Organization', 'Platform']);
  });

  it('lists the agreed rows in each section', () => {
    expect(sidebarTitles('Home')).toEqual(['Dashboard', 'Inbox', 'My services', 'Support']);
    expect(sidebarTitles('Build')).toEqual(['Pipelines', 'Templates', 'Plugins', 'Publisher']);
    expect(sidebarTitles('Run')).toEqual(['Deployments', 'Executions', 'Builds', 'Logs', 'Observability']);
    expect(sidebarTitles('Insights')).toEqual(['Reports', 'Compliance', 'Audit log']);
    expect(sidebarTitles('Organization')).toEqual(['Members', 'Usage & billing', 'Org settings']);
  });

  it('splits Platform into four sub-groups, in order', () => {
    const platform = SIDEBAR_SECTIONS.find((s) => s.label === 'Platform')!;
    const groups = groupNavItems(platform.items.filter((i) => !i.paletteOnly));
    expect(groups.map((g) => [g.group, g.items.map((i) => i.title)])).toEqual([
      ['Tenants', ['All organizations', 'All users']],
      ['Catalog', ['Registry', 'Toolchain', 'Ecosystem', 'Plugin retention', 'Runner signing keys']],
      ['Commerce', ['Billing admin', 'Campaigns', 'Discounts', 'Promotions', 'Offers']],
      ['Operations', ['Support queue', 'Cascade outbox', 'Platform settings']],
    ]);
    // Every Platform entry, palette-only ones included, belongs to a group.
    expect(platform.items.filter((i) => !i.group).map((i) => i.title)).toEqual([]);
    expect(byTitle('SSO roster')).toMatchObject({ paletteOnly: true, group: 'Tenants' });
  });

  it('keeps the palette-only sub-pages palette-only', () => {
    for (const title of ['Build triage', 'Alerts', 'Alert rules', 'Alert destinations', 'Audit activity', 'SSO roster']) {
      expect({ title, paletteOnly: byTitle(title).paletteOnly }).toEqual({ title, paletteOnly: true });
    }
  });
});

describe('top-bar menus', () => {
  it('puts the account entries in the avatar menu, Profile first', () => {
    expect(ACCOUNT_MENU_SECTION.items.map((i) => [i.title, i.href])).toEqual([
      ['Profile', '/dashboard/settings?tab=profile'],
      ['Security', '/dashboard/security'],
      ['Notification preferences', '/dashboard/notifications'],
    ]);
  });

  it('puts Help, API catalog and Downloads in the Help menu', () => {
    expect(HELP_MENU_SECTION.items.map((i) => [i.title, i.href])).toEqual([
      ['Help', '/dashboard/help'],
      ['API catalog', '/dashboard/api-catalog'],
      ['Downloads', '/dashboard/downloads'],
    ]);
  });

  it('keeps every menu entry out of the sidebar rows', () => {
    render(<Sidebar {...sidebarProps} />);
    // The quick-action row keeps its "Get the CLI" shortcut; only nav ROWS count.
    const quick = new Set(QUICK_ACTIONS.map((qa) => qa.href));
    const hrefs = within(screen.getByRole('navigation')).queryAllByRole('link')
      .map((a) => a.getAttribute('href'))
      .filter((href) => !quick.has(href ?? ''));
    for (const item of [...ACCOUNT_MENU_SECTION.items, ...HELP_MENU_SECTION.items]) {
      expect(hrefs).not.toContain(item.href);
    }
  });

  it('avatar menu opens on click and lists account links, theme and sign out', () => {
    const onLogout = jest.fn<AnyFn>();
    const onToggleDark = jest.fn<AnyFn>();
    render(<AvatarMenu user={viewer} isDark={false} onToggleDark={onToggleDark} onLogout={onLogout} />);
    const trigger = screen.getByRole('button', { name: /account menu/i });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(trigger);
    const menu = screen.getByRole('menu');
    expect(within(menu).getByText('dana')).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Profile' })).toHaveAttribute('href', '/dashboard/settings?tab=profile');
    expect(within(menu).getByRole('menuitem', { name: 'Security' })).toHaveAttribute('href', '/dashboard/security');
    expect(within(menu).getByRole('menuitem', { name: 'Notification preferences' })).toHaveAttribute('href', '/dashboard/notifications');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Dark mode' }));
    expect(onToggleDark).toHaveBeenCalled();
    fireEvent.click(trigger);
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Sign out' }));
    expect(onLogout).toHaveBeenCalled();
  });

  it('avatar menu closes on Escape and returns focus to its trigger', () => {
    render(<AvatarMenu user={viewer} isDark={false} onToggleDark={jest.fn<AnyFn>()} onLogout={jest.fn<AnyFn>()} />);
    const trigger = screen.getByRole('button', { name: /account menu/i });
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('help menu lists Help, API catalog, Downloads and the shortcuts overlay', () => {
    render(<HelpMenu />);
    fireEvent.click(screen.getByRole('button', { name: 'Help and resources' }));
    const menu = screen.getByRole('menu');
    expect(within(menu).getAllByRole('menuitem').map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['Help', '/dashboard/help'],
      ['API catalog', '/dashboard/api-catalog'],
      ['Downloads', '/dashboard/downloads'],
      // Not a page: opens the shortcuts overlay (also on `?`).
      ['Keyboard shortcuts', null],
    ]);
  });
});

describe('canonical merged URLs', () => {
  it.each([
    ['Inbox', '/dashboard/inbox'],
    ['Members', '/dashboard/members'],
    ['Usage & billing', '/dashboard/usage'],
    ['Org settings', '/dashboard/settings?tab=organization'],
    ['Messages', '/dashboard/inbox?tab=messages'],
    ['Access requests', '/dashboard/inbox?tab=access-requests'],
    ['Teams', '/dashboard/members?tab=teams'],
    ['Roles', '/dashboard/members?tab=roles'],
    ['Invitations', '/dashboard/members?tab=invitations'],
    ['Quotas', '/dashboard/usage?tab=quotas'],
    ['Billing', '/dashboard/usage?tab=billing'],
  ])('%s points at %s', (title, href) => {
    expect(byTitle(title).href).toBe(href);
  });

  it('every entry links a page that exists', () => {
    const missing = allItems()
      .map((i) => i.href.split(/[?#]/)[0])
      .filter((path) => !['', '/index'].some((suffix) => existsSync(resolve(__dirname, '..', `pages${path}${suffix}.tsx`))));
    expect(missing).toEqual([]);
  });

  it('keeps each merged tab on its own gate', () => {
    expect(byTitle('Messages').requiredPermission).toBe('messages:read');
    expect(byTitle('Access requests').requiredPermission).toBeUndefined();
    expect(byTitle('Teams').requiredPermission).toBe('members:manage');
    expect(byTitle('Roles').requiredPermission).toBe('roles:manage');
    expect(byTitle('Invitations').requiredPermission).toBe('invitations:manage');
    expect(byTitle('Quotas').requiredPermission).toBe('quotas:read');
    expect(byTitle('Billing')).toMatchObject({ requiredPermission: 'billing:read', requiresBillingEnabled: true });
  });

  it('shows a merged page to anyone holding one of its tabs', () => {
    expect(byTitle('Members').requiredAnyPermission).toEqual(['members:manage', 'roles:manage', 'invitations:manage']);
    // Usage & billing is an OR of whole gates: its billing tab also needs the
    // billing SERVICE, so `billing:read` alone counts only where billing runs.
    expect(byTitle('Usage & billing').requiredAnyPermission).toBeUndefined();
    expect(byTitle('Usage & billing').requiredAnyOf).toEqual([
      { permission: 'quotas:read' },
      { permission: 'billing:read', requiresBillingEnabled: true },
    ]);
  });

  describe('Usage & billing visibility', () => {
    const usage = () => byTitle('Usage & billing');
    const ctx = (permissions: string[], billingEnabled: boolean) => ({
      isAdmin: false,
      isSuperAdmin: false,
      billingEnabled,
      hasPermission: (p: string) => permissions.includes(p),
    });
    it.each([
      [['quotas:read'], false, true],
      [['quotas:read'], true, true],
      [['billing:read'], true, true],
      [['billing:read'], false, false],
      [[], true, false],
      [['quotas:read', 'billing:read'], false, true],
    ] as const)('permissions %j, billing enabled %p -> visible %p', (perms, billingEnabled, visible) => {
      expect(isNavItemVisible(usage(), ctx([...perms], billingEnabled) as never)).toBe(visible);
    });

    it('agrees with the tab table: visible exactly when at least one tab would show', () => {
      for (const perms of [[], ['quotas:read'], ['billing:read'], ['quotas:read', 'billing:read']]) {
        for (const billingEnabled of [true, false]) {
          const anyTab = TABBED_PAGES['/dashboard/usage'].some((t) =>
            (!t.permission || perms.includes(t.permission)) && (!t.requiresBillingEnabled || billingEnabled));
          expect({ perms, billingEnabled, visible: isNavItemVisible(usage(), ctx(perms, billingEnabled) as never) })
            .toEqual({ perms, billingEnabled, visible: anyTab });
        }
      }
    });

    it('keeps the palette-only Billing entry on the billing service', () => {
      expect(byTitle('Billing').requiresBillingEnabled).toBe(true);
      expect(isNavItemVisible(byTitle('Billing'), ctx(['billing:read'], false) as never)).toBe(false);
    });
  });

  it('agrees with the merged pages\' own tab table', () => {
    // Each palette entry for a tab carries that tab's gate…
    for (const item of allItems()) {
      const [path, query] = item.href.split('?');
      const tabs = TABBED_PAGES[path];
      if (!tabs || !query) continue;
      const tab = tabs.find((t) => t.id === new URLSearchParams(query).get('tab'));
      expect({ href: item.href, tab: tab?.id, permission: item.requiredPermission })
        .toEqual({ href: item.href, tab: expect.any(String), permission: tab?.permission });
    }
    // …and a merged page's row shows for exactly the permissions its tabs need.
    const tabPerms = (path: string) => [...new Set(TABBED_PAGES[path].map((t) => t.permission))];
    expect(byTitle('Members').requiredAnyPermission).toEqual(tabPerms('/dashboard/members'));
    expect(byTitle('Usage & billing').requiredAnyOf?.map((g) => g.permission)).toEqual(tabPerms('/dashboard/usage'));
    // Inbox has ungated tabs, so its row is ungated.
    expect(TABBED_PAGES['/dashboard/inbox'].some((t) => !t.permission)).toBe(true);
    expect(byTitle('Inbox').requiredPermission ?? byTitle('Inbox').requiredAnyPermission).toBeUndefined();
  });

  it('moves the org-level settings pages under Organization, palette-only', () => {
    const org = SIDEBAR_SECTIONS.find((s) => s.label === 'Organization')!;
    expect(org.items.find((i) => i.title === 'Single sign-on')).toMatchObject({ href: '/dashboard/settings/sso', paletteOnly: true });
    expect(org.items.find((i) => i.title === 'Incident reporting')).toMatchObject({ href: '/dashboard/settings/incident-reporting', paletteOnly: true });
  });
});

describe('active row', () => {
  const sidebarItems = SIDEBAR_SECTIONS.flatMap((s) => s.items).filter((i) => !i.paletteOnly);
  it.each([
    ['/dashboard', 'Dashboard'],
    ['/dashboard/inbox', 'Inbox'],
    ['/dashboard/inbox?tab=messages', 'Inbox'],
    ['/dashboard/members?tab=roles', 'Members'],
    ['/dashboard/usage?tab=billing', 'Usage & billing'],
    ['/dashboard/settings?tab=organization', 'Org settings'],
    ['/dashboard/settings?tab=organization&section=pipelines', 'Org settings'],
    ['/dashboard/settings/sso', 'Org settings'],
    ['/dashboard/settings/incident-reporting', 'Org settings'],
    ['/dashboard/pipelines/abc', 'Pipelines'],
    ['/dashboard/triage', 'Builds'],
    ['/dashboard/observability/alerts', 'Observability'],
    ['/dashboard/observability/audit-activity', 'Audit log'],
    ['/dashboard/admin/ecosystem', 'Ecosystem'],
    ['/dashboard/admin/ecosystem?tab=storage&section=retention', 'Plugin retention'],
    ['/dashboard/discounts', 'Discounts'],
    ['/dashboard/admin/billing', 'Billing admin'],
    ['/dashboard/admin/settings', 'Platform settings'],
  ])('%s highlights %s', (path, title) => {
    expect(activeNavItem(sidebarItems, path)?.title).toBe(title);
  });

  it.each(['/dashboard/settings?tab=profile', '/dashboard/settings', '/dashboard/security', '/dashboard/help'])(
    '%s highlights no sidebar row (it lives in a top-bar menu)',
    (path) => { expect(activeNavItem(sidebarItems, path)).toBeUndefined(); },
  );

  it('marks exactly one rendered link as the current page', () => {
    render(<Sidebar {...sidebarProps} currentPath="/dashboard/inbox?tab=messages" />);
    const current = within(screen.getByRole('navigation')).getAllByRole('link').filter((a) => a.getAttribute('aria-current') === 'page');
    expect(current.map((a) => a.getAttribute('href'))).toEqual(['/dashboard/inbox']);
  });

  it('expands a collapsed Platform sub-group that holds the current page', () => {
    render(<Sidebar {...sidebarProps} currentPath="/dashboard/discounts" />);
    const commerce = screen.getByRole('button', { name: /commerce/i });
    expect(commerce).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(commerce);
    expect(commerce).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('link', { name: 'Discounts' })).not.toBeInTheDocument();
    // The other groups are untouched.
    expect(screen.getByRole('link', { name: 'Registry' })).toBeInTheDocument();
  });
});

describe('unread count', () => {
  it('rides the Inbox row', () => {
    render(<Sidebar {...sidebarProps} unreadCount={4} />);
    expect(screen.getByRole('link', { name: /inbox/i })).toHaveAccessibleName('Inbox 4 unread');
  });
});

describe('command palette', () => {
  const openPalette = () => {
    render(<CommandPalette isSuperAdmin isAdmin isDark={false} onToggleDark={jest.fn<AnyFn>()} />);
    fireEvent.keyDown(document, { key: 'k', metaKey: true });
    return screen.getByRole('listbox');
  };

  it.each([
    ['profile', 'Go to Profile', '/dashboard/settings?tab=profile'],
    ['api catalog', 'Go to API catalog', '/dashboard/api-catalog'],
    ['cli', 'Go to Downloads', '/dashboard/downloads'],
    ['notification preferences', 'Go to Notification preferences', '/dashboard/notifications'],
    ['roles', 'Go to Roles', '/dashboard/members?tab=roles'],
    ['stripe', 'Go to Billing', '/dashboard/usage?tab=billing'],
    ['saml', 'Go to Single sign-on', '/dashboard/settings/sso'],
  ])('finds %p', (query, option, href) => {
    const list = openPalette();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: query } });
    fireEvent.click(within(list).getByRole('option', { name: option }));
    expect(push).toHaveBeenCalledWith(href);
  });

  it('finds a Platform page by its sub-group name', () => {
    const list = openPalette();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'commerce' } });
    expect(within(list).getByRole('option', { name: 'Go to Campaigns' })).toBeInTheDocument();
  });
});
