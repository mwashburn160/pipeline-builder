import { useEffect, useState } from 'react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { LoadingPage, LoadingSpinner } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { RoleBanner } from '@/components/ui/RoleBanner';
import { Badge } from '@/components/ui/Badge';
import { DeleteConfirmModal } from '@/components/ui/DeleteConfirmModal';
import EditPluginModal from '@/components/plugin/EditPluginModal';
import UploadPluginModal from '@/components/plugin/UploadPluginModal';
import api from '@/lib/api';
import { Plugin } from '@/types';

export default function PluginsPage() {
  const { user, isReady, isAuthenticated, isSysAdmin, isOrgAdminUser, isAdmin } = useAuthGuard();
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filter state
  const [accessFilter, setAccessFilter] = useState<'all' | 'public' | 'private'>('all');
  const [nameSearch, setNameSearch] = useState('');
  const [pluginTypeFilter, setPluginTypeFilter] = useState<string>('all');
  const [computeTypeFilter, setComputeTypeFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');

  // Modal state
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

  // Filters
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
          <button
            onClick={() => setShowUploadModal(true)}
            className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
          >
            <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
            </svg>
            Upload Plugin
          </button>
        ) : undefined
      }
    >
      <RoleBanner isSysAdmin={isSysAdmin} isOrgAdmin={isOrgAdminUser} isAdmin={isAdmin} resourceName="plugins" orgName={user.organizationName} />

      {error && (
        <div className="mb-6 rounded-md bg-red-50 p-4">
          <p className="text-sm font-medium text-red-800">{error}</p>
        </div>
      )}

      {/* Filter Bar */}
      <div className="mb-6 bg-white shadow rounded-lg p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[200px]">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input type="text" value={nameSearch} onChange={(e) => setNameSearch(e.target.value)} placeholder="Search plugins..." className="block w-full pl-10 pr-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-blue-500 focus:border-blue-500" />
          </div>
          <select value={pluginTypeFilter} onChange={(e) => setPluginTypeFilter(e.target.value)} className="block px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-blue-500 focus:border-blue-500">
            <option value="all">All Types</option>
            <option value="CodeBuildStep">CodeBuildStep</option>
            <option value="ShellStep">ShellStep</option>
            <option value="ManualApprovalStep">ManualApprovalStep</option>
          </select>
          <select value={computeTypeFilter} onChange={(e) => setComputeTypeFilter(e.target.value)} className="block px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-blue-500 focus:border-blue-500">
            <option value="all">All Compute</option>
            <option value="SMALL">SMALL</option>
            <option value="MEDIUM">MEDIUM</option>
            <option value="LARGE">LARGE</option>
            <option value="X2_LARGE">X2_LARGE</option>
          </select>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="block px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-blue-500 focus:border-blue-500">
            <option value="all">All Status</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
          {canViewPublic && (
            <select value={accessFilter} onChange={(e) => setAccessFilter(e.target.value as 'all' | 'public' | 'private')} className="block px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-blue-500 focus:border-blue-500">
              <option value="all">All Access</option>
              <option value="public">Public</option>
              <option value="private">Private</option>
            </select>
          )}
          {hasActiveFilters && (
            <button type="button" onClick={clearFilters} className="text-sm text-gray-500 hover:text-gray-700">Clear filters</button>
          )}
        </div>
        {!isLoading && hasActiveFilters && (
          <p className="mt-2 text-xs text-gray-500">Showing {filteredPlugins.length} of {plugins.length} plugins</p>
        )}
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12"><LoadingSpinner size="lg" /></div>
      ) : filteredPlugins.length === 0 && hasActiveFilters && plugins.length > 0 ? (
        <div className="bg-white shadow rounded-lg p-6 text-center">
          <svg className="mx-auto h-12 w-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <h3 className="mt-4 text-lg font-medium text-gray-900">No plugins match your filters</h3>
          <p className="mt-2 text-sm text-gray-500">Try adjusting your search or filter criteria.</p>
          <button onClick={clearFilters} className="mt-4 inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50">Clear filters</button>
        </div>
      ) : filteredPlugins.length === 0 ? (
        <div className="bg-white shadow rounded-lg p-6 text-center">
          <svg className="mx-auto h-12 w-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
          </svg>
          <h3 className="mt-4 text-lg font-medium text-gray-900">No plugins yet</h3>
          <p className="mt-2 text-sm text-gray-500">
            {isAdmin ? 'Get started by uploading your first plugin.' : 'No private plugins available for your organization.'}
          </p>
          {isAdmin && (
            <button onClick={() => setShowUploadModal(true)} className="mt-4 inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700">Upload Plugin</button>
          )}
        </div>
      ) : (
        <div className="bg-white shadow rounded-lg overflow-hidden">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Name</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Version</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Type</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Compute</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Access</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {filteredPlugins.map((plugin) => (
                <tr key={plugin.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-sm font-medium text-gray-900">{plugin.name}</div>
                    {plugin.description && (
                      <div className="text-sm text-gray-500 truncate max-w-xs">{plugin.description}</div>
                    )}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{plugin.version}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{plugin.pluginType}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{plugin.computeType}</td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <Badge color={plugin.accessModifier === 'public' ? 'green' : 'gray'}>{plugin.accessModifier}</Badge>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <Badge color={plugin.isActive ? 'green' : 'red'}>{plugin.isActive ? 'Active' : 'Inactive'}</Badge>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm">
                    <div className="flex items-center space-x-3">
                      {isSysAdmin || plugin.accessModifier === 'private' ? (
                        <button onClick={() => setEditPlugin(plugin)} className="text-blue-600 hover:text-blue-900 font-medium">Edit</button>
                      ) : (
                        <span className="text-gray-400 text-xs">Read-only</span>
                      )}
                      {canDelete(plugin) && (
                        <button onClick={() => setDeleteTarget(plugin)} className="text-red-600 hover:text-red-900 font-medium">Delete</button>
                      )}
                    </div>
                  </td>
                </tr>
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
