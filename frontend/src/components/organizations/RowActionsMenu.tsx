// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from 'react';
import { FileDown, KeyRound, Layers, MoreHorizontal, ShieldCheck, Trash2 } from 'lucide-react';
import { IconButton } from '@/components/ui/IconButton';

/**
 * Per-row overflow menu for the less-common admin actions (KMS, IdP, tier,
 * namespace) with Delete separated below as the destructive action. Rendered
 * with fixed positioning off the trigger's rect so the menu isn't clipped by
 * the table's `overflow-x-auto` scroll container.
 */
export function RowActionsMenu({
  canKms, canIdp, onKms, onIdp, onTier, onNamespace, onDelete,
}: {
  canKms: boolean;
  canIdp: boolean;
  onKms: () => void;
  onIdp: () => void;
  /** Omitted for a team — its tier is inherited from its root, never edited. */
  onTier?: () => void;
  onNamespace: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; right: number }>({ top: 0, right: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node) || btnRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    // The menu is fixed-positioned off a rect snapshot; any scroll/resize would
    // desync it, so just close on those rather than re-measuring.
    const onMove = () => setOpen(false);
    // Escape closes and returns focus to the trigger (menu keyboard contract).
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setOpen(false); btnRef.current?.focus(); }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [open]);

  // Move focus to the first item when the menu opens (keyboard entry point).
  useEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }, [open]);

  // Roving focus across items per the menu contract.
  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    if (items.length === 0) return;
    const idx = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(idx + 1) % items.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(idx - 1 + items.length) % items.length].focus(); }
    else if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
    else if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
  };

  const toggle = () => {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setCoords({ top: r.bottom + 4, right: window.innerWidth - r.right });
    }
    setOpen((o) => !o);
  };

  const run = (fn: () => void) => () => { setOpen(false); fn(); };

  const itemClass = 'w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700/60 transition-colors';

  return (
    <>
      <IconButton
        ref={btnRef}
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More actions"
      >
        <MoreHorizontal className="w-4 h-4" />
      </IconButton>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          onKeyDown={onMenuKeyDown}
          style={{ position: 'fixed', top: coords.top, right: coords.right, zIndex: 50 }}
          className="w-56 py-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl shadow-xl text-left"
        >
          {canKms && (
            <button type="button" role="menuitem" onClick={run(onKms)} className={itemClass}>
              <KeyRound className="w-3.5 h-3.5 text-gray-400" /> KMS config
            </button>
          )}
          {canIdp && (
            <button type="button" role="menuitem" onClick={run(onIdp)} className={itemClass}>
              <ShieldCheck className="w-3.5 h-3.5 text-gray-400" /> SSO / IdP config
            </button>
          )}
          {onTier && (
            <button type="button" role="menuitem" onClick={run(onTier)} className={itemClass}>
              <Layers className="w-3.5 h-3.5 text-gray-400" /> Change tier
            </button>
          )}
          <button type="button" role="menuitem" onClick={run(onNamespace)} className={itemClass}>
            <FileDown className="w-3.5 h-3.5 text-gray-400" /> Namespace YAML
          </button>
          <div className="my-1 border-t border-gray-100 dark:border-gray-700" />
          <button
            type="button"
            role="menuitem"
            onClick={run(onDelete)}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" /> Delete organization
          </button>
          <p className="px-3 pt-1 pb-1.5 text-[11px] leading-snug text-gray-400 dark:text-gray-500">
            Removes all members from the org (users aren&apos;t deleted). Cannot be undone.
          </p>
        </div>
      )}
    </>
  );
}
