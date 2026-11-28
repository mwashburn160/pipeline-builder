// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The plugins page's "My plugins" tab: the Active / Recently-deleted views,
 * the search + filter bar, the quick filters and the paged plugin table.
 * The list itself is the page's (`useMyPluginsList`), so it survives a tab switch.
 */

import dynamic from 'next/dynamic';
import { Search, Puzzle, Star } from 'lucide-react';
import { VISIBILITY_RUNGS_WIDEST_FIRST } from '@/components/ui/visibility-rungs';
import { PLUGIN_CATEGORIES, CATEGORY_DISPLAY_NAMES } from '@/lib/plugin-categories';
import { TabBar } from '@/components/ui/TabBar';
import { Button } from '@/components/ui/Button';
import { FilterInput } from '@/components/ui/FilterInput';
import { FilterSelect } from '@/components/ui/FilterSelect';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { ResourceList } from '@/components/ui/ResourceList';
import { FilterBar } from '@/components/ui/FilterBar';
import { BulkActionBarSpacer } from '@/components/dashboard/BulkActionBar';
import { DeletedPluginBatches } from '@/components/plugin/DeletedPluginBatches';
import type { PluginSummary } from '@/lib/api/domains/plugins';
import type { MyPluginsList } from './useMyPluginsList';

// The recently-deleted panel loads on first use — it is not part of the list's first paint.
const RecentlyDeletedPanel = dynamic(() => import('@/components/RecentlyDeletedPanel').then((m) => m.RecentlyDeletedPanel), { ssr: false });

interface MyPluginsTabProps {
  mine: MyPluginsList;
  columns: Column<PluginSummary>[];
  canWrite: boolean;
  canViewPublic: boolean;
  canBulk: boolean;
  selectedCount: number;
  canWriteRow: (p: { visibility?: string; createdBy?: string; orgId?: string }) => boolean;
  deletedView: 'active' | 'deleted';
  onDeletedViewChange: (view: 'active' | 'deleted') => void;
  showAdvanced: boolean;
  onShowAdvancedChange: (show: boolean) => void;
  /** Open the create modal (the empty state's action). */
  onCreate: () => void;
}

export function MyPluginsTab({
  mine, columns, canWrite, canViewPublic, canBulk, selectedCount, canWriteRow,
  deletedView, onDeletedViewChange, showAdvanced, onShowAdvancedChange, onCreate,
}: MyPluginsTabProps) {
  const emptyDescription = canWrite
    ? 'Get started by creating your first plugin.'
    : 'No private plugins available for your organization.';
  const emptyAction = canWrite
    ? <Button onClick={onCreate}>Create plugin</Button>
    : undefined;

  return (
    <>
      {/* Active / Recently-deleted tabs (restore is write-gated). */}
      {canWrite && (
        <TabBar
          className="mb-4"
          items={[{ id: 'active', label: 'Active' }, { id: 'deleted', label: 'Recently deleted' }]}
          activeId={deletedView}
          onSelect={(id) => onDeletedViewChange(id as 'active' | 'deleted')}
        />
      )}

      {canWrite && deletedView === 'deleted' ? (
        <>
          <DeletedPluginBatches onChanged={mine.afterWrite} />
          <RecentlyDeletedPanel resource="plugin" onRestored={mine.afterWrite} canRestoreRow={(r) => canWriteRow({ visibility: r.visibility, createdBy: r.createdBy })} />
        </>
      ) : (
      <>
      {/* Sticky search + advanced-filter panel stays above the list shell.
          FilterBar is its own sticky surface with a "/" hotkey and a
          collapsible advanced panel — pulling it into ResourceList's
          inline header would defeat both. */}
      <FilterBar
        sticky
        searchValue={mine.list.filters.name}
        onSearchChange={(v) => mine.list.updateFilter('name', v)}
        searchPlaceholder="Search plugins... (press /)"
        showAdvanced={showAdvanced}
        onToggleAdvanced={() => onShowAdvancedChange(!showAdvanced)}
        advancedFilterCount={mine.list.advancedFilterCount}
        onClearAll={mine.clearAllFilters}
        summary={mine.listSummary}
        advancedContent={
          <>
            <FilterInput type="text" aria-label="Filter by keyword" value={mine.list.filters.keyword} onChange={(e) => mine.list.updateFilter('keyword', e.target.value)} placeholder="Keyword..." className="max-w-[160px]" />
            <FilterSelect aria-label="Filter by compute" value={mine.list.filters.computeType} onChange={(e) => mine.list.updateFilter('computeType', e.target.value)}>
              <option value="all">All compute</option>
              <option value="SMALL">SMALL</option>
              <option value="MEDIUM">MEDIUM</option>
              <option value="LARGE">LARGE</option>
              <option value="X2_LARGE">X2_LARGE</option>
            </FilterSelect>
            <FilterSelect aria-label="Filter by status" value={mine.list.filters.status} onChange={(e) => mine.list.updateFilter('status', e.target.value)}>
              <option value="all">All status</option>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </FilterSelect>
            <FilterSelect aria-label="Filter by default" value={mine.list.filters.default} onChange={(e) => mine.list.updateFilter('default', e.target.value)}>
              <option value="all">All plugins</option>
              <option value="default">Default only</option>
            </FilterSelect>
            {canViewPublic && (
              <FilterSelect aria-label="Filter by visibility" value={mine.list.filters.visibility} onChange={(e) => mine.list.updateFilter('visibility', e.target.value)}>
                <option value="all">All visibility</option>
                {VISIBILITY_RUNGS_WIDEST_FIRST.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
              </FilterSelect>
            )}
          </>
        }
      />

      {/* Quick filters — the most-used narrowing, always visible: category,
          step type, and favorites (localStorage-backed, same source as the
          star toggles). Everything else lives under Filters. */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <FilterSelect aria-label="Filter by category" value={mine.list.filters.category} onChange={(e) => mine.list.updateFilter('category', e.target.value)}>
          <option value="all">All categories</option>
          {PLUGIN_CATEGORIES.map((cat) => (
            <option key={cat} value={cat}>{CATEGORY_DISPLAY_NAMES[cat]}</option>
          ))}
        </FilterSelect>
        <FilterSelect aria-label="Filter by type" value={mine.list.filters.pluginType} onChange={(e) => mine.list.updateFilter('pluginType', e.target.value)}>
          <option value="all">All step types</option>
          <option value="CodeBuildStep">CodeBuildStep</option>
          <option value="ShellStep">ShellStep</option>
          <option value="ManualApprovalStep">ManualApprovalStep</option>
        </FilterSelect>
        <button
          type="button"
          onClick={() => mine.setShowFavoritesOnly((v) => !v)}
          aria-pressed={mine.showFavoritesOnly}
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-full border transition-colors ${
            mine.showFavoritesOnly
              ? 'border-warning-border bg-warning-bg text-warning'
              : 'border-default text-fg hover:bg-surface-muted'
          }`}
        >
          <Star className={`w-3.5 h-3.5 ${mine.showFavoritesOnly ? 'fill-current' : ''}`} aria-hidden="true" />
          Favorites only
        </button>
        {mine.hasActiveFilters && (
          <button type="button" onClick={mine.clearAllFilters} className="action-link-muted text-xs">
            Clear filters
          </button>
        )}
      </div>

      {/* Spacer when sticky bulk bar is visible */}
      {canBulk && <BulkActionBarSpacer count={selectedCount} />}

      {/* ResourceList owns: error+retry, refresh button, empty state, and
          offset Pagination. Body is custom so we preserve DataTable's
          defaultSortColumn + showColumnToggle features (which ResourceList's
          table-mode slot doesn't forward). We swap emptyState manually when
          filters are active because ResourceList's built-in
          `filteredEmptyState` keys off the filter input it renders itself,
          and our filter input lives in FilterBar above. */}
      <ResourceList<PluginSummary>
        loading={mine.list.isLoading}
        error={mine.list.error}
        onRefresh={mine.list.refresh}
        isEmpty={mine.filteredPlugins.length === 0}
        pagination={mine.list.pagination}
        onPageChange={mine.list.handlePageChange}
        onPageSizeChange={mine.list.handlePageSizeChange}
        errorTitle="Failed to load plugins"
        emptyState={mine.hasActiveFilters ? {
          icon: Search,
          title: 'No plugins match your filters',
          description: 'Try adjusting your search or filter criteria.',
          action: <Button variant="secondary" onClick={mine.clearAllFilters}>Clear filters</Button>,
        } : {
          icon: Puzzle,
          title: 'No plugins yet',
          description: emptyDescription,
          action: emptyAction,
        }}
      >
        <DataTable
          data={mine.filteredPlugins}
          columns={columns}
          isLoading={mine.list.isLoading}
          emptyState={{
            icon: Puzzle,
            title: 'No plugins yet',
            description: emptyDescription,
            action: emptyAction,
          }}
          getRowKey={(p) => p.id}
          defaultSortColumn="name"
          showColumnToggle
          serverSort
          onSortChange={mine.handleServerSort}
        />
      </ResourceList>

      </>
      )}
    </>
  );
}
