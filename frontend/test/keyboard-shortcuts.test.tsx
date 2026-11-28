// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The keyboard-shortcuts overlay (src/components/ui/KeyboardShortcuts.tsx),
 * mounted by the dashboard shell.
 *
 *  - `?` anywhere outside a text field opens an accessible dialog listing the
 *    shortcuts the app binds: ⌘K / Ctrl+K (command palette), `/` (focus the
 *    page's search), `?` itself and Esc — plus the current page's own (the
 *    registry console's j / k / c / d) when the route has some;
 *  - `?` typed INTO a field types a question mark, nothing else;
 *  - the Help ("?") menu has a "Keyboard shortcuts" entry that opens it.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { render, screen, fireEvent, within, act } from '@testing-library/react';

let pathname = '/dashboard';
jest.mock('next/router', () => require('./helpers/pageMocks').routerModule(() => ({ pathname, asPath: pathname, query: {} })));

import { KeyboardShortcuts } from '../src/components/ui/KeyboardShortcuts';
import { HelpMenu } from '../src/components/ui/HelpMenu';
import { closeShortcutsOverlay } from '../src/lib/keyboard-shortcuts';

beforeEach(() => {
  pathname = '/dashboard';
  act(() => closeShortcutsOverlay());
});

const pressQuestion = (target: Element | Document = document.body) =>
  fireEvent.keyDown(target, { key: '?', shiftKey: true });

describe('keyboard shortcuts overlay', () => {
  it('opens on `?` outside a field and lists the app-wide shortcuts', () => {
    render(<KeyboardShortcuts />);
    expect(screen.queryByRole('dialog')).toBeNull();
    pressQuestion();
    const dialog = screen.getByRole('dialog', { name: 'Keyboard shortcuts' });
    const text = dialog.textContent ?? '';
    expect(text).toMatch(/⌘K/);
    expect(text).toMatch(/Ctrl\+K/);
    expect(text).toMatch(/Open search and commands/);
    expect(text).toMatch(/Focus the page's search/);
    expect(text).toMatch(/Show keyboard shortcuts/);
    expect(text).toMatch(/Esc/);
    // No page group on a page that binds nothing of its own.
    expect(within(dialog).queryByText(/Registry/)).toBeNull();
  });

  it('does nothing when `?` is typed into a field', () => {
    render(<><KeyboardShortcuts /><input aria-label="query" /><textarea aria-label="note" /></>);
    pressQuestion(screen.getByLabelText('query'));
    pressQuestion(screen.getByLabelText('note'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('adds the current page\'s own shortcuts (registry console)', () => {
    pathname = '/dashboard/registry';
    render(<KeyboardShortcuts />);
    pressQuestion();
    const dialog = screen.getByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(within(dialog).getByText('Registry')).toBeInTheDocument();
    expect(dialog.textContent).toMatch(/Move repository selection down/);
    expect(dialog.textContent).toMatch(/Delete the active tag/);
  });

  it('closes on Escape', () => {
    render(<KeyboardShortcuts />);
    pressQuestion();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('is reachable from the Help menu', () => {
    render(<><HelpMenu /><KeyboardShortcuts /></>);
    fireEvent.click(screen.getByRole('button', { name: 'Help and resources' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Keyboard shortcuts' }));
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
  });
});
