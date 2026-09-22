// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared UI infrastructure contracts:
 *  - the collapsed sidebar says in TEXT what its red unread dot says in colour,
 *    and names its icon-only links;
 *  - palette-only nav entries reach ⌘K but not the sidebar, with the same gates;
 *  - `EmptyState` / `RetryError` cover the variants pages adopt them for;
 *  - `Modal` runs the shared overlay hook (Tab trap, guarded Escape, restore).
 */

import { describe, it, expect, jest } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { useState } from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { Inbox } from 'lucide-react';
import type { User } from '../src/types';

jest.mock('@/hooks/useAuth', () => require('./helpers/pageMocks').authModule(() => ({ isReadOnly: false, user: null })));
jest.mock('@/hooks/useBillingEnabled', () => ({ __esModule: true, useBillingEnabled: () => true }));
jest.mock('@/hooks/useFeatures', () => ({ __esModule: true, useFeatures: () => ({ isEnabled: () => false, isLoaded: true, isSuperAdmin: false }) }));

import { Sidebar } from '../src/components/ui/Sidebar';
import { NAV_SECTIONS, isNavItemVisible } from '../src/lib/nav';
import { resolvePageGate } from '../src/lib/page-access';
import { EmptyState } from '../src/components/ui/EmptyState';
import { RetryError } from '../src/components/ui/RetryError';
import { Modal } from '../src/components/ui/Modal';

const baseSidebar = {
  isSuperAdmin: false,
  isAdmin: false,
  user: { id: 'u1', username: 'dana', permissions: ['messages:read'] } as unknown as User,
  currentPath: '/dashboard',
  isDark: false,
  onToggleDark: jest.fn<AnyFn>(),
  onLogout: jest.fn<AnyFn>(),
};

describe('Sidebar — colour is never the only signal', () => {
  it('gives the collapsed unread dot a text equivalent', () => {
    render(<Sidebar {...baseSidebar} unreadCount={7} collapsed />);
    const messages = screen.getByRole('link', { name: /messages/i });
    expect(messages).toHaveAccessibleName('Messages 7 unread');
  });

  it('caps the spoken count like the visible badge', () => {
    render(<Sidebar {...baseSidebar} unreadCount={250} collapsed />);
    expect(screen.getByRole('link', { name: /messages/i })).toHaveAccessibleName('Messages 99+ unread');
  });

  it('names every icon-only link in the collapsed rail', () => {
    render(<Sidebar {...baseSidebar} unreadCount={0} collapsed />);
    expect(screen.getByRole('link', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Messages' })).toBeInTheDocument();
  });

  it('says "unread" in the expanded badge too', () => {
    render(<Sidebar {...baseSidebar} unreadCount={3} />);
    expect(screen.getByRole('link', { name: /messages/i })).toHaveAccessibleName('Messages 3 unread');
  });
});

describe('palette-only nav entries', () => {
  const items = NAV_SECTIONS.flatMap((s) => s.items);
  const PALETTE_ONLY: Record<string, { permission?: string; adminOnly?: boolean; systemAdminOnly?: boolean }> = {
    '/dashboard/observability/alerts': { permission: 'observability:read' },
    '/dashboard/observability/alert-rules': { permission: 'observability:read' },
    '/dashboard/observability/alert-destinations': { permission: 'observability:read' },
    '/dashboard/observability/audit-activity': { adminOnly: true },
    '/dashboard/triage': { systemAdminOnly: true },
    '/dashboard/discounts': { systemAdminOnly: true },
    '/dashboard/promotions': { systemAdminOnly: true },
  };

  it.each(Object.entries(PALETTE_ONLY))('%s is a palette-only entry whose gate is the page gate', (href, gate) => {
    const item = items.find((i) => i.href === href);
    expect(item?.paletteOnly).toBe(true);
    expect(resolvePageGate(href)).toEqual(gate);
  });

  it('keeps them out of the sidebar even for a viewer who may open them', () => {
    render(<Sidebar {...baseSidebar} isSuperAdmin isAdmin user={{ ...baseSidebar.user, isSuperAdmin: true } as User} unreadCount={0} />);
    const nav = screen.getByRole('navigation');
    for (const href of Object.keys(PALETTE_ONLY)) {
      expect(within(nav).queryAllByRole('link').map((a) => a.getAttribute('href'))).not.toContain(href);
    }
    // Their parents are still there.
    expect(within(nav).getByRole('link', { name: 'Observability' })).toBeInTheDocument();
  });

  it('applies the same visibility gate as any other entry', () => {
    const alerts = items.find((i) => i.href === '/dashboard/observability/alerts')!;
    const ctx = (perms: string[]) => ({ isAdmin: false, isSuperAdmin: false, hasPermission: (p: string) => perms.includes(p), billingEnabled: true });
    expect(isNavItemVisible(alerts, ctx([]))).toBe(false);
    expect(isNavItemVisible(alerts, ctx(['observability:read']))).toBe(true);
    const discounts = items.find((i) => i.href === '/dashboard/discounts')!;
    expect(isNavItemVisible(discounts, { ...ctx([]), isSuperAdmin: true, billingEnabled: false })).toBe(false);
  });
});

describe('EmptyState', () => {
  it('keeps the existing icon/title/description/action form', () => {
    render(<EmptyState icon={Inbox} title="Nothing here" description="Add one" action={<button>Custom</button>} />);
    expect(screen.getByRole('heading', { name: 'Nothing here' })).toBeInTheDocument();
    expect(screen.getByText('Add one')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Custom' })).toBeInTheDocument();
  });

  it('renders a button CTA from actionLabel + onAction', () => {
    const onAction = jest.fn<AnyFn>();
    render(<EmptyState title="No keys" actionLabel="Create key" onAction={onAction} />);
    fireEvent.click(screen.getByRole('button', { name: 'Create key' }));
    expect(onAction).toHaveBeenCalled();
  });

  it('prefers an explicit action over the shorthand', () => {
    render(<EmptyState title="x" action={<a href="/y">Go</a>} actionLabel="Ignored" onAction={jest.fn<AnyFn>()} />);
    expect(screen.queryByRole('button', { name: 'Ignored' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Go' })).toBeInTheDocument();
  });

  it('has a compact variant for panels inside cards, with icon and description optional', () => {
    const { container } = render(<EmptyState compact title="No data in range" className="extra" />);
    expect(screen.getByRole('heading', { name: 'No data in range' })).toBeInTheDocument();
    // The contract is: caller classes are FORWARDED, and the compact variant
    // drops the illustration + description. The internal spacing token it
    // happens to use is not a contract, so it isn't asserted.
    expect(container.firstElementChild).toHaveClass('extra');
    expect(container.querySelector('svg')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('RetryError', () => {
  it('is announced, and retries on click', () => {
    const onRetry = jest.fn<AnyFn>();
    render(<RetryError message="Couldn't load." onRetry={onRetry} />);
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load.");
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('takes a title, a custom label and rich content', () => {
    render(<RetryError title="Members" message={<strong>Timed out</strong>} retryLabel="Try again" onRetry={jest.fn<AnyFn>()} />);
    expect(screen.getByText('Members')).toBeInTheDocument();
    expect(screen.getByText('Timed out').tagName).toBe('STRONG');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('disables the button while a retry is in flight', () => {
    const onRetry = jest.fn<AnyFn>();
    render(<RetryError onRetry={onRetry} retrying />);
    const btn = screen.getByRole('button', { name: 'Retrying…' });
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(onRetry).not.toHaveBeenCalled();
  });
});

describe('Modal on the shared overlay hook', () => {
  function Harness({ dirty = false }: { dirty?: boolean }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>open</button>
        {open && (
          <Modal title="Edit" onClose={() => setOpen(false)} dirty={dirty}>
            <input aria-label="name" />
          </Modal>
        )}
      </>
    );
  }

  it('focuses in, traps Tab, closes on Escape and restores focus to the trigger', () => {
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'open' });
    trigger.focus();
    fireEvent.click(trigger);
    const close = screen.getByRole('button', { name: 'Close dialog' });
    expect(close).toHaveFocus();
    expect(document.body.style.overflow).toBe('hidden');

    screen.getByLabelText('name').focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(close).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(trigger).toHaveFocus();
    expect(document.body.style.overflow).toBe('');
  });

  it('routes Escape through the dirty guard instead of discarding', () => {
    render(<Harness dirty />);
    fireEvent.click(screen.getByRole('button', { name: 'open' }));
    screen.getByLabelText('name').focus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: 'Discard changes?' })).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Edit' })).toBeInTheDocument();
  });
});
