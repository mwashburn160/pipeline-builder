import { useEffect, useState, useCallback, useMemo } from 'react';
import { Upload, Search, Puzzle } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useDebounce } from '@/hooks/useDebounce';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { RoleBanner } from '@/components/ui/RoleBanner';
import { Badge } from '@/components/ui/Badge';
import { DeleteConfirmModal } from '@/components/ui/DeleteConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { DataTable, type Column } from '@/components/ui/DataTable';
import EditPluginModal from '@/components/plugin/EditPluginModal';
import UploadPluginModal from '@/components/plugin/UploadPluginModal';
import api from '@/lib/api';
import { Plugin } from '@/types';

interface PluginFilters {
  name: string;
  id: string;
  orgId: string;
  version: string;
  imageTag: string;
  pluginType: string;
  computeType: string;
  access: 'all' | 'public' | 'private';
  status: 'all' | 'active' | 'inactive';
  default: 'all' | 'default' | 'non-default';
}

const initialFilters: PluginFilters = {
  name: '', id: '', orgId: '', version: '', imageTag: '',
  pluginType: 'all', computeType: 'all',
  access: 'all', status: 'all', default: 'all',
};

export default function PluginsPage() {
  const { user, isReady, isAuthenticated, isSysAdmin, isOrgAdminUser, isAdmin } = useAuthGuard();
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [filters, setFilters] = useState<PluginFilters>(initialFilters);
  const updateFilter = <K extends keyof PluginFilters>(key: K, value: PluginFilters[K]) =>
    setFilters(prev => ({ ...prev, [key]: value }));

  // Debounce text inputs to avoid API calls on every keystroke
  const debouncedName = useDebounce(filters.name, 300);
  const debouncedId = useDebounce(filters.id, 300);
  const debouncedOrgId = useDebounce(filters.orgId, 300);
  const debouncedVersion = useDebounce(filters.version, 300);
  const debouncedImageTag = useDebounce(filters.imageTag, 300);

  const [showUploadModal, setShowUploadModal] = useState(false);
  const [editPlugin, setEditPlugin] = useState<Plugin | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Plugin | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  const canViewPublic = isSysAdmin;
  const canUploadPublic = isSysAdmin;

  const fetchPlugins = useCallback(async () => {
    if (!isAuthenticated) return;
    try {
      setIsLoading(true);
      const params: Record<string, string> = {};
      if (debouncedId.trim()) params.id = debouncedId.trim();
      if (debouncedOrgId.trim()) params.orgId = debouncedOrgId.trim();
      if (filters.access !== 'all') {
        params.accessModifier = filters.access;
      } else if (!canViewPublic) {
        params.accessModifier = 'private';
      }
      if (filters.status !== 'all') {
        params.isActive = filters.status === 'active' ? 'true' : 'false';
      }
      if (filters.default !== 'all') {
        params.isDefault = filters.default === 'default' ? 'true' : 'false';
      }
      if (debouncedName.trim()) params.name = debouncedName.trim();
      if (debouncedVersion.trim()) params.version = debouncedVersion.trim();
      if (debouncedImageTag.trim()) params.imageTag = debouncedImageTag.trim();
      const response = await api.listPlugins(params);
      setPlugins(response.plugins || []);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to load plugins');
    } finally {
      setIsLoading(false);
    }
  }, [isAuthenticated, debouncedId, debouncedOrgId, debouncedName, debouncedVersion, debouncedImageTag, filters.access, filters.status, filters.default, canViewPublic]);

  useEffect(() => {
    if (isAuthenticated) fetchPlugins();
  }, [isAuthenticated, fetchPlugins]);

  const hasActiveFilters = Object.entries(filters).some(([key, value]) => {
    if (['access', 'status', 'default', 'pluginType', 'computeType'].includes(key)) return value !== 'all';
    return value !== '';
  });

  const clearFilters = () => setFilters(initialFilters);

  // Server-side handles CommonFilter + PluginFilter; client-side only for pluginType/computeType
  const filteredPlugins = plugins.filter(plugin => {
    if (!canViewPublic && plugin.accessModifier === 'public') return false;
    if (filters.pluginType !== 'all' && plugin.pluginType !== filters.pluginType) return false;
    if (filters.computeType !== 'all' && plugin.computeType !== filters.computeType) return false;
    return true;
  });

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleteLoading(true);
    try {
      const response = await api.deletePlugin(deleteTarget.id);
      if (response.success) {
        setDeleteTarget(null);
        await fetchPlugins();
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to delete plugin');
      setDeleteTarget(null);
    } finally {
      setDeleteLoading(false);
    }
  };

  const canDelete = (plugin: Plugin) => isSysAdmin || plugin.accessModifier === 'private';

  const pluginColumns: Column<Plugin>[] = useMemo(() => [
    {
      id: 'name',
      header: 'Name',
      sortValue: (p) => p.name,
      render: (p) => (
        <div>
          <div className="text-sm font-medium text-gray-900 dark:text-gray-100">{p.name}</div>
          {p.description && (
            <div className="text-sm text-gray-500 dark:text-gray-400 truncate max-w-xs">{p.description}</div>
          )}
        </div>
      ),
    },
    {
      id: 'version',
      header: 'Version',
      cellClassName: 'text-sm text-gray-500 dark:text-gray-400',
      sortValue: (p) => p.version,
      render: (p) => <>{p.version}</>,
    },
    {
      id: 'keywords',
      header: 'Keywords',
      cellClassName: 'text-sm text-gray-500 dark:text-gray-400 truncate max-w-[200px]',
      render: (p) => <span title={p.keywords?.join(', ') || ''}>{p.keywords?.length ? p.keywords.join(', ') : ''}</span>,
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
      id: 'status',
      header: 'Status',
      sortValue: (p) => p.isActive,
      render: (p) => <Badge color={p.isActive ? 'green' : 'red'}>{p.isActive ? 'Active' : 'Inactive'}</Badge>,
    },
    {
      id: 'default',
      header: 'Default',
      sortValue: (p) => p.isDefault,
      render: (p) => p.isDefault ? <Badge color="blue">Default</Badge> : null,
    },
    {
      id: 'actions',
      header: 'Actions',
      cellClassName: 'text-sm',
      render: (plugin) => (
        <div className="flex items-center space-x-3">
          {isSysAdmin || plugin.accessModifier === 'private' ? (
            <button onClick={() => setEditPlugin(plugin)} className="text-blue-600 dark:text-blue-400 hover:text-blue-900 dark:hover:text-blue-300 font-medium transition-colors">Edit</button>
          ) : (
            <span className="text-gray-400 dark:text-gray-500 text-xs">Read-only</span>
          )}
          {canDelete(plugin) && (
            <button onClick={() => setDeleteTarget(plugin)} className="text-red-600 dark:text-red-400 hover:text-red-900 dark:hover:text-red-300 font-medium transition-colors">Delete</button>
          )}
        </div>
      ),
    },
  ], [isSysAdmin]);

  if (!isReady || !user) return <LoadingPage />;

  return (
    <DashboardLayout
      title="Plugins"
      actions={
        isAdmin ? (
          <button onClick={() => setShowUploadModal(true)} className="btn btn-primary">
            <Upload className="w-4 h-4 mr-2" />
            Upload Plugin
          </button>
        ) : undefined
      }
    >
      <RoleBanner isSysAdmin={isSysAdmin} isOrgAdmin={isOrgAdminUser} isAdmin={isAdmin} resourceName="plugins" orgName={user.organizationName} />

      {error && (
        <div className="alert-error">
          <p>{error}</p>
        </div>
      )}

      {/* Filter Bar */}
      <div className="filter-bar">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-gray-500" />
            <input type="text" value={filters.name} onChange={(e) => updateFilter('name', e.target.value)} placeholder="Plugin name..." className="filter-input" />
          </div>
          <input type="text" value={filters.id} onChange={(e) => updateFilter('id', e.target.value)} placeholder="ID..." className="filter-input max-w-[160px]" />
          <input type="text" value={filters.orgId} onChange={(e) => updateFilter('orgId', e.target.value)} placeholder="Org ID..." className="filter-input max-w-[140px]" />
          <input type="text" value={filters.version} onChange={(e) => updateFilter('version', e.target.value)} placeholder="Version..." className="filter-input max-w-[120px]" />
          <input type="text" value={filters.imageTag} onChange={(e) => updateFilter('imageTag', e.target.value)} placeholder="Image tag..." className="filter-input max-w-[140px]" />
          <select value={filters.pluginType} onChange={(e) => updateFilter('pluginType', e.target.value)} className="filter-select">
            <option value="all">All Types</option>
            <option value="CodeBuildStep">CodeBuildStep</option>
            <option value="ShellStep">ShellStep</option>
            <option value="ManualApprovalStep">ManualApprovalStep</option>
          </select>
          <select value={filters.computeType} onChange={(e) => updateFilter('computeType', e.target.value)} className="filter-select">
            <option value="all">All Compute</option>
            <option value="SMALL">SMALL</option>
            <option value="MEDIUM">MEDIUM</option>
            <option value="LARGE">LARGE</option>
            <option value="X2_LARGE">X2_LARGE</option>
          </select>
          <select value={filters.status} onChange={(e) => updateFilter('status', e.target.value as PluginFilters['status'])} className="filter-select">
            <option value="all">All Status</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
          <select value={filters.default} onChange={(e) => updateFilter('default', e.target.value as PluginFilters['default'])} className="filter-select">
            <option value="all">All Default</option>
            <option value="default">Default</option>
            <option value="non-default">Non-Default</option>
          </select>
          {canViewPublic && (
            <select value={filters.access} onChange={(e) => updateFilter('access', e.target.value as PluginFilters['access'])} className="filter-select">
              <option value="all">All Access</option>
              <option value="public">Public</option>
              <option value="private">Private</option>
            </select>
          )}
          {hasActiveFilters && (
            <button type="button" onClick={clearFilters} className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors">Clear filters</button>
          )}
        </div>
        {!isLoading && hasActiveFilters && (
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">Showing {filteredPlugins.length} of {plugins.length} plugins</p>
        )}
      </div>

      {!isLoading && filteredPlugins.length === 0 && hasActiveFilters && plugins.length > 0 ? (
        <EmptyState
          icon={Search}
          title="No plugins match your filters"
          description="Try adjusting your search or filter criteria."
          action={<button onClick={clearFilters} className="btn btn-secondary">Clear filters</button>}
        />
      ) : (
        <DataTable
          data={filteredPlugins}
          columns={pluginColumns}
          isLoading={isLoading}
          emptyState={{
            icon: Puzzle,
            title: 'No plugins yet',
            description: isAdmin ? 'Get started by uploading your first plugin.' : 'No private plugins available for your organization.',
            action: isAdmin ? <button onClick={() => setShowUploadModal(true)} className="btn btn-primary">Upload Plugin</button> : undefined,
          }}
          getRowKey={(p) => p.id}
          defaultSortColumn="name"
        />
      )}

      {showUploadModal && (
        <UploadPluginModal
          canUploadPublic={canUploadPublic}
          onClose={() => setShowUploadModal(false)}
          onUploaded={fetchPlugins}
        />
      )}

      {deleteTarget && (
        <DeleteConfirmModal
          title="Delete Plugin"
          itemName={deleteTarget.name}
          loading={deleteLoading}
          onConfirm={handleDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {editPlugin && (
        <EditPluginModal
          plugin={editPlugin}
          isSysAdmin={isSysAdmin}
          onClose={() => setEditPlugin(null)}
          onSaved={fetchPlugins}
        />
      )}
    </DashboardLayout>
  );
}
