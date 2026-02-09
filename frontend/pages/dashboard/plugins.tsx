import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Upload, Search, Puzzle } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { LoadingPage, LoadingSpinner } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { RoleBanner } from '@/components/ui/RoleBanner';
import { Badge } from '@/components/ui/Badge';
import { DeleteConfirmModal } from '@/components/ui/DeleteConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
import EditPluginModal from '@/components/plugin/EditPluginModal';
import UploadPluginModal from '@/components/plugin/UploadPluginModal';
import api from '@/lib/api';
import { Plugin } from '@/types';

export default function PluginsPage() {
  const { user, isReady, isAuthenticated, isSysAdmin, isOrgAdminUser, isAdmin } = useAuthGuard();
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [accessFilter, setAccessFilter] = useState<'all' | 'public' | 'private'>('all');
  const [nameSearch, setNameSearch] = useState('');
  const [pluginTypeFilter, setPluginTypeFilter] = useState<string>('all');
  const [computeTypeFilter, setComputeTypeFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');

  const [showUploadModal, setShowUploadModal] = useState(false);
  const [editPlugin, setEditPlugin] = useState<Plugin | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Plugin | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  const canViewPublic = isSysAdmin;
  const canUploadPublic = isSysAdmin;

  const fetchPlugins = async () => {
    if (!isAuthenticated) return;
    try {
      setIsLoading(true);
      const params: Record<string, string> = {};
      if (accessFilter !== 'all') {
        params.accessModifier = accessFilter;
      } else if (!canViewPublic) {
        params.accessModifier = 'private';
      }
      const response = await api.listPlugins(params);
      setPlugins((response.plugins || []) as Plugin[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load plugins');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isAuthenticated) fetchPlugins();
  }, [isAuthenticated, accessFilter, canViewPublic]);

  const hasActiveFilters = nameSearch !== '' || pluginTypeFilter !== 'all' || computeTypeFilter !== 'all' || statusFilter !== 'all' || accessFilter !== 'all';

  const clearFilters = () => {
    setNameSearch('');
    setPluginTypeFilter('all');
    setComputeTypeFilter('all');
    setStatusFilter('all');
    setAccessFilter('all');
  };

  const filteredPlugins = plugins.filter(plugin => {
    if (!canViewPublic && plugin.accessModifier === 'public') return false;
    if (accessFilter !== 'all' && plugin.accessModifier !== accessFilter) return false;
    if (nameSearch) {
      const q = nameSearch.toLowerCase();
      const matchesName = plugin.name.toLowerCase().includes(q);
      const matchesDesc = (plugin.description || '').toLowerCase().includes(q);
      const matchesKeywords = (plugin.keywords || []).some(k => k.toLowerCase().includes(q));
      if (!matchesName && !matchesDesc && !matchesKeywords) return false;
    }
    if (pluginTypeFilter !== 'all' && plugin.pluginType !== pluginTypeFilter) return false;
    if (computeTypeFilter !== 'all' && plugin.computeType !== computeTypeFilter) return false;
    if (statusFilter !== 'all') {
      if (plugin.isActive !== (statusFilter === 'active')) return false;
    }
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
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete plugin');
      setDeleteTarget(null);
    } finally {
      setDeleteLoading(false);
    }
  };

  const canDelete = (plugin: Plugin) => isSysAdmin || plugin.accessModifier === 'private';

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
            <input type="text" value={nameSearch} onChange={(e) => setNameSearch(e.target.value)} placeholder="Search plugins..." className="filter-input" />
          </div>
          <select value={pluginTypeFilter} onChange={(e) => setPluginTypeFilter(e.target.value)} className="filter-select">
            <option value="all">All Types</option>
            <option value="CodeBuildStep">CodeBuildStep</option>
            <option value="ShellStep">ShellStep</option>
            <option value="ManualApprovalStep">ManualApprovalStep</option>
          </select>
          <select value={computeTypeFilter} onChange={(e) => setComputeTypeFilter(e.target.value)} className="filter-select">
            <option value="all">All Compute</option>
            <option value="SMALL">SMALL</option>
            <option value="MEDIUM">MEDIUM</option>
            <option value="LARGE">LARGE</option>
            <option value="X2_LARGE">X2_LARGE</option>
          </select>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="filter-select">
            <option value="all">All Status</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
          {canViewPublic && (
            <select value={accessFilter} onChange={(e) => setAccessFilter(e.target.value as 'all' | 'public' | 'private')} className="filter-select">
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

      {isLoading ? (
        <div className="flex justify-center py-12"><LoadingSpinner size="lg" /></div>
      ) : filteredPlugins.length === 0 && hasActiveFilters && plugins.length > 0 ? (
        <EmptyState
          icon={Search}
          title="No plugins match your filters"
          description="Try adjusting your search or filter criteria."
          action={<button onClick={clearFilters} className="btn btn-secondary">Clear filters</button>}
        />
      ) : filteredPlugins.length === 0 ? (
        <EmptyState
          icon={Puzzle}
          title="No plugins yet"
          description={isAdmin ? 'Get started by uploading your first plugin.' : 'No private plugins available for your organization.'}
          action={isAdmin ? <button onClick={() => setShowUploadModal(true)} className="btn btn-primary">Upload Plugin</button> : undefined}
        />
      ) : (
        <div className="data-table">
          <table className="min-w-full">
            <thead>
              <tr>
                <th>Name</th>
                <th>Version</th>
                <th>Type</th>
                <th>Compute</th>
                <th>Access</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredPlugins.map((plugin, i) => (
                <motion.tr
                  key={plugin.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.2, delay: i * 0.03 }}
                >
                  <td>
                    <div className="text-sm font-medium text-gray-900 dark:text-gray-100">{plugin.name}</div>
                    {plugin.description && (
                      <div className="text-sm text-gray-500 dark:text-gray-400 truncate max-w-xs">{plugin.description}</div>
                    )}
                  </td>
                  <td className="text-sm text-gray-500 dark:text-gray-400">{plugin.version}</td>
                  <td className="text-sm text-gray-500 dark:text-gray-400">{plugin.pluginType}</td>
                  <td className="text-sm text-gray-500 dark:text-gray-400">{plugin.computeType}</td>
                  <td>
                    <Badge color={plugin.accessModifier === 'public' ? 'green' : 'gray'}>{plugin.accessModifier}</Badge>
                  </td>
                  <td>
                    <Badge color={plugin.isActive ? 'green' : 'red'}>{plugin.isActive ? 'Active' : 'Inactive'}</Badge>
                  </td>
                  <td className="text-sm">
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
                  </td>
                </motion.tr>
              ))}
            </tbody>
          </table>
        </div>
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
