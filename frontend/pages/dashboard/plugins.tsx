import { useState, useMemo, useCallback, useEffect } from 'react';
import { useToast } from '@/components/ui/Toast';
import { formatError } from '@/lib/constants';
import { Search, Puzzle, Plus, Trash2, X, Upload, Star } from 'lucide-react';
import { PLUGIN_CATEGORIES, CATEGORY_DISPLAY_NAMES } from '@/lib/help';
import type { PluginCategory } from '@/lib/help';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useListPage } from '@/hooks/useListPage';
import { useDelete } from '@/hooks/useDelete';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { RoleBanner } from '@/components/ui/RoleBanner';
import { Badge } from '@/components/ui/Badge';
import { DeleteConfirmModal } from '@/components/ui/DeleteConfirmModal';
import { Modal } from '@/components/ui/Modal';
import { EmptyState } from '@/components/ui/EmptyState';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Pagination } from '@/components/ui/Pagination';
import { FilterBar } from '@/components/ui/FilterBar';
import EditPluginModal from '@/components/plugin/EditPluginModal';
import CreatePluginModal from '@/components/plugin/CreatePluginModal';
import UploadPluginModal from '@/components/plugin/UploadPluginModal';
import api from '@/lib/api';
import { mapCommonParams, canModify } from '@/lib/resource-helpers';
import { visitedPluginsKey } from '@/lib/onboarding';
import { loadFavorites, toggleFavorite } from '@/lib/favorites';
import type { Plugin } from '@/types';

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-medium text-gray-500 dark:text-gray-400">{label}</p>
      <p className="text-gray-900 dark:text-gray-100 font-mono text-xs mt-0.5">{value}</p>
    </div>
  );
}

// ─── Page ───────────────────────────────────────────────

/** Plugin management page. Lists, creates, edits, and deletes plugins with filtering by type, compute, and access. */
export default function PluginsPage() {
  const { user, isReady, isAuthenticated, isSysAdmin, isOrgAdminUser, isAdmin } = useAuthGuard();
  const toast = useToast();
  const canViewPublic = isSysAdmin;

  // Mark the "explore plugin catalog" onboarding step as complete on first visit.
  useEffect(() => {
    if (typeof window === 'undefined' || !user?.organizationId) return;
    localStorage.setItem(visitedPluginsKey(user.organizationId), '1');
  }, [user?.organizationId]);

  // Per-org favorited plugin IDs (localStorage-backed).
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (user?.organizationId) setFavorites(loadFavorites(user.organizationId));
  }, [user?.organizationId]);
  const handleToggleFavorite = useCallback((id: string) => {
    if (!user?.organizationId) return;
    toggleFavorite(user.organizationId, id);
    setFavorites(loadFavorites(user.organizationId));
  }, [user?.organizationId]);

  // Plugin usage counts (how many of the org's pipelines reference each plugin).
  const [pluginUsage, setPluginUsage] = useState<Record<string, number>>({});
  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    api.getPluginUsage()
      .then((r) => { if (!cancelled) setPluginUsage(r.data?.counts ?? {}); })
      .catch(() => { /* non-blocking — badge just won't render */ });
    return () => { cancelled = true; };
  }, [isAuthenticated]);

  // ── Data ──

  const list = useListPage<Plugin>({
    fields: [
      { key: 'name', type: 'text', defaultValue: '', primary: true },
      { key: 'id', type: 'text', defaultValue: '' },
      { key: 'orgId', type: 'text', defaultValue: '' },
      { key: 'version', type: 'text', defaultValue: '' },
      { key: 'category', type: 'select', defaultValue: 'all' },
      { key: 'pluginType', type: 'select', defaultValue: 'all' },
      { key: 'computeType', type: 'select', defaultValue: 'all' },
      { key: 'access', type: 'select', defaultValue: 'all' },
      { key: 'status', type: 'select', defaultValue: 'all' },
      { key: 'default', type: 'select', defaultValue: 'all' },
    ],
    fetcher: async (params) => {
      const p: Record<string, string> = {
        ...mapCommonParams(params),
        limit: params.limit,
        offset: params.offset,
        includeTotal: 'true',
      };
      if (params.name) p.name = params.name;
      if (params.id) p.id = params.id;
      if (params.orgId) p.orgId = params.orgId;
      if (params.version) p.version = params.version;
      if (params.category && params.category !== 'all') p.category = params.category;
      if (params.pluginType) p.pluginType = params.pluginType;
      if (params.computeType) p.computeType = params.computeType;
      const response = await api.listPlugins(p);
      return { items: response.data?.plugins || [], pagination: response.data?.pagination };
    },
    enabled: isAuthenticated,
  });

  const del = useDelete<Plugin>(
    (p) => api.deletePlugin(p.id),
    () => { list.refresh(); toast.success('Plugin deleted'); },
    (err) => list.setError(formatError(err, 'Failed to delete plugin')),
  );

  // Backend already returns the right scope (own org + system-public catalog)
  // for non-admins. No client-side filter — see resource-helpers.mapCommonParams.
  const filteredPlugins = list.data;

  // ── Bulk Operations ──

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkLoading, setBulkLoading] = useState(false);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    const modifiable = filteredPlugins.filter(p => canModify(isSysAdmin, p.accessModifier));
    if (selectedIds.size === modifiable.length && modifiable.length > 0) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(modifiable.map(p => p.id)));
    }
  }, [filteredPlugins, isSysAdmin, selectedIds.size]);

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return;
    setBulkLoading(true);
    try {
      const count = selectedIds.size;
      await api.bulkDeletePlugins(Array.from(selectedIds));
      clearSelection();
      list.refresh();
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
      list.refresh();
      toast.success(`${count} plugin${count > 1 ? 's' : ''} ${isActive ? 'activated' : 'deactivated'}`);
    } catch (err) {
      list.setError(formatError(err, `Failed to ${isActive ? 'activate' : 'deactivate'} plugins`));
    } finally {
      setBulkLoading(false);
    }
  };

  // ── Modals ──

  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [editPlugin, setEditPlugin] = useState<Plugin | null>(null);
  const [viewPlugin, setViewPlugin] = useState<Plugin | null>(null);

  // ── Columns ──

  const pluginColumns: Column<Plugin>[] = useMemo(() => [
    ...(isAdmin ? [{
      id: 'select',
      header: '',
      locked: true,
      render: (plugin: Plugin) => (
        canModify(isSysAdmin, plugin.accessModifier) ? (
          <input
            type="checkbox"
            checked={selectedIds.has(plugin.id)}
            onChange={(e) => {
              e.stopPropagation();
              toggleSelect(plugin.id);
            }}
            className="rounded border-gray-300 dark:border-gray-600"
          />
        ) : null
      ),
    } as Column<Plugin>] : []),
    {
      id: 'favorite',
      header: '',
      locked: true,
      render: (p: Plugin) => {
        const fav = favorites.has(p.id);
        return (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); handleToggleFavorite(p.id); }}
            className={`p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800 ${fav ? 'text-yellow-500' : 'text-gray-300 dark:text-gray-600 hover:text-yellow-500'}`}
            aria-label={fav ? 'Remove from favorites' : 'Add to favorites'}
            title={fav ? 'Favorited' : 'Add to favorites'}
          >
            <Star className={`w-4 h-4 ${fav ? 'fill-current' : ''}`} aria-hidden="true" />
          </button>
        );
      },
    },
    {
      id: 'name',
      header: 'Name',
      sortValue: (p) => p.name,
      render: (p) => {
        const used = pluginUsage[p.name] ?? 0;
        return (
          <div>
            <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
              {p.name}
              {!p.isActive && <Badge color="red" className="ml-2">Inactive</Badge>}
              {used > 0 && (
                <span title={`Referenced by ${used} pipeline${used === 1 ? '' : 's'} in your org`} className="ml-2 inline-block">
                  <Badge color="blue">Used by {used}</Badge>
                </span>
              )}
            </div>
            {p.description && <div className="text-sm text-gray-500 dark:text-gray-400 truncate max-w-xs">{p.description}</div>}
          </div>
        );
      },
    },
    {
      id: 'id',
      header: 'ID',
      hidden: true,
      cellClassName: 'text-sm text-gray-500 dark:text-gray-400 font-mono',
      sortValue: (p) => p.id,
      render: (p) => <span title={p.id}>{p.id.length > 8 ? `${p.id.slice(0, 8)}…` : p.id}</span>,
    },
    {
      id: 'version',
      header: 'Version',
      cellClassName: 'text-sm text-gray-500 dark:text-gray-400',
      sortValue: (p) => p.version,
      render: (p) => <>{p.version}</>,
    },
    {
      id: 'category',
      header: 'Category',
      sortValue: (p) => p.category || 'unknown',
      render: (p) => (
        <Badge color="blue">
          {CATEGORY_DISPLAY_NAMES[(p.category || 'unknown') as PluginCategory] || p.category || 'unknown'}
        </Badge>
      ),
    },
    {
      id: 'type',
      header: 'Type',
      hidden: true,
      cellClassName: 'text-sm text-gray-500 dark:text-gray-400',
      sortValue: (p) => p.pluginType,
      render: (p) => <>{p.pluginType}</>,
    },
    {
      id: 'compute',
      header: 'Compute',
      hidden: true,
      cellClassName: 'text-sm text-gray-500 dark:text-gray-400',
      sortValue: (p) => p.computeType,
      render: (p) => <>{p.computeType}</>,
    },
    {
      id: 'access',
      header: 'Access',
      sortValue: (p) => p.accessModifier,
      render: (p) => <Badge color={p.accessModifier === 'public' ? 'green' : 'gray'}>{p.accessModifier}</Badge>,
    },
    {
      id: 'imageTag',
      header: 'Image Tag',
      hidden: true,
      cellClassName: 'text-sm text-gray-500 dark:text-gray-400 font-mono',
      sortValue: (p) => p.imageTag,
      render: (p) => <span title={p.imageTag}>{p.imageTag}</span>,
    },
    {
      id: 'timeout',
      header: 'Timeout',
      hidden: true,
      cellClassName: 'text-sm text-gray-500 dark:text-gray-400',
      sortValue: (p) => p.timeout ?? 0,
      render: (p) => <>{p.timeout ? `${p.timeout} min` : '-'}</>,
    },
    {
      id: 'failureBehavior',
      header: 'On Failure',
      hidden: true,
      cellClassName: 'text-sm text-gray-500 dark:text-gray-400',
      sortValue: (p) => p.failureBehavior || '',
      render: (p) => <>{p.failureBehavior || '-'}</>,
    },
    {
      id: 'status',
      header: 'Status',
      hidden: true,
      sortValue: (p) => p.isActive,
      render: (p) => (
        <div className="flex gap-1">
          {p.isDefault && <Badge color="blue">Default</Badge>}
          <Badge color={p.isActive ? 'green' : 'red'}>{p.isActive ? 'Active' : 'Inactive'}</Badge>
        </div>
      ),
    },
    {
      id: 'createdBy',
      header: 'Created By',
      hidden: true,
      cellClassName: 'text-sm text-gray-500 dark:text-gray-400',
      sortValue: (p) => p.createdBy,
      render: (p) => <>{p.createdBy}</>,
    },
    {
      id: 'createdAt',
      header: 'Created',
      hidden: true,
      cellClassName: 'text-sm text-gray-500 dark:text-gray-400',
      sortValue: (p) => p.createdAt,
      render: (p) => <>{new Date(p.createdAt).toLocaleDateString()}</>,
    },
    {
      id: 'updatedAt',
      header: 'Updated',
      hidden: true,
      cellClassName: 'text-sm text-gray-500 dark:text-gray-400',
      sortValue: (p) => p.updatedAt,
      render: (p) => <>{new Date(p.updatedAt).toLocaleDateString()}</>,
    },
    {
      id: 'keywords',
      header: 'Keywords',
      hidden: true,
      cellClassName: 'text-sm text-gray-500 dark:text-gray-400',
      render: (p) => <>{(p.keywords || []).join(', ')}</>,
    },
    {
      id: 'actions',
      header: 'Actions',
      cellClassName: 'text-sm',
      render: (plugin) => (
        <div className="flex items-center space-x-3">
          <button onClick={() => setViewPlugin(plugin)} className="action-link">View</button>
          {canModify(isSysAdmin, plugin.accessModifier) && (
            <button onClick={() => setEditPlugin(plugin)} className="action-link">Edit</button>
          )}
          {canModify(isSysAdmin, plugin.accessModifier) && (
            <button onClick={() => del.open(plugin)} className="action-link-danger">Delete</button>
          )}
        </div>
      ),
    },
  ], [isSysAdmin, isAdmin, selectedIds, toggleSelect, favorites, handleToggleFavorite, pluginUsage]);

  // ── Render ──

  if (!isReady || !user) return <LoadingPage />;

  return (
    <DashboardLayout
      title="Plugins"
      subtitle="Manage build and deploy plugins"
      actions={
        isAdmin ? (
          <div className="flex gap-2">
            <button onClick={() => setShowUploadModal(true)} className="btn btn-secondary">
              <Upload className="w-4 h-4 mr-1.5" />
              Upload Plugin
            </button>
            <button onClick={() => setShowCreateModal(true)} className="btn btn-primary">
              <Plus className="w-4 h-4 mr-1.5" />
              Create Plugin
            </button>
          </div>
        ) : undefined
      }
    >
      <div className="page-section">
        <RoleBanner isSysAdmin={isSysAdmin} isOrgAdmin={isOrgAdminUser} isAdmin={isAdmin} resourceName="plugins" orgName={user.organizationName} />

        {list.error && <div className="alert-error"><p>{list.error}</p></div>}

        <FilterBar
          searchValue={list.filters.name}
          onSearchChange={(v) => list.updateFilter('name', v)}
          searchPlaceholder="Search plugins..."
          showAdvanced={showAdvanced}
          onToggleAdvanced={() => setShowAdvanced(!showAdvanced)}
          advancedFilterCount={list.advancedFilterCount}
          onClearAll={list.clearFilters}
          summary={!list.isLoading && list.hasActiveFilters ? `Showing ${filteredPlugins.length} of ${list.pagination.total} plugins` : undefined}
          advancedContent={
            <>
              <select value={list.filters.category} onChange={(e) => list.updateFilter('category', e.target.value)} className="filter-select">
                <option value="all">All Categories</option>
                {PLUGIN_CATEGORIES.map((cat) => (
                  <option key={cat} value={cat}>{CATEGORY_DISPLAY_NAMES[cat]}</option>
                ))}
              </select>
              <select value={list.filters.pluginType} onChange={(e) => list.updateFilter('pluginType', e.target.value)} className="filter-select">
                <option value="all">All Types</option>
                <option value="CodeBuildStep">CodeBuildStep</option>
                <option value="ShellStep">ShellStep</option>
                <option value="ManualApprovalStep">ManualApprovalStep</option>
              </select>
              <select value={list.filters.computeType} onChange={(e) => list.updateFilter('computeType', e.target.value)} className="filter-select">
                <option value="all">All Compute</option>
                <option value="SMALL">SMALL</option>
                <option value="MEDIUM">MEDIUM</option>
                <option value="LARGE">LARGE</option>
                <option value="X2_LARGE">X2_LARGE</option>
              </select>
              <select value={list.filters.status} onChange={(e) => list.updateFilter('status', e.target.value)} className="filter-select">
                <option value="all">All Status</option>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
              {canViewPublic && (
                <select value={list.filters.access} onChange={(e) => list.updateFilter('access', e.target.value)} className="filter-select">
                  <option value="all">All Access</option>
                  <option value="public">Public</option>
                  <option value="private">Private</option>
                </select>
              )}
            </>
          }
        />

        {/* Spacer when sticky bulk bar is visible */}
        {isAdmin && selectedIds.size > 0 && <div className="h-16" />}

        {!list.isLoading && filteredPlugins.length === 0 && list.hasActiveFilters && list.data.length > 0 ? (
          <EmptyState
            icon={Search}
            title="No plugins match your filters"
            description="Try adjusting your search or filter criteria."
            action={<button onClick={list.clearFilters} className="btn btn-secondary">Clear filters</button>}
          />
        ) : (
          <>
            <DataTable
              data={filteredPlugins}
              columns={pluginColumns}
              isLoading={list.isLoading}
              emptyState={{
                icon: Puzzle,
                title: 'No plugins yet',
                description: isAdmin ? 'Get started by creating your first plugin.' : 'No private plugins available for your organization.',
                action: isAdmin ? <button onClick={() => setShowCreateModal(true)} className="btn btn-primary">Create Plugin</button> : undefined,
              }}
              getRowKey={(p) => p.id}
              defaultSortColumn="name"
              showColumnToggle
            />
            {!list.isLoading && list.pagination.total > 0 && (
              <Pagination pagination={list.pagination} onPageChange={list.handlePageChange} onPageSizeChange={list.handlePageSizeChange} />
            )}
          </>
        )}
      </div>

      {showCreateModal && (
        <CreatePluginModal canUploadPublic={isSysAdmin} onClose={() => setShowCreateModal(false)} onCreated={list.refresh} />
      )}

      {showUploadModal && (
        <UploadPluginModal canUploadPublic={isSysAdmin} onClose={() => setShowUploadModal(false)} onUploaded={list.refresh} />
      )}

      {del.target && (
        <DeleteConfirmModal title="Delete Plugin" itemName={del.target.name} loading={del.loading} onConfirm={del.confirm} onCancel={del.close} />
      )}

      {editPlugin && (
        <EditPluginModal plugin={editPlugin} isSysAdmin={isSysAdmin} onClose={() => setEditPlugin(null)} onSaved={list.refresh} />
      )}

      {viewPlugin && (
        <Modal title={viewPlugin.name} onClose={() => setViewPlugin(null)} maxWidth="max-w-lg">
          <div className="space-y-4 text-sm">
            <div className="grid grid-cols-2 gap-3">
              <Detail label="Version" value={viewPlugin.version} />
              <Detail label="Category" value={viewPlugin.category || '—'} />
              <Detail label="Type" value={viewPlugin.pluginType} />
              <Detail label="Compute" value={viewPlugin.computeType} />
              <Detail label="Access" value={viewPlugin.accessModifier} />
              <Detail label="Timeout" value={viewPlugin.timeout ? `${viewPlugin.timeout} min` : '—'} />
              <Detail label="Active" value={viewPlugin.isActive ? 'Yes' : 'No'} />
              <Detail label="Default" value={viewPlugin.isDefault ? 'Yes' : 'No'} />
            </div>
            {viewPlugin.description && (
              <div>
                <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Description</p>
                <p className="text-gray-900 dark:text-gray-100">{viewPlugin.description}</p>
              </div>
            )}
            {viewPlugin.keywords && viewPlugin.keywords.length > 0 && (
              <div>
                <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Keywords</p>
                <div className="flex flex-wrap gap-1">
                  {viewPlugin.keywords.map((k: string, i: number) => (
                    <span key={`${k}-${i}`} className="px-2 py-0.5 rounded-full text-xs bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400">{k}</span>
                  ))}
                </div>
              </div>
            )}
            {viewPlugin.imageTag && (
              <Detail label="Image Tag" value={viewPlugin.imageTag} />
            )}
            <div className="grid grid-cols-2 gap-3 text-xs text-gray-500 dark:text-gray-400">
              <div>Created: {new Date(viewPlugin.createdAt).toLocaleString()}</div>
              <div>Updated: {new Date(viewPlugin.updatedAt).toLocaleString()}</div>
            </div>
          </div>
        </Modal>
      )}

      {/* Sticky bottom bulk actions bar */}
      {isAdmin && selectedIds.size > 0 && (
        <div className="fixed bottom-0 left-0 right-0 z-40 bg-white dark:bg-gray-900 border-t border-gray-200 dark:border-gray-700 shadow-lg">
          <div className="max-w-7xl mx-auto flex items-center justify-between px-6 py-3">
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
              {selectedIds.size} selected
            </span>
            <div className="flex items-center gap-2">
              <button onClick={() => handleBulkActivate(true)} disabled={bulkLoading} className="btn btn-secondary btn-xs">
                Activate
              </button>
              <button onClick={() => handleBulkActivate(false)} disabled={bulkLoading} className="btn btn-secondary btn-xs">
                Deactivate
              </button>
              <button onClick={handleBulkDelete} disabled={bulkLoading} className="btn btn-danger btn-xs">
                <Trash2 className="w-3.5 h-3.5" />
                Delete
              </button>
              <button onClick={clearSelection} className="p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300" title="Clear selection">
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}
