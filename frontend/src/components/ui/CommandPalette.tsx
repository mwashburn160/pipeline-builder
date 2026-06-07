import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useRouter } from 'next/router';
import { AnimatePresence, motion } from 'framer-motion';
import { Search, Sun, Moon } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useFeatures } from '@/hooks/useFeatures';
import { NAV_SECTIONS, QUICK_ACTIONS, isNavItemVisible } from '@/lib/nav';

interface CommandItem {
  id: string;
  label: string;
  icon: LucideIcon;
  section: string;
  keywords?: string;
  action: () => void;
}

interface CommandPaletteProps {
  isSuperAdmin: boolean;
  isAdmin: boolean;
  isDark: boolean;
  onToggleDark: () => void;
  onOpenRef?: React.RefObject<(() => void) | null>;
}

export function CommandPalette({
  isSuperAdmin,
  isAdmin,
  isDark,
  onToggleDark,
  onOpenRef,
}: CommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  // Every command action funnels through `runAndClose` so the palette
  // always dismisses on activation — previously each non-nav action had
  // to remember to call `setOpen(false)` itself (and the dark-mode toggle
  // was the only one that did). Now navigation and side-effect actions
  // share the same teardown path.
  const runAndClose = useCallback((fn: () => void) => {
    setOpen(false);
    fn();
  }, []);

  const navigate = useCallback((path: string) => {
    runAndClose(() => router.push(path));
  }, [router, runAndClose]);

  const features = useFeatures();

  const commands: CommandItem[] = useMemo(() => {
    // Quick actions first — these are the primary "start something" flows
    // (the `?create=1` query opens the target page's create modal on arrival),
    // sourced from the same QUICK_ACTIONS the sidebar's action row uses. Putting
    // them at the top means a user can fire "Create Pipeline" without leaving
    // the keyboard, and they stay reachable when the sidebar is collapsed.
    const actionItems: CommandItem[] = QUICK_ACTIONS.map((qa) => ({
      id: qa.href,
      label: qa.label,
      icon: qa.icon,
      section: 'Actions',
      keywords: 'create new add',
      action: () => navigate(qa.href),
    }));

    // Navigation commands are derived from the SAME NAV_SECTIONS the sidebar
    // uses (with the same role/feature gating), so ⌘K always reaches exactly
    // the pages the sidebar shows — no separate hand-maintained list to drift.
    // The section label doubles as a search keyword (e.g. "platform" surfaces
    // every admin page) so users can find a page by area, not just name.
    const navItems: CommandItem[] = NAV_SECTIONS.flatMap((section) =>
      section.items
        .filter((item) => isNavItemVisible(item, { isAdmin, isSuperAdmin, isFeatureEnabled: (n) => features.isEnabled(n) }))
        .map((item) => ({
          id: item.href,
          label: `Go to ${item.title}`,
          icon: item.icon,
          section: 'Navigation',
          keywords: section.label.toLowerCase(),
          action: () => navigate(item.href),
        })),
    );

    return [
      ...actionItems,
      ...navItems,
      { id: 'toggle-dark', label: isDark ? 'Switch to Light Mode' : 'Switch to Dark Mode', icon: isDark ? Sun : Moon, section: 'Settings', keywords: 'theme', action: () => runAndClose(onToggleDark) },
    ];
  }, [navigate, isSuperAdmin, isAdmin, isDark, onToggleDark, runAndClose, features]);

  const filtered = useMemo(() => {
    if (!query) return commands;
    const q = query.toLowerCase();
    return commands.filter((c) =>
      c.label.toLowerCase().includes(q) ||
      c.section.toLowerCase().includes(q) ||
      c.keywords?.toLowerCase().includes(q)
    );
  }, [commands, query]);

  // Group by section with flat index for keyboard navigation
  const { sections, flatItems } = useMemo(() => {
    const sectionMap = new Map<string, CommandItem[]>();
    const flat: { item: CommandItem; index: number }[] = [];
    let idx = 0;
    for (const item of filtered) {
      const list = sectionMap.get(item.section) || [];
      list.push(item);
      sectionMap.set(item.section, list);
      flat.push({ item, index: idx++ });
    }
    return { sections: sectionMap, flatItems: flat };
  }, [filtered]);

  // Build a lookup from item id to flat index
  const itemIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const { item, index } of flatItems) {
      map.set(item.id, index);
    }
    return map;
  }, [flatItems]);

  // Expose open callback via ref
  useEffect(() => {
    if (onOpenRef) {
      (onOpenRef as React.MutableRefObject<(() => void) | null>).current = () => {
        setOpen(true);
        setQuery('');
        setSelectedIndex(0);
      };
    }
  }, [onOpenRef]);

  // Open/close with Cmd+K
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setOpen((prev) => !prev);
        setQuery('');
        setSelectedIndex(0);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Scroll-lock background while the palette is open — matches Modal so
  // the page doesn't visibly shift if the operator scrolls during a search.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, [open]);

  // Focus the search input as soon as the palette mounts. The previous
  // `setTimeout(50)` raced with framer-motion's enter animation and
  // intermittently lost focus on slow machines. Querying the ref on the
  // next animation frame is more reliable than a fixed millisecond wait.
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  // Keyboard navigation. The palette has exactly one focusable element
  // (the input), so a full focus trap is unnecessary — but we do swallow
  // Tab so it doesn't escape to background DOM, and we clamp Arrow keys
  // against the filtered-empty case (where length-1 would underflow to -1).
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      return;
    }
    if (e.key === 'Tab') {
      // Single focusable element — Tab is a no-op.
      e.preventDefault();
      return;
    }
    if (filtered.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => Math.min(prev + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter' && filtered[selectedIndex]) {
      e.preventDefault();
      filtered[selectedIndex].action();
    }
  };

  // Scroll selected item into view
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-index="${selectedIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  // Reset index on query change
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  if (!open) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[60] bg-gray-900/60 backdrop-blur-sm flex items-start justify-center pt-[20vh]"
        onClick={() => setOpen(false)}
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: -10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: -10 }}
          transition={{ duration: 0.15 }}
          className="w-full max-w-lg bg-white dark:bg-gray-900 rounded-xl shadow-2xl border border-gray-200/60 dark:border-gray-700/60 overflow-hidden"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={handleKeyDown}
          role="dialog"
          aria-label="Command palette"
          aria-modal="true"
        >
          {/* Search input */}
          <div className="flex items-center gap-3 px-4 border-b border-gray-200 dark:border-gray-700">
            <Search className="w-5 h-5 text-gray-400 dark:text-gray-500 flex-shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Type a command or search..."
              className="flex-1 py-3.5 bg-transparent text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 outline-none"
              role="combobox"
              aria-expanded="true"
              aria-autocomplete="list"
            />
            <kbd className="hidden sm:inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium text-gray-400 dark:text-gray-500 bg-gray-100 dark:bg-gray-800 rounded border border-gray-200 dark:border-gray-700">
              ESC
            </kbd>
          </div>

          {/* Results */}
          <div ref={listRef} className="max-h-80 overflow-y-auto py-2" role="listbox">
            {filtered.length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-8">No results found</p>
            ) : (
              Array.from(sections.entries()).map(([section, items]) => (
                <div key={section} role="group" aria-label={section}>
                  <p className="px-4 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
                    {section}
                  </p>
                  {items.map((item) => {
                    const idx = itemIndexMap.get(item.id) ?? 0;
                    const Icon = item.icon;
                    const isSelected = idx === selectedIndex;
                    return (
                      <button
                        key={item.id}
                        data-index={idx}
                        onClick={item.action}
                        onMouseEnter={() => setSelectedIndex(idx)}
                        role="option"
                        aria-selected={isSelected}
                        className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm transition-colors ${
                          isSelected
                            ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300'
                            : 'text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800/50'
                        }`}
                      >
                        <Icon className="w-4 h-4 flex-shrink-0 opacity-60" />
                        <span className="flex-1 text-left">{item.label}</span>
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>

          {/* Footer hint */}
          <div className="px-4 py-2 border-t border-gray-200 dark:border-gray-700 flex items-center gap-4 text-[11px] text-gray-400 dark:text-gray-500">
            <span className="flex items-center gap-1">
              <kbd className="px-1 py-0.5 rounded bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700">↑↓</kbd>
              navigate
            </span>
            <span className="flex items-center gap-1">
              <kbd className="px-1 py-0.5 rounded bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700">↵</kbd>
              select
            </span>
            <span className="flex items-center gap-1">
              <kbd className="px-1 py-0.5 rounded bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700">esc</kbd>
              close
            </span>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
