// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Nav, from the customer's side.
 *
 * Two rules meet here. A PERMISSION the viewer doesn't hold removes the link —
 * the page would refuse them, so the link is a lie. An ENTITLEMENT they don't
 * hold does NOT: "this isn't on your plan" is something the product should say,
 * and the page says it with an upsell. Dropping feature-gated rows meant an org
 * off the SSO tier never learned SSO existed.
 *
 * So the sidebar and ⌘K both keep those rows, dimmed and padlocked — and,
 * because a padlock is invisible to a screen reader, each one says "not
 * included in your plan"/"not on your plan" in its accessible name.
 *
 * Teams is the other half: it had no nav entry at all, so ⌘K couldn't find the
 * word "team" anywhere in the product.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, within } from '@testing-library/react';
import type { User } from '../src/types';

let features: string[] = [];
/** An org admin who may configure SSO (`org:idp`) but whose plan has no `sso`. */
const mockViewer = { id: 'u1', username: 'dana', permissions: ['org:idp', 'members:manage'] };
jest.mock('@/hooks/useAuth', () => require('./helpers/pageMocks').authModule(() => ({ isReadOnly: false, user: mockViewer })));
jest.mock('@/hooks/useBillingEnabled', () => ({ __esModule: true, useBillingEnabled: () => true }));
jest.mock('@/hooks/useFeatures', () => ({
  __esModule: true,
  useFeatures: () => ({ isEnabled: (f: string) => features.includes(f), isLoaded: true, isSuperAdmin: false, canReachBilling: false }),
}));

// ⌘K lazily indexes the org's pipelines/plugins when it opens. Both reads fail
// here, which the palette treats as "stay a pure navigator" — the nav rows under
// test don't depend on them.
jest.mock('@/lib/api', () => ({ __esModule: true, default: { listPlugins: () => Promise.reject(new Error('offline')) } }));
jest.mock('@/lib/api-cache', () => ({ __esModule: true, queries: { listPipelines: () => ({}) }, invalidate: {} }));
jest.mock('@/lib/query-cache', () => ({
  __esModule: true,
  runQuery: () => Promise.reject(new Error('offline')),
  clearQueryCache: () => {},
}));

const push = jest.fn<AnyFn>();
jest.mock('next/router', () => require('./helpers/pageMocks').routerModule(() => ({ push, query: {}, pathname: '/dashboard' })));

import { Sidebar } from '../src/components/ui/Sidebar';
import { CommandPalette } from '../src/components/ui/CommandPalette';

const ssoAdmin = mockViewer as unknown as User;

const sidebarProps = {
  isSuperAdmin: false,
  isAdmin: false,
  user: ssoAdmin,
  unreadCount: 0,
  currentPath: '/dashboard',
  isDark: false,
  onToggleDark: jest.fn<AnyFn>(),
  onLogout: jest.fn<AnyFn>(),
};

beforeEach(() => { features = []; });

describe('Sidebar — an entitlement locks a row, it never deletes it', () => {
  it('keeps Single Sign-On listed, and says in TEXT that it is off-plan', () => {
    render(<Sidebar {...sidebarProps} />);
    const link = screen.getByRole('link', { name: /single sign-on/i });
    // Still a working link: the page behind it renders the FeatureLock upsell.
    expect(link).toHaveAttribute('href', '/dashboard/settings/sso');
    expect(link).toHaveAccessibleName(/single sign-on\s*—\s*not included in your plan/i);
  });

  it('drops the off-plan wording once the org holds the entitlement', () => {
    features = ['sso'];
    render(<Sidebar {...sidebarProps} />);
    expect(screen.getByRole('link', { name: /single sign-on/i })).toHaveAccessibleName('Single sign-on');
  });

  it('still hides it from a viewer without org:idp — a permission is not an upsell', () => {
    render(<Sidebar {...sidebarProps} user={{ id: 'u2', username: 'sam', permissions: [] } as unknown as User} />);
    expect(screen.queryByRole('link', { name: /single sign-on/i })).not.toBeInTheDocument();
  });

  it('names the lock in the collapsed rail too, where the label is hidden', () => {
    render(<Sidebar {...sidebarProps} collapsed />);
    expect(screen.getByRole('link', { name: /single sign-on/i }))
      .toHaveAccessibleName(/single sign-on\s*—\s*not included in your plan/i);
  });
});

/** Opens ⌘K and returns its listbox. */
function openPalette() {
  render(<CommandPalette isSuperAdmin={false} isAdmin={false} isDark={false} onToggleDark={jest.fn<AnyFn>()} />);
  fireEvent.keyDown(document, { key: 'k', metaKey: true });
  return screen.getByRole('listbox');
}

describe('Command palette — locked entries stay findable and legible', () => {
  it('lists the off-plan page with the reason in its option name', () => {
    const list = openPalette();
    const option = within(list).getByRole('option', { name: /go to single sign-on \(not on your plan\)/i });
    // Focus stays in the search input, so aria-activedescendant reads THIS text.
    expect(option).toHaveAttribute('id');
    fireEvent.click(option);
    expect(push).toHaveBeenCalledWith('/dashboard/settings/sso');
  });

  it('reads plainly once the entitlement is held', () => {
    features = ['sso'];
    const list = openPalette();
    expect(within(list).getByRole('option', { name: 'Go to Single sign-on' })).toBeInTheDocument();
    expect(within(list).queryByRole('option', { name: /not on your plan/i })).not.toBeInTheDocument();
  });

  it('finds SSO by acronym, which its title does not contain', () => {
    const list = openPalette();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'saml' } });
    expect(within(list).getByRole('option', { name: /single sign-on/i })).toBeInTheDocument();
  });
});

describe('Command palette — Teams is discoverable at all', () => {
  it('answers a search for "teams"', () => {
    const list = openPalette();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'teams' } });
    const option = within(list).getByRole('option', { name: 'Go to Teams' });
    fireEvent.click(option);
    // Team management lives on the Members page — one route, two names.
    expect(push).toHaveBeenCalledWith('/dashboard/members');
  });

  it.each(['hierarchy', 'sub-organization', 'child org'])('answers a search for %p', (term) => {
    const list = openPalette();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: term } });
    expect(within(list).getByRole('option', { name: 'Go to Teams' })).toBeInTheDocument();
  });

  it('keeps Teams out of the sidebar — Members already owns that row', () => {
    render(<Sidebar {...sidebarProps} />);
    const nav = screen.getByRole('navigation');
    expect(within(nav).getByRole('link', { name: 'Members' })).toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: 'Teams' })).not.toBeInTheDocument();
  });
});
