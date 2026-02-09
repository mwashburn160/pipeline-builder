import { useEffect, useState } from 'react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { LoadingPage, LoadingSpinner } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { RoleBanner } from '@/components/ui/RoleBanner';
import { Badge } from '@/components/ui/Badge';
import { DeleteConfirmModal } from '@/components/ui/DeleteConfirmModal';
import EditPipelineModal from '@/components/pipeline/EditPipelineModal';
import CreatePipelineModal from '@/components/pipeline/CreatePipelineModal';
import api from '@/lib/api';
import { Pipeline, BuilderProps } from '@/types';

export default function PipelinesPage() {
  const { user, isReady, isAuthenticated, isSysAdmin, isOrgAdminUser, isAdmin } = useAuthGuard();
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filter state
  const [accessFilter, setAccessFilter] = useState<'all' | 'public' | 'private'>('all');
  const [nameSearch, setNameSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');

  // Modal state
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createSuccess, setCreateSuccess] = useState<string | null>(null);
  const [editPipeline, setEditPipeline] = useState<Pipeline | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Pipeline | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  const canViewPublic = isSysAdmin;
  const canCreatePublic = isSysAdmin;

  const fetchPipelines = async () => {
    if (!isAuthenticated) return;
    try {
      setIsLoading(true);
      const params: Record<string, string> = {};
      if (accessFilter !== 'all') {
        params.accessModifier = accessFilter;
      } else if (!canViewPublic) {
        params.accessModifier = 'private';
      }
      const response = await api.listPipelines(params);
      setPipelines((response.pipelines || []) as Pipeline[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load pipelines');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isAuthenticated) fetchPipelines();
  }, [isAuthenticated, accessFilter, canViewPublic]);

  // Filters
  const hasActiveFilters = nameSearch !== '' || statusFilter !== 'all' || accessFilter !== 'all';

  const clearFilters = () => {
    setNameSearch('');
    setStatusFilter('all');
    setAccessFilter('all');
  };

  const filteredPipelines = pipelines.filter(pipeline => {
    if (!canViewPublic && pipeline.accessModifier === 'public') return false;
    if (accessFilter !== 'all' && pipeline.accessModifier !== accessFilter) return false;
    if (nameSearch) {
      const q = nameSearch.toLowerCase();
      const matchesName = (pipeline.pipelineName || '').toLowerCase().includes(q);
      const matchesDesc = (pipeline.description || '').toLowerCase().includes(q);
      const matchesProject = (pipeline.project || '').toLowerCase().includes(q);
      if (!matchesName && !matchesDesc && !matchesProject) return false;
    }
    if (statusFilter !== 'all') {
      if (pipeline.isActive !== (statusFilter === 'active')) return false;
    }
    return true;
  });

  const handleCreatePipeline = async (props: BuilderProps, accessModifier: 'public' | 'private') => {
    setCreateLoading(true);
    setCreateError(null);
    setCreateSuccess(null);
    try {
      const response = await api.createPipeline({ props, accessModifier });
      if (response.success) {
        setCreateSuccess('Pipeline created successfully!');
        await fetchPipelines();
        setTimeout(() => { setShowCreateModal(false); setCreateSuccess(null); }, 2000);
      }
    } catch (err) {
      let errorMessage = 'Failed to create pipeline';
      if (err instanceof Error) errorMessage = err.message;
      if (err && typeof err === 'object' && 'code' in err) {
        const apiErr = err as { message?: string; code?: string };
        errorMessage = apiErr.message || errorMessage;
        if (apiErr.code) errorMessage += ` (${apiErr.code})`;
      }
      setCreateError(errorMessage);
    } finally {
      setCreateLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleteLoading(true);
    try {
      const response = await api.deletePipeline(deleteTarget.id);
      if (response.success) {
        setDeleteTarget(null);
        await fetchPipelines();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete pipeline');
      setDeleteTarget(null);
    } finally {
      setDeleteLoading(false);
    }
  };

  const canDelete = (pipeline: Pipeline) => isSysAdmin || pipeline.accessModifier === 'private';

  if (!isReady || !user) return <LoadingPage />;

  return (
    <DashboardLayout
      title="Pipelines"
      actions={
        <button
          onClick={() => { setShowCreateModal(true); setCreateError(null); setCreateSuccess(null); }}
          className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
        >
          <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Create Pipeline
        </button>
      }
    >
      <RoleBanner isSysAdmin={isSysAdmin} isOrgAdmin={isOrgAdminUser} isAdmin={isAdmin} resourceName="pipelines" orgName={user.organizationName} />

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
            <input type="text" value={nameSearch} onChange={(e) => setNameSearch(e.target.value)} placeholder="Search pipelines..." className="block w-full pl-10 pr-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-blue-500 focus:border-blue-500" />
          </div>
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
          <p className="mt-2 text-xs text-gray-500">Showing {filteredPipelines.length} of {pipelines.length} pipelines</p>
        )}
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12"><LoadingSpinner size="lg" /></div>
      ) : filteredPipelines.length === 0 && hasActiveFilters && pipelines.length > 0 ? (
        <div className="bg-white shadow rounded-lg p-6 text-center">
          <svg className="mx-auto h-12 w-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <h3 className="mt-4 text-lg font-medium text-gray-900">No pipelines match your filters</h3>
          <p className="mt-2 text-sm text-gray-500">Try adjusting your search or filter criteria.</p>
          <button onClick={clearFilters} className="mt-4 inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50">Clear filters</button>
        </div>
      ) : filteredPipelines.length === 0 ? (
        <div className="bg-white shadow rounded-lg p-6 text-center">
          <svg className="mx-auto h-12 w-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2" />
          </svg>
          <h3 className="mt-4 text-lg font-medium text-gray-900">No pipelines yet</h3>
          <p className="mt-2 text-sm text-gray-500">
            {canViewPublic ? 'Get started by creating your first pipeline.' : 'No private pipelines available for your organization.'}
          </p>
          <button onClick={() => setShowCreateModal(true)} className="mt-4 inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700">Create Pipeline</button>
        </div>
      ) : (
        <div className="bg-white shadow rounded-lg overflow-hidden">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Name</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Project</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Organization</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Access</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {filteredPipelines.map((pipeline) => (
                <tr key={pipeline.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-sm font-medium text-gray-900">{pipeline.pipelineName}</div>
                    {pipeline.description && (
                      <div className="text-sm text-gray-500 truncate max-w-xs">{pipeline.description}</div>
                    )}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{pipeline.project}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{pipeline.organization}</td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <Badge color={pipeline.accessModifier === 'public' ? 'green' : 'gray'}>{pipeline.accessModifier}</Badge>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <Badge color={pipeline.isActive ? 'green' : 'red'}>{pipeline.isActive ? 'Active' : 'Inactive'}</Badge>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm">
                    <div className="flex items-center space-x-3">
                      {isSysAdmin || pipeline.accessModifier === 'private' ? (
                        <button onClick={() => setEditPipeline(pipeline)} className="text-blue-600 hover:text-blue-900 font-medium">Edit</button>
                      ) : (
                        <span className="text-gray-400 text-xs">Read-only</span>
                      )}
                      {canDelete(pipeline) && (
                        <button onClick={() => setDeleteTarget(pipeline)} className="text-red-600 hover:text-red-900 font-medium">Delete</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <CreatePipelineModal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onSubmit={handleCreatePipeline}
        createLoading={createLoading}
        createError={createError}
        createSuccess={createSuccess}
        canCreatePublic={canCreatePublic}
      />

      {deleteTarget && (
        <DeleteConfirmModal
          title="Delete Pipeline"
          itemName={deleteTarget.pipelineName || 'Unnamed Pipeline'}
          loading={deleteLoading}
          onConfirm={handleDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {editPipeline && (
        <EditPipelineModal
          pipeline={editPipeline}
          isSysAdmin={isSysAdmin}
          onClose={() => setEditPipeline(null)}
          onSaved={fetchPipelines}
        />
      )}
    </DashboardLayout>
  );
}
