import { useState, useMemo, useCallback } from 'react';
import { formatError } from '@/lib/constants';
import { Search, Puzzle, Plus, Trash2, X } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useListPage } from '@/hooks/useListPage';
import { useDelete } from '@/hooks/useDelete';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { RoleBanner } from '@/components/ui/RoleBanner';
import { Badge } from '@/components/ui/Badge';
import { DeleteConfirmModal } from '@/components/ui/DeleteConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Pagination } from '@/components/ui/Pagination';
import { FilterBar } from '@/components/ui/FilterBar';
import EditPluginModal from '@/components/plugin/EditPluginModal';
import CreatePluginModal from '@/components/plugin/CreatePluginModal';
import api from '@/lib/api';
import { mapCommonParams, canModify } from '@/lib/resource-helpers';
import type { Plugin } from '@/types';

// ─── Page ───────────────────────────────────────────────

/** Plugin management page. Lists, creates, edits, and deletes plugins with filtering by type, compute, and access. */
export default function PluginsPage() {
  const { user, isReady, isAuthenticated, isSysAdmin, isOrgAdminUser, isAdmin } = useAuthGuard();
  const canViewPublic = isSysAdmin;

  // ── Data ──

  const list = useListPage<Plugin>({
    fields: [
      { key: 'name', type: 'text', defaultValue: '', primary: true },
      { key: 'id', type: 'text', defaultValue: '' },
      { key: 'orgId', type: 'text', defaultValue: '' },
      { key: 'version', type: 'text', defaultValue: '' },
      { key: 'pluginType', type: 'select', defaultValue: 'all' },
      { key: 'computeType', type: 'select', defaultValue: 'all' },
      { key: 'access', type: 'select', defaultValue: 'all' },
      { key: 'status', type: 'select', defaultValue: 'all' },
      { key: 'default', type: 'select', defaultValue: 'all' },
    ],
    fetcher: async (params) => {
      const p: Record<string, string> = {
        ...mapCommonParams(params, canViewPublic),
        limit: params.limit,
        offset: params.offset,
        includeTotal: 'true',
      };
      if (params.name) p.name = params.name;
      if (params.id) p.id = params.id;
      if (params.orgId) p.orgId = params.orgId;
      if (params.version) p.version = params.version;
      if (params.pluginType) p.pluginType = params.pluginType;
      if (params.computeType) p.computeType = params.computeType;
      const response = await api.listPlugins(p);
      return { items: response.data?.plugins || [], pagination: response.data?.pagination };
    },
    enabled: isAuthenticated,
  });

  const del = useDelete<Plugin>(
    (p) => api.deletePlugin(p.id),
    list.refresh,
    (err) => list.setError(formatError(err, 'Failed to delete plugin')),
  );

  const filteredPlugins = canViewPublic
    ? list.data
    : list.data.filter(p => p.accessModifier !== 'public');

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
      await api.bulkDeletePlugins(Array.from(selectedIds));
      clearSelection();
      list.refresh();
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
      await api.bulkUpdatePlugins(Array.from(selectedIds), { isActive });
      clearSelection();
      list.refresh();
    } catch (err) {
      list.setError(formatError(err, `Failed to ${isActive ? 'activate' : 'deactivate'} plugins`));
    } finally {
      setBulkLoading(false);
    }
  };

  // ── Modals ──

  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editPlugin, setEditPlugin] = useState<Plugin | null>(null);

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
      id: 'name',
      header: 'Name',
      sortValue: (p) => p.name,
      render: (p) => (
        <div>
          <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
            {p.name}
            {!p.isActive && <Badge color="red" className="ml-2">Inactive</Badge>}
          </div>
          {p.description && <div className="text-sm text-gray-500 dark:text-gray-400 truncate max-w-xs">{p.description}</div>}
        </div>
      ),
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
      id: 'type',
      header: 'Type',
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
      id: 'actions',
      header: 'Actions',
      cellClassName: 'text-sm',
      render: (plugin) => (
        <div className="flex items-center space-x-3">
          {canModify(isSysAdmin, plugin.accessModifier) ? (
            <button onClick={() => setEditPlugin(plugin)} className="action-link">Edit</button>
          ) : (
            <span className="text-gray-400 dark:text-gray-500 text-xs">Read-only</span>
          )}
          {canModify(isSysAdmin, plugin.accessModifier) && (
            <button onClick={() => del.open(plugin)} className="action-link-danger">Delete</button>
          )}
        </div>
      ),
    },
  ], [isSysAdmin, isAdmin, selectedIds, toggleSelect]);

  // ── Render ──

  if (!isReady || !user) return <LoadingPage />;

  return (
    <DashboardLayout
      title="Plugins"
      subtitle="Manage build and deploy plugins"
      actions={
        isAdmin ? (
          <button onClick={() => setShowCreateModal(true)} className="btn btn-secondary">
            <Plus className="w-4 h-4 mr-2" />
            Create Plugin
          </button>
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

      {del.target && (
        <DeleteConfirmModal title="Delete Plugin" itemName={del.target.name} loading={del.loading} onConfirm={del.confirm} onCancel={del.close} />
      )}

      {editPlugin && (
        <EditPluginModal plugin={editPlugin} isSysAdmin={isSysAdmin} onClose={() => setEditPlugin(null)} onSaved={list.refresh} />
      )}

      {/* Sticky bottom bulk actions bar */}
      {isAdmin && selectedIds.size > 0 && (
        <div className="fixed bottom-0 left-0 right-0 z-40 bg-white dark:bg-gray-900 border-t border-gray-200 dark:border-gray-700 shadow-lg">
          <div className="max-w-7xl mx-auto flex items-center justify-between px-6 py-3">
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
              {selectedIds.size} selected
            </span>
            <div className="flex items-center gap-2">
              <button onClick={() => handleBulkActivate(true)} disabled={bulkLoading} className="btn btn-secondary text-xs px-3 py-1.5">
                Activate
              </button>
              <button onClick={() => handleBulkActivate(false)} disabled={bulkLoading} className="btn btn-secondary text-xs px-3 py-1.5">
                Deactivate
              </button>
              <button onClick={handleBulkDelete} disabled={bulkLoading} className="btn btn-danger text-xs px-3 py-1.5 inline-flex items-center gap-1">
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
