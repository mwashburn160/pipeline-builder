// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The keyboard-shortcuts overlay: `?` outside a text field (or Help menu →
 * Keyboard shortcuts) opens a dialog listing the app-wide shortcuts and the
 * current page's own. Mounted once by the dashboard shell. The dialog is the
 * shared Modal, so it traps focus, closes on Escape and restores focus.
 */
import { useEffect } from 'react';
import { useRouter } from 'next/router';
import { Modal } from './Modal';
import {
  GLOBAL_SHORTCUTS,
  PAGE_SHORTCUTS,
  closeShortcutsOverlay,
  isTypingTarget,
  openShortcutsOverlay,
  useShortcutsOverlayOpen,
  type ShortcutGroup,
} from '@/lib/keyboard-shortcuts';

function Group({ group }: { group: ShortcutGroup }) {
  const headingId = `shortcuts-${group.title.toLowerCase().replace(/\W+/g, '-')}`;
  return (
    <section aria-labelledby={headingId} className="mb-4 last:mb-0">
      <h3 id={headingId} className="text-xs font-semibold uppercase tracking-wide text-fg-subtle mb-1">{group.title}</h3>
      <ul className="divide-y divide-default">
        {group.shortcuts.map((s) => (
          <li key={s.description} className="flex items-center justify-between gap-4 py-2">
            <span className="text-sm text-fg-muted">{s.description}</span>
            <span className="flex items-center gap-1 shrink-0">
              {s.keys.map((k, i) => (
                <span key={k} className="flex items-center gap-1">
                  {i > 0 && <span className="text-xs text-fg-subtle">or</span>}
                  <kbd className="px-2 py-0.5 text-xs font-mono border border-default rounded bg-surface-muted text-fg">{k}</kbd>
                </span>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function KeyboardShortcuts() {
  const open = useShortcutsOverlayOpen();
  const { pathname } = useRouter();
  const page = PAGE_SHORTCUTS[pathname];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '?' || e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      e.preventDefault();
      openShortcutsOverlay();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  if (!open) return null;
  return (
    <Modal title="Keyboard shortcuts" onClose={closeShortcutsOverlay} maxWidth="max-w-md">
      <Group group={GLOBAL_SHORTCUTS} />
      {page && <Group group={page} />}
      <p className="mt-4 text-xs text-fg-muted">
        Single-key shortcuts are off while you type in a field.
      </p>
    </Modal>
  );
}
