import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useRouter } from 'next/router';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Search, LayoutDashboard, GitBranch, Puzzle, MessageSquare, ScrollText,
  FileBarChart, Users, Settings, KeyRound, HelpCircle, BarChart3, CreditCard,
  Plus, Sun, Moon,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

interface CommandItem {
  id: string;
  label: string;
  icon: LucideIcon;
  section: string;
  keywords?: string;
  action: () => void;
}

interface CommandPaletteProps {
  isSysAdmin: boolean;
  isAdmin: boolean;
  isDark: boolean;
  onToggleDark: () => void;
  onCreatePipeline?: () => void;
  onCreatePlugin?: () => void;
  onOpenRef?: React.RefObject<(() => void) | null>;
}

export function CommandPalette({
  isSysAdmin,
  isAdmin,
  isDark,
  onToggleDark,
  onCreatePipeline,
  onCreatePlugin,
  onOpenRef,
}: CommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  const navigate = useCallback((path: string) => {
    setOpen(false);
    router.push(path);
  }, [router]);

  const commands: CommandItem[] = useMemo(() => {
    const items: CommandItem[] = [
      { id: 'dashboard', label: 'Go to Dashboard', icon: LayoutDashboard, section: 'Navigation', action: () => navigate('/dashboard') },
      { id: 'pipelines', label: 'Go to Pipelines', icon: GitBranch, section: 'Navigation', action: () => navigate('/dashboard/pipelines') },
      { id: 'plugins', label: 'Go to Plugins', icon: Puzzle, section: 'Navigation', action: () => navigate('/dashboard/plugins') },
      { id: 'messages', label: 'Go to Messages', icon: MessageSquare, section: 'Navigation', action: () => navigate('/dashboard/messages') },
      { id: 'reports', label: 'Go to Reports', icon: FileBarChart, section: 'Navigation', action: () => navigate('/dashboard/reports') },
      { id: 'logs', label: 'Go to Logs', icon: ScrollText, section: 'Navigation', action: () => navigate('/dashboard/logs') },
      { id: 'quotas', label: 'Go to Quotas', icon: BarChart3, section: 'Navigation', action: () => navigate('/dashboard/quotas') },
      { id: 'billing', label: 'Go to Billing', icon: CreditCard, section: 'Navigation', action: () => navigate('/dashboard/billing') },
      { id: 'settings', label: 'Go to Settings', icon: Settings, section: 'Navigation', action: () => navigate('/dashboard/settings') },
      { id: 'tokens', label: 'Go to API Tokens', icon: KeyRound, section: 'Navigation', action: () => navigate('/dashboard/tokens') },
      { id: 'help', label: 'Go to Help', icon: HelpCircle, section: 'Navigation', action: () => navigate('/dashboard/help') },
    ];

    if (isAdmin || isSysAdmin) {
      items.push(
        { id: 'team', label: 'Go to Team', icon: Users, section: 'Navigation', action: () => navigate('/dashboard/team') },
      );
    }

    if (isSysAdmin) {
      items.push(
        { id: 'users', label: 'Go to All Users', icon: Users, section: 'Navigation', action: () => navigate('/dashboard/users') },
      );
    }

    if (onCreatePipeline) {
      items.push({ id: 'create-pipeline', label: 'Create Pipeline', icon: Plus, section: 'Actions', keywords: 'new add', action: () => { setOpen(false); onCreatePipeline(); } });
    }
    if (onCreatePlugin) {
      items.push({ id: 'create-plugin', label: 'Create Plugin', icon: Plus, section: 'Actions', keywords: 'new add upload', action: () => { setOpen(false); onCreatePlugin(); } });
    }

    items.push(
      { id: 'toggle-dark', label: isDark ? 'Switch to Light Mode' : 'Switch to Dark Mode', icon: isDark ? Sun : Moon, section: 'Settings', keywords: 'theme', action: () => { onToggleDark(); setOpen(false); } },
    );

    return items;
  }, [navigate, isSysAdmin, isAdmin, isDark, onToggleDark, onCreatePipeline, onCreatePlugin]);

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

  // Focus input on open
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  // Keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setOpen(false);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => Math.min(prev + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter' && filtered[selectedIndex]) {
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
