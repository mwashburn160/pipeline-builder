// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The tabbed pages (Inbox, Members, Usage & billing) show only the tabs the
 * viewer may see, each with its own gate, and the page itself
 * opens for whoever may see ANY of its tabs.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { render, screen, within } from '@testing-library/react';
import { mockAuthGuard, mockRouter } from './helpers/pageMocks';
import { resolvePageGate, resolveViewGate, pageGateRefuses } from '../src/lib/page-access';
import { TABBED_PAGES, visibleTabIds } from '../src/lib/tabbed-pages';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());
jest.mock('next/router', () => require('./helpers/pageMocks').routerModule());

let billingEnabled: boolean | undefined = true;
jest.mock('@/hooks/useBillingEnabled', () => ({ __esModule: true, useBillingEnabledState: () => billingEnabled }));

// The tab bodies are tested on their own; here only which one mounts matters.
// Each renders the shared tab layout, as the real bodies do, so the tab bar shows.
const stub = (name: string) => ({
  __esModule: true,
  default: (p: { view?: string }) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { TabbedLayout } = require('@/components/ui/TabbedPage');
    return <TabbedLayout title={name}><div data-testid="tab-body">{p.view ?? name}</div></TabbedLayout>;
  },
});
jest.mock('@/components/inbox/NotificationsTab', () => stub('notifications'));
jest.mock('@/components/message/MessagesTab', () => stub('messages'));
jest.mock('@/components/access-requests/AccessRequestsTab', () => stub('access-requests'));
jest.mock('@/components/members/MembersTab', () => stub('members'));
jest.mock('@/components/roles/RolesTab', () => stub('roles'));
jest.mock('@/components/invitations/InvitationsTab', () => stub('invitations'));
jest.mock('@/components/quotas/QuotasTab', () => stub('quotas'));
jest.mock('@/components/billing/BillingTab', () => stub('billing'));

/* eslint-disable @typescript-eslint/no-require-imports */
const InboxPage = () => require('../pages/dashboard/inbox').default;
const MembersPage = () => require('../pages/dashboard/members').default;
const UsagePage = () => require('../pages/dashboard/usage').default;
/* eslint-enable @typescript-eslint/no-require-imports */

const asViewer = (permissions: string[]) => mockAuthGuard({
  user: { id: 'u1', organizationId: 'org-1', permissions },
  can: (p) => permissions.includes(p),
});

const tabNames = () => within(screen.getByRole('tablist')).getAllByRole('tab').map((t) => t.textContent);

describe('tab declarations', () => {
  it('gives each tab its gate', () => {
    const gates = Object.fromEntries(Object.entries(TABBED_PAGES).map(([path, tabs]) => [path, tabs.map((t) => [t.id, t.permission ?? null])]));
    expect(gates).toEqual({
      '/dashboard/inbox': [['notifications', null], ['messages', 'messages:read'], ['access-requests', null]],
      '/dashboard/members': [['members', 'members:manage'], ['teams', 'members:manage'], ['roles', 'roles:manage'], ['invitations', 'invitations:manage']],
      '/dashboard/usage': [['quotas', 'quotas:read'], ['billing', 'billing:read']],
    });
    expect(TABBED_PAGES['/dashboard/usage'].find((t) => t.id === 'billing')?.requiresBillingEnabled).toBe(true);
  });

  it('opens a tabbed page to a holder of ANY tab permission, and refuses one with none', () => {
    const v = (perms: string[]) => ({ isSuperAdmin: false, isOrgAdmin: false, hasPermission: (p: string) => perms.includes(p) });
    expect(pageGateRefuses('/dashboard/members', v(['roles:manage']))).toBeNull();
    expect(pageGateRefuses('/dashboard/members', v(['invitations:manage']))).toBeNull();
    expect(pageGateRefuses('/dashboard/members', v([]))).toBe('permission');
    expect(pageGateRefuses('/dashboard/usage', v(['billing:read']))).toBeNull();
    expect(pageGateRefuses('/dashboard/usage', v([]))).toBe('permission');
    // Notifications and access requests are open, so the inbox is too.
    expect(pageGateRefuses('/dashboard/inbox', v([]))).toBeNull();
    expect(resolvePageGate('/dashboard/members').anyOf).toEqual([
      { permission: 'members:manage' }, { permission: 'members:manage' }, { permission: 'roles:manage' }, { permission: 'invitations:manage' },
    ]);
    expect(resolvePageGate('/dashboard/usage').anyOf).toEqual([
      { permission: 'quotas:read' }, { permission: 'billing:read', requiresBillingEnabled: true },
    ]);
    // Billing counts only while the billing service is on.
    expect(pageGateRefuses('/dashboard/usage', { ...v(['billing:read']), billingEnabled: false })).toBe('permission');
  });

  it('resolves a tab link to that tab gate', () => {
    expect(resolveViewGate('/dashboard/members?tab=roles')).toEqual({ permission: 'roles:manage' });
    expect(resolveViewGate('/dashboard/inbox?tab=messages')).toEqual({ permission: 'messages:read' });
    expect(resolveViewGate('/dashboard/usage?tab=billing&section=plans')).toEqual({ permission: 'billing:read' });
    // No tab named: the page's own gate.
    expect(resolveViewGate('/dashboard/members')).toEqual(resolvePageGate('/dashboard/members'));
  });

  it('drops billing when the billing service is off', () => {
    const has = (perms: string[]) => (p: string) => perms.includes(p);
    expect(visibleTabIds('/dashboard/usage', { hasPermission: has(['quotas:read', 'billing:read']), billingEnabled: false })).toEqual(['quotas']);
    // The page gate refuses this viewer, so no tab is left to show.
    expect(visibleTabIds('/dashboard/usage', { hasPermission: has(['billing:read']), billingEnabled: false })).toEqual([]);
    expect(visibleTabIds('/dashboard/usage', { hasPermission: has(['quotas:read', 'billing:read']), billingEnabled: true })).toEqual(['quotas', 'billing']);
  });
});

describe('tabbed pages render only the tabs the viewer may see', () => {
  beforeEach(() => { billingEnabled = true; mockRouter({ query: {} }); });

  it('Inbox: notifications and access requests for everyone, messages with messages:read', () => {
    asViewer([]);
    mockRouter({ pathname: '/dashboard/inbox', query: {} });
    const Page = InboxPage();
    const { unmount } = render(<Page />);
    expect(tabNames()).toEqual(['Notifications', 'Access requests']);
    expect(screen.getByTestId('tab-body')).toHaveTextContent('notifications');
    unmount();

    asViewer(['messages:read']);
    mockRouter({ pathname: '/dashboard/inbox', query: { tab: 'messages' } });
    render(<Page />);
    expect(tabNames()).toEqual(['Notifications', 'Messages', 'Access requests']);
    expect(screen.getByTestId('tab-body')).toHaveTextContent('messages');
  });

  it('Members: each tab rides its own permission', () => {
    asViewer(['roles:manage']);
    mockRouter({ pathname: '/dashboard/members', query: {} });
    const Page = MembersPage();
    const { unmount } = render(<Page />);
    expect(tabNames()).toEqual(['Roles']);
    expect(screen.getByTestId('tab-body')).toHaveTextContent('roles');
    unmount();

    asViewer(['members:manage', 'invitations:manage']);
    mockRouter({ pathname: '/dashboard/members', query: { tab: 'teams' } });
    render(<Page />);
    expect(tabNames()).toEqual(['Members', 'Teams', 'Invitations']);
    expect(screen.getByTestId('tab-body')).toHaveTextContent('teams');
  });

  it('Members: a link to a tab the viewer cannot see opens the first visible one', () => {
    asViewer(['invitations:manage']);
    mockRouter({ pathname: '/dashboard/members', query: { tab: 'roles' } });
    const Page = MembersPage();
    render(<Page />);
    expect(tabNames()).toEqual(['Invitations']);
    expect(screen.getByTestId('tab-body')).toHaveTextContent('invitations');
  });

  it('Usage & billing: quotas with quotas:read, billing with billing:read and the billing service on', () => {
    asViewer(['quotas:read', 'billing:read']);
    mockRouter({ pathname: '/dashboard/usage', query: { tab: 'billing' } });
    const Page = UsagePage();
    const { unmount } = render(<Page />);
    expect(tabNames()).toEqual(['Quotas', 'Billing']);
    expect(screen.getByTestId('tab-body')).toHaveTextContent('billing');
    unmount();

    billingEnabled = false;
    render(<Page />);
    expect(tabNames()).toEqual(['Quotas']);
    expect(screen.getByTestId('tab-body')).toHaveTextContent('quotas');
  });

  it('renders the denial when the route gate refuses', () => {
    mockAuthGuard({ accessDenied: { kind: 'permission', permission: 'members:manage', pathname: '/dashboard/members' } });
    const Page = MembersPage();
    render(<Page />);
    expect(screen.getByTestId('access-denied')).toBeInTheDocument();
  });
});
