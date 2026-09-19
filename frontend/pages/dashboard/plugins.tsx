import { useState, useMemo, useCallback, useEffect } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/router';
import { useToast } from '@/components/ui/Toast';
import { useOpenOnCreateQuery } from '@/hooks/useOpenOnCreateQuery';
import { formatError } from '@/lib/constants';
import { Search, Puzzle, Plus, Upload, Star } from 'lucide-react';
import { PLUGIN_CATEGORIES, CATEGORY_DISPLAY_NAMES } from '@/lib/plugin-categories';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { useFeatureGate } from '@/hooks/useFeatureGate';
import { useFetch } from '@/hooks/useFetch';
import { useListPage } from '@/hooks/useListPage';
import { useDelete } from '@/hooks/useDelete';
import { clearPluginCache } from '@/hooks/usePlugins';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { RoleBanner } from '@/components/ui/RoleBanner';
import { TabBar } from '@/components/ui/TabBar';
import { DeleteConfirmModal } from '@/components/ui/DeleteConfirmModal';
import { Button } from '@/components/ui/Button';
import { FilterInput } from '@/components/ui/FilterInput';
import { FilterSelect } from '@/components/ui/FilterSelect';
import { DataTable } from '@/components/ui/DataTable';
import { ResourceList } from '@/components/ui/ResourceList';
import { FilterBar } from '@/components/ui/FilterBar';
import { PluginDetailModal } from '@/components/plugin/PluginDetailModal';
import { usePluginColumns, PLUGIN_SORT_FIELD } from '@/components/plugin/usePluginColumns';
import { BulkActionBar, BulkActionBarSpacer, useRowSelection } from '@/components/dashboard/BulkActionBar';
import api from '@/lib/api';
import { PLUGIN_LIST_FIELDS, type PluginSummary } from '@/lib/api/domains/plugins';
import { mapCommonParams, canModify } from '@/lib/resource-helpers';
import { buildListSummary } from '@/lib/list-summary';
import { visitedPluginsKey } from '@/lib/onboarding';
import { useFavorites } from '@/lib/favorites';

// Modals and the recently-deleted panel load on first use — none of them is
// part of the list's first paint, and the create modal carries the AI builder.
const CreatePluginModal = dynamic(() => import('@/components/plugin/CreatePluginModal'), { ssr: false });
const EditPluginModal = dynamic(() => import('@/components/plugin/EditPluginModal'), { ssr: false });
const RecentlyDeletedPanel = dynamic(() => import('@/components/RecentlyDeletedPanel').then((m) => m.RecentlyDeletedPanel), { ssr: false });

/** `fields` for the list request — every rendered column, never the build spec. */
const LIST_FIELDS = PLUGIN_LIST_FIELDS.join(',');

// ─── Page ───────────────────────────────────────────────

/** Plugin management page. Lists, creates, edits, and deletes plugins with filtering by type, compute, and access. */
export default function PluginsPage() {
  const { accessDenied, user, isReady, isAuthenticated, isSuperAdmin, isOrgAdminUser, isAdmin, can } = useAuthGuard();
  const toast = useToast();
  const canViewPublic = isSuperAdmin;
  // Fine-grained RBAC: write controls (create/upload/edit/delete/bulk/select)
  // unlock on `plugins:write`, not org-admin role, so a custom-group member
  // granted the capability gets them too. Role-admins hold it in their bundle.
  const canWrite = can('plugins:write');
  // Publishing (making a plugin PUBLIC) is a distinct capability the backend
  // gates upload/update/delete/bulk on — mirror the pipelines pattern
  // (`can('pipelines:publish')`) instead of the old `isSuperAdmin` proxy, so a
  // custom-group member granted `plugins:publish` can publish. Superadmins bypass.
  const canPublish = can('plugins:publish');
  // Batch activate/deactivate/delete is a tier-gated feature: the backend
  // attaches `requireFeature('bulk_operations')` to the bulk routes, so without
  // the flag every bulk action 403s. The backend ALSO gates bulk delete/update
  // on `plugins:publish`, so a write-but-not-publish member would 403 too —
  // include `canPublish` so we don't surface controls guaranteed to fail.
  const bulkGate = useFeatureGate('bulk_operations');
  const canBulk = canWrite && canPublish && bulkGate.entitled;

  // Row write gate — mirrors the backend's requireVisibilityWriteAccess so the
  // UI never offers an action the API refuses.
  const userId = user?.id;
  const canWriteRow = useCallback(
    (p: { visibility?: string; createdBy?: string }) => canWrite && canModify(p, { isSuperAdmin, canPublish, userId }),
    [canWrite, isSuperAdmin, canPublish, userId],
  );

  // Mark the "explore plugin catalog" onboarding step as complete on first visit.
  useEffect(() => {
    if (typeof window === 'undefined' || !user?.organizationId) return;
    try { localStorage.setItem(visitedPluginsKey(user.organizationId), '1'); } catch { /* localStorage may be unavailable */ }
  }, [user?.organizationId]);

  // Favorited plugin IDs for this user in this org. The preferences store
  // paints from its local cache, reconciles with the server once per page load,
  // and never lets that load revert a toggle made while it was in flight.
  const { favorites, toggle: handleToggleFavorite } = useFavorites(user?.id, user?.organizationId);

  // Plugin usage counts (how many of the org's pipelines reference each plugin).
  // Non-blocking — on failure the "Used by" badge just doesn't render.
  const { data: usageData } = useFetch(async () => {
    if (!isAuthenticated) return {};
    try {
      return (await api.getPluginUsage()).data?.counts ?? {};
    } catch {
      return {};
    }
  }, [isAuthenticated]);
  const pluginUsage = useMemo(() => usageData ?? {}, [usageData]);

  // ── Data ──

  // Offset-paged (page numbers, page size and a URL-synced offset), so the
  // keyset `cursor` the endpoint also offers doesn't fit here; `fields` does —
  // the list never renders the build spec (commands, dockerfile, env, …).
  const list = useListPage<PluginSummary>({
    fields: [
      { key: 'name', type: 'text', defaultValue: '', primary: true },
      { key: 'id', type: 'text', defaultValue: '' },
      { key: 'orgId', type: 'text', defaultValue: '' },
      { key: 'version', type: 'text', defaultValue: '' },
      { key: 'keyword', type: 'text', defaultValue: '' },
      { key: 'category', type: 'select', defaultValue: 'all' },
      { key: 'pluginType', type: 'select', defaultValue: 'all' },
      { key: 'computeType', type: 'select', defaultValue: 'all' },
      { key: 'visibility', type: 'select', defaultValue: 'all' },
      { key: 'status', type: 'select', defaultValue: 'all' },
      { key: 'default', type: 'select', defaultValue: 'all' },
    ],
    // Server-side default sort mirrors the previous client-side default
    // (name ascending) so the initial view is unchanged.
    initialSort: { sortBy: 'name', sortOrder: 'asc' },
    fetcher: async (params, signal) => {
      const p: Record<string, string> = {
        ...mapCommonParams(params),
        limit: params.limit,
        offset: params.offset,
        includeTotal: 'true',
        fields: LIST_FIELDS,
      };
      if (params.name) p.name = params.name;
      if (params.id) p.id = params.id;
      if (params.orgId) p.orgId = params.orgId;
      if (params.version) p.version = params.version;
      if (params.keyword) p.keyword = params.keyword;
      if (params.category && params.category !== 'all') p.category = params.category;
      if (params.pluginType) p.pluginType = params.pluginType;
      // NOTE: computeType is intentionally NOT forwarded — PluginFilterSchema
      // strips it server-side, so it's applied as a client-side filter below.
      if (params.sortBy) p.sortBy = params.sortBy;
      if (params.sortOrder) p.sortOrder = params.sortOrder;
      const response = await api.listPlugins(p, { signal });
      return { items: response.data?.plugins || [], pagination: response.data?.pagination };
    },
    enabled: isAuthenticated,
    urlSync: true,
  });

  // Any write here re-reads this page AND drops the pipeline builder's cached
  // plugin catalog (usePlugins), which would otherwise offer a deleted or
  // deactivated plugin until its TTL ran out.
  const { refresh: refreshList } = list;
  const afterWrite = useCallback(() => { clearPluginCache(); refreshList(); }, [refreshList]);

  const del = useDelete<PluginSummary>(
    (p) => api.deletePlugin(p.id),
    () => { afterWrite(); toast.success('Plugin deleted'); },
    (err) => list.setError(formatError(err, 'Failed to delete plugin')),
  );

  // "Show favorites only" quick-chip (client-side over the fetched page).
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);
  // Active vs. Recently-deleted view (tabs); the tab is write-gated like restore.
  const [deletedView, setDeletedView] = useState<'active' | 'deleted'>('active');

  // Seed the name search from a `?q=` deep-link (e.g. ⌘K "find plugin X" or a
  // My Services plugin link) so the list lands filtered to that plugin.
  const router = useRouter();
  useEffect(() => {
    const q = router.query.q;
    if (typeof q === 'string' && q) list.updateFilter('name', q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.query.q]);

  // Server-side sort: translate a column click into sortBy/sortOrder query
  // params, instead of an in-memory reorder of one page.
  const { setSort, clearFilters } = list;
  const handleServerSort = useCallback((columnId: string, direction: 'asc' | 'desc') => {
    setSort(PLUGIN_SORT_FIELD[columnId] ?? columnId, direction);
  }, [setSort]);

  // Clear both the useListPage filters and the favorites-only chip (the chip
  // is page-local state the hook doesn't know about).
  const clearAllFilters = useCallback(() => {
    clearFilters();
    setShowFavoritesOnly(false);
  }, [clearFilters]);

  // Backend returns the right scope (own org + system-public catalog). The
  // remaining client-side filters compose over that page: `computeType`
  // (PluginFilterSchema strips it, so there's no server support) and the
  // "favorites only" chip.
  const computeTypeFilter = list.filters.computeType;
  const filteredPlugins = useMemo(() => {
    let result = list.data;
    if (computeTypeFilter && computeTypeFilter !== 'all') {
      result = result.filter((p) => p.computeType === computeTypeFilter);
    }
    if (showFavoritesOnly) {
      result = result.filter((p) => favorites.has(p.id));
    }
    return result;
  }, [list.data, computeTypeFilter, showFavoritesOnly, favorites]);

  // Either an advanced/search filter or the favorites chip narrows the page.
  const hasActiveFilters = list.hasActiveFilters || showFavoritesOnly;

  // Always-on result feedback + current-page exception surfacing (server-
  // paginated, so inactive/private counts are scoped to this page).
  const listSummary = useMemo(
    () => buildListSummary(filteredPlugins, list.pagination.total, {
      noun: 'plugin',
      isLoading: list.isLoading,
      flags: [
        { label: 'inactive', pred: (p) => !p.isActive },
        { label: 'private', pred: (p) => p.visibility !== 'public' },
      ],
    }),
    [filteredPlugins, list.isLoading, list.pagination.total],
  );

  // ── Bulk Operations ──

  const selection = useRowSelection();
  const { selectedIds, clear: clearSelection } = selection;
  const [bulkLoading, setBulkLoading] = useState(false);
  // Gate bulk delete behind a confirmation modal (mirrors single-row delete's
  // DeleteConfirmModal), since the bulk action is destructive and irreversible.
  const [showBulkDelete, setShowBulkDelete] = useState(false);

  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return;
    setBulkLoading(true);
    try {
      const count = selectedIds.size;
      await api.bulkDeletePlugins(Array.from(selectedIds));
      clearSelection();
      setShowBulkDelete(false);
      afterWrite();
      toast.success(`${count} plugin${count > 1 ? 's' : ''} deleted`);
    } catch (err) {
      list.setError(formatError(err, 'Failed to delete plugins'));
    } finally {
      setBulkLoading(false);
    }
  };

  const handleBulkActivate = async (isActive: boolean) => {
    if (selectedIds.size === 0) return;
    setBulkLoading(true);
    try {
      const count = selectedIds.size;
      await api.bulkUpdatePlugins(Array.from(selectedIds), { isActive });
      clearSelection();
      afterWrite();
      toast.success(`${count} plugin${count > 1 ? 's' : ''} ${isActive ? 'activated' : 'deactivated'}`);
    } catch (err) {
      list.setError(formatError(err, `Failed to ${isActive ? 'activate' : 'deactivate'} plugins`));
    } finally {
      setBulkLoading(false);
    }
  };

  // ── Modals ──

  const [showAdvanced, setShowAdvanced] = useState(false);
  // CreatePluginModal is a tabbed surface (AI Builder + Upload). The two
  // toolbar buttons just pick which tab to open it on; only one modal exists.
  const [createInitialTab, setCreateInitialTab] = useState<'upload' | 'ai' | null>(null);
  const [editPlugin, setEditPlugin] = useState<PluginSummary | null>(null);
  const [viewPlugin, setViewPlugin] = useState<PluginSummary | null>(null);

  // Open the create modal (AI Builder tab) when arrived via the sidebar "Add
  // Plugin" shortcut (`?create=1`).
  useOpenOnCreateQuery(() => { if (canWrite) setCreateInitialTab('ai'); });

  // ── Columns ──

  const openDelete = del.open;
  const pluginColumns = usePluginColumns({
    selectable: canBulk,
    selectedIds,
    onToggleSelect: selection.toggle,
    favorites,
    onToggleFavorite: handleToggleFavorite,
    usage: pluginUsage,
    canWriteRow,
    showRegistryLink: isSuperAdmin,
    onView: setViewPlugin,
    onEdit: setEditPlugin,
    onDelete: openDelete,
  });

  // ── Render ──

  if (accessDenied) return <AccessDenied denial={accessDenied} />;
  if (!isReady || !user) return <LoadingPage />;

  const emptyDescription = canWrite
    ? 'Get started by creating your first plugin.'
    : 'No private plugins available for your organization.';
  const emptyAction = canWrite
    ? <Button onClick={() => setCreateInitialTab('ai')}>Create Plugin</Button>
    : undefined;

  return (
    <DashboardLayout
      title="Plugins"
      subtitle="Manage build and deploy plugins"
      actions={
        canWrite ? (
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setCreateInitialTab('upload')}>
              <Upload className="w-4 h-4 mr-1.5" />
              Upload Plugin
            </Button>
            <Button onClick={() => setCreateInitialTab('ai')}>
              <Plus className="w-4 h-4 mr-1.5" />
              Create Plugin
            </Button>
          </div>
        ) : undefined
      }
    >
      <div className="page-section">
        <RoleBanner isSuperAdmin={isSuperAdmin} isOrgAdmin={isOrgAdminUser} isAdmin={isAdmin} resourceName="plugins" orgName={user.organizationName} size="sm" />

        {/* Active / Recently-deleted tabs (restore is write-gated). */}
        {canWrite && (
          <TabBar
            className="mb-4"
            items={[{ id: 'active', label: 'Active' }, { id: 'deleted', label: 'Recently deleted' }]}
            activeId={deletedView}
            onSelect={(id) => setDeletedView(id as 'active' | 'deleted')}
          />
        )}

        {canWrite && deletedView === 'deleted' ? (
          <RecentlyDeletedPanel resource="plugin" onRestored={afterWrite} canRestoreRow={(r) => canWriteRow({ visibility: r.visibility, createdBy: r.createdBy })} />
        ) : (
        <>
        {/* Sticky search + advanced-filter panel stays above the list shell.
            FilterBar is its own sticky surface with a "/" hotkey and a
            collapsible advanced panel — pulling it into ResourceList's
            inline header would defeat both. */}
        <FilterBar
          sticky
          searchValue={list.filters.name}
          onSearchChange={(v) => list.updateFilter('name', v)}
          searchPlaceholder="Search plugins... (press /)"
          showAdvanced={showAdvanced}
          onToggleAdvanced={() => setShowAdvanced(!showAdvanced)}
          advancedFilterCount={list.advancedFilterCount}
          onClearAll={clearAllFilters}
          summary={listSummary}
          advancedContent={
            <>
              <FilterInput type="text" aria-label="Filter by keyword" value={list.filters.keyword} onChange={(e) => list.updateFilter('keyword', e.target.value)} placeholder="Keyword..." className="max-w-[160px]" />
              <FilterSelect aria-label="Filter by category" value={list.filters.category} onChange={(e) => list.updateFilter('category', e.target.value)}>
                <option value="all">All Categories</option>
                {PLUGIN_CATEGORIES.map((cat) => (
                  <option key={cat} value={cat}>{CATEGORY_DISPLAY_NAMES[cat]}</option>
                ))}
              </FilterSelect>
              <FilterSelect aria-label="Filter by type" value={list.filters.pluginType} onChange={(e) => list.updateFilter('pluginType', e.target.value)}>
                <option value="all">All Types</option>
                <option value="CodeBuildStep">CodeBuildStep</option>
                <option value="ShellStep">ShellStep</option>
                <option value="ManualApprovalStep">ManualApprovalStep</option>
              </FilterSelect>
              <FilterSelect aria-label="Filter by compute" value={list.filters.computeType} onChange={(e) => list.updateFilter('computeType', e.target.value)}>
                <option value="all">All Compute</option>
                <option value="SMALL">SMALL</option>
                <option value="MEDIUM">MEDIUM</option>
                <option value="LARGE">LARGE</option>
                <option value="X2_LARGE">X2_LARGE</option>
              </FilterSelect>
              <FilterSelect aria-label="Filter by status" value={list.filters.status} onChange={(e) => list.updateFilter('status', e.target.value)}>
                <option value="all">All Status</option>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </FilterSelect>
              <FilterSelect aria-label="Filter by default" value={list.filters.default} onChange={(e) => list.updateFilter('default', e.target.value)}>
                <option value="all">All Plugins</option>
                <option value="default">Default only</option>
              </FilterSelect>
              {canViewPublic && (
                <FilterSelect aria-label="Filter by visibility" value={list.filters.visibility} onChange={(e) => list.updateFilter('visibility', e.target.value)}>
                  <option value="all">All Visibility</option>
                  <option value="public">Public</option>
                  {/* The ladder has THREE rungs — omitting `org` made every
                      org-shared row invisible under both other filter values. */}
                  <option value="org">Org</option>
                  <option value="private">Private</option>
                </FilterSelect>
              )}
            </>
          }
        />

        {/* Quick-chip: narrow the fetched page to this org's favorited
            plugins (localStorage-backed, same source as the star toggles). */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setShowFavoritesOnly((v) => !v)}
            aria-pressed={showFavoritesOnly}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-full border transition-colors ${
              showFavoritesOnly
                ? 'border-yellow-300 dark:border-yellow-600 bg-yellow-50 dark:bg-yellow-900/20 text-yellow-700 dark:text-yellow-300'
                : 'border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800'
            }`}
          >
            <Star className={`w-3.5 h-3.5 ${showFavoritesOnly ? 'fill-current' : ''}`} aria-hidden="true" />
            Favorites only
          </button>
        </div>

        {/* Spacer when sticky bulk bar is visible */}
        {canBulk && <BulkActionBarSpacer count={selectedIds.size} />}

        {/* ResourceList owns: error+retry, refresh button, empty state, and
            offset Pagination. Body is custom so we preserve DataTable's
            defaultSortColumn + showColumnToggle features (which ResourceList's
            table-mode slot doesn't forward). We swap emptyState manually when
            filters are active because ResourceList's built-in
            `filteredEmptyState` keys off the filter input it renders itself,
            and our filter input lives in FilterBar above. */}
        <ResourceList<PluginSummary>
          loading={list.isLoading}
          error={list.error}
          onRefresh={list.refresh}
          isEmpty={filteredPlugins.length === 0}
          pagination={list.pagination}
          onPageChange={list.handlePageChange}
          onPageSizeChange={list.handlePageSizeChange}
          errorTitle="Failed to load plugins"
          emptyState={hasActiveFilters ? {
            icon: Search,
            title: 'No plugins match your filters',
            description: 'Try adjusting your search or filter criteria.',
            action: <Button variant="secondary" onClick={clearAllFilters}>Clear filters</Button>,
          } : {
            icon: Puzzle,
            title: 'No plugins yet',
            description: emptyDescription,
            action: emptyAction,
          }}
        >
          <DataTable
            data={filteredPlugins}
            columns={pluginColumns}
            isLoading={list.isLoading}
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
            onSortChange={handleServerSort}
          />
        </ResourceList>

        </>
        )}
      </div>

      {createInitialTab && (
        <CreatePluginModal
          canPublish={canPublish}
          initialTab={createInitialTab}
          onClose={() => setCreateInitialTab(null)}
          onCreated={afterWrite}
        />
      )}

      {del.target && (
        <DeleteConfirmModal title="Delete Plugin" itemName={del.target.name} loading={del.loading} onConfirm={del.confirm} onCancel={del.close} />
      )}

      {showBulkDelete && (
        <DeleteConfirmModal
          title="Delete Plugins"
          itemName={`${selectedIds.size} plugin${selectedIds.size > 1 ? 's' : ''}`}
          loading={bulkLoading}
          onConfirm={handleBulkDelete}
          onCancel={() => setShowBulkDelete(false)}
        />
      )}

      {editPlugin && (
        <EditPluginModal plugin={editPlugin} canPublish={canPublish} onClose={() => setEditPlugin(null)} onSaved={refreshList} />
      )}

      {viewPlugin && (
        <PluginDetailModal plugin={viewPlugin} showRegistryLink={isSuperAdmin} onClose={() => setViewPlugin(null)} />
      )}

      {/* Sticky bottom bulk actions bar */}
      {canBulk && (
        <BulkActionBar
          count={selectedIds.size}
          busy={bulkLoading}
          onActivate={(isActive) => void handleBulkActivate(isActive)}
          onDelete={() => setShowBulkDelete(true)}
          onClear={clearSelection}
        />
      )}
    </DashboardLayout>
  );
}
