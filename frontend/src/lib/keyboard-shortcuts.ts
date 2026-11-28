// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The keyboard shortcuts the app binds, and the open state of the overlay that
 * lists them (src/components/ui/KeyboardShortcuts.tsx).
 *
 * The handlers live where they act — ⌘K in CommandPalette, `/` in FilterBar,
 * the help page and the public directory search, the registry console's keys in
 * pages/dashboard/registry.tsx — and these lists are what the overlay shows.
 * A page's own keys are keyed by its route PATTERN.
 */

import { useSyncExternalStore } from 'react';

export interface Shortcut {
  /** Alternatives, each one key combination ("⌘K", "Ctrl+K"). */
  keys: string[];
  description: string;
}

export interface ShortcutGroup {
  title: string;
  shortcuts: Shortcut[];
}

/** Bound on every dashboard page. */
export const GLOBAL_SHORTCUTS: ShortcutGroup = {
  title: 'Everywhere',
  shortcuts: [
    { keys: ['⌘K', 'Ctrl+K'], description: 'Open search and commands' },
    { keys: ['/'], description: "Focus the page's search or filter" },
    { keys: ['?'], description: 'Show keyboard shortcuts' },
    { keys: ['Esc'], description: 'Close a dialog, menu or drawer' },
  ],
};

/** The registry console's own keys (pages/dashboard/registry.tsx binds them). */
export const REGISTRY_SHORTCUTS: ShortcutGroup = {
  title: 'Registry',
  shortcuts: [
    { keys: ['j'], description: 'Move repository selection down' },
    { keys: ['k'], description: 'Move repository selection up' },
    { keys: ['c'], description: 'Copy the active tag' },
    { keys: ['d'], description: 'Delete the active tag' },
  ],
};

/** Page-specific groups, by route pattern. */
export const PAGE_SHORTCUTS: Readonly<Record<string, ShortcutGroup>> = {
  '/dashboard/registry': REGISTRY_SHORTCUTS,
};

/** True when a key event is aimed at something the user types into. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable;
}

let open = false;
const listeners = new Set<() => void>();
const set = (next: boolean) => {
  if (open === next) return;
  open = next;
  listeners.forEach((l) => l());
};

export const openShortcutsOverlay = (): void => set(true);
export const closeShortcutsOverlay = (): void => set(false);

/** Whether the overlay is open — page handlers stand down while it is. */
export function useShortcutsOverlayOpen(): boolean {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    () => open,
    () => false,
  );
}
