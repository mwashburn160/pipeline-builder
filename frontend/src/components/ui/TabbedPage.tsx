// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The shell of a page made of gated tabs (Inbox, Members, Usage & billing —
 * see `src/lib/tabbed-pages.ts`).
 *
 * Each tab body renders its own layout with its subtitle, header actions and
 * width, through {@link TabbedLayout}, which puts the page's title and tab bar
 * into it. So switching tabs swaps the header actions with the content, and
 * each tab owns its own header.
 */
import { createContext, useContext, type ComponentProps, type ReactNode } from 'react';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { TabBar, tabPanelProps } from '@/components/ui/TabBar';
import { useUrlTab } from '@/hooks/useUrlTab';
import { visibleTabs, type PageTab, type TabViewer } from '@/lib/tabbed-pages';

interface TabbedPageContextValue {
  title: string;
  idPrefix: string;
  activeId: string;
  tabBar: ReactNode;
}

const TabbedPageContext = createContext<TabbedPageContextValue | null>(null);

/**
 * `DashboardLayout` for a tab body. Inside a {@link TabbedPage} it shows the
 * tabbed page's title and tab bar above the body; anywhere else it is a plain
 * `DashboardLayout`.
 */
export function TabbedLayout(props: ComponentProps<typeof DashboardLayout>) {
  const ctx = useContext(TabbedPageContext);
  if (!ctx) return <DashboardLayout {...props} />;
  // A full-bleed body (`!p-0`, the fleet quota view) gets the page gutter back for the bar.
  const flush = props.mainClassName?.includes('!p-0');
  return (
    <DashboardLayout {...props} title={ctx.title}>
      <div className={flush ? 'px-4 sm:px-6 lg:px-8 pt-2 pb-4' : 'mb-6'}>{ctx.tabBar}</div>
      <div {...tabPanelProps(ctx.idPrefix, ctx.activeId)} className="focus:outline-none">
        {props.children}
      </div>
    </DashboardLayout>
  );
}

interface TabbedPageProps {
  /** The tabbed page's title, shown on every tab. */
  title: string;
  /** Tab/panel id prefix and the tab list's accessible name. */
  idPrefix: string;
  ariaLabel: string;
  tabs: readonly PageTab[];
  activeId: string;
  onSelect: (id: string) => void;
  /** The active tab's body (which renders a {@link TabbedLayout}). */
  children: ReactNode;
}

export function TabbedPage({ title, idPrefix, ariaLabel, tabs, activeId, onSelect, children }: TabbedPageProps) {
  const tabBar = (
    <TabBar
      items={tabs.map((t) => ({ id: t.id, label: t.label }))}
      activeId={activeId}
      onSelect={onSelect}
      idPrefix={idPrefix}
      ariaLabel={ariaLabel}
    />
  );
  return (
    <TabbedPageContext.Provider value={{ title, idPrefix, activeId, tabBar }}>
      {children}
    </TabbedPageContext.Provider>
  );
}

/**
 * The visible tabs of a tabbed page and the active one, kept in `?tab=`.
 *
 * Only tabs the viewer may see are valid, and the first of them is the
 * default, so a link to a tab they can't see opens the first one they can.
 * `clearOnSelect` names the query keys that belong to one tab (a message id,
 * billing's `section`), dropped on a switch so the next tab opens clean.
 */
export function usePageTabs(
  pathname: string,
  viewer: TabViewer,
  clearOnSelect?: readonly string[],
): { tabs: PageTab[]; activeId: string; select: (id: string) => void } {
  const tabs = visibleTabs(pathname, viewer);
  const ids = tabs.map((t) => t.id);
  const [active, select] = useUrlTab<string>('tab', ids, ids[0] ?? '', clearOnSelect ? { clearOnSelect } : undefined);
  const activeId = ids.includes(active) ? active : ids[0] ?? '';
  return { tabs, activeId, select };
}
