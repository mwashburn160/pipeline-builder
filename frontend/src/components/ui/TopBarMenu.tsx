// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A top-bar dropdown: a trigger button and a `role="menu"` panel under it.
 *
 * Shared by the avatar menu and the Help ("?") menu so both owe the user the
 * same keyboard behaviour as the org switcher: focus moves into the menu on
 * open, the arrow keys / Home / End move through it, Escape closes it and
 * returns focus to the trigger, Tab or an outside click dismisses it.
 */
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';

interface TopBarMenuProps {
  /** The trigger's accessible name. */
  label: string;
  /** What the trigger shows (an icon or the avatar). */
  trigger: ReactNode;
  triggerClassName?: string;
  /** Renders the panel's content; `close` dismisses the menu. */
  children: (close: () => void) => ReactNode;
  /** Panel width class. */
  widthClassName?: string;
}

export function TopBarMenu({ label, trigger, triggerClassName = '', children, widthClassName = 'w-56' }: TopBarMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const menuItems = () => Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
  const close = () => setOpen(false);

  // Focus the first item on open, so the arrow keys have a starting point.
  useEffect(() => {
    if (open) menuItems()[0]?.focus();
  }, [open]);

  // Close on an outside click.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!open) return;
    const items = menuItems();
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') {
      e.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (items.length === 0) return;
      const next = e.key === 'ArrowDown'
        ? (index < 0 ? 0 : (index + 1) % items.length)
        : (index <= 0 ? items.length - 1 : index - 1);
      items[next]?.focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      (e.key === 'Home' ? items[0] : items[items.length - 1])?.focus();
    } else if (e.key === 'Tab') {
      // Tabbing out of a menu is a dismissal, not navigation within it.
      setOpen(false);
    }
  };

  return (
    // Delegates arrow/Home/End/Escape navigation for the menu it wraps; the wrapper itself is not a control.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div ref={ref} onKeyDown={onKeyDown} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        className={triggerClassName}
      >
        {trigger}
      </button>
      {open && (
        <div
          role="menu"
          aria-label={label}
          className={`absolute right-0 top-full mt-1.5 z-50 max-w-[calc(100vw-2rem)] bg-surface border border-default rounded-xl shadow-xl overflow-hidden py-1 ${widthClassName}`}
        >
          {children(close)}
        </div>
      )}
    </div>
  );
}

const ITEM_CLASS = 'w-full flex items-center gap-2 px-3 py-2 text-sm text-fg-muted hover:bg-surface-muted hover:text-fg focus:bg-surface-muted focus:text-fg focus:outline-none transition-colors';

/** A link row in a {@link TopBarMenu}. */
export function TopBarMenuLink({ href, icon: Icon, children, onSelect }: { href: string; icon: LucideIcon; children: ReactNode; onSelect: () => void }) {
  return (
    <Link href={href} role="menuitem" onClick={onSelect} className={ITEM_CLASS}>
      <Icon className="w-4 h-4 shrink-0 text-fg-subtle" aria-hidden="true" />
      <span className="flex-1 min-w-0 truncate">{children}</span>
    </Link>
  );
}

/** A button row in a {@link TopBarMenu}. */
export function TopBarMenuButton({ icon: Icon, children, onSelect, danger = false }: { icon: LucideIcon; children: ReactNode; onSelect: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      className={`${ITEM_CLASS} ${danger ? 'hover:!text-danger hover:!bg-danger-bg' : ''}`}
    >
      <Icon className="w-4 h-4 shrink-0 text-fg-subtle" aria-hidden="true" />
      <span className="flex-1 min-w-0 truncate text-left">{children}</span>
    </button>
  );
}

/** A divider between groups of rows. */
export function TopBarMenuDivider() {
  return <div role="separator" className="my-1 border-t border-default" />;
}
