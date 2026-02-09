import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Plus, Search, GitBranch } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { LoadingPage, LoadingSpinner } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { RoleBanner } from '@/components/ui/RoleBanner';
import { Badge } from '@/components/ui/Badge';
import { DeleteConfirmModal } from '@/components/ui/DeleteConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
import EditPipelineModal from '@/components/pipeline/EditPipelineModal';
import CreatePipelineModal from '@/components/pipeline/CreatePipelineModal';
import api from '@/lib/api';
import { Pipeline, BuilderProps } from '@/types';

export default function PipelinesPage() {
  const { user, isReady, isAuthenticated, isSysAdmin, isOrgAdminUser, isAdmin } = useAuthGuard();
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [accessFilter, setAccessFilter] = useState<'all' | 'public' | 'private'>('all');
  const [nameSearch, setNameSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');

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
          className="btn btn-primary"
        >
          <Plus className="w-4 h-4 mr-2" />
          Create Pipeline
        </button>
      }
    >
      <RoleBanner isSysAdmin={isSysAdmin} isOrgAdmin={isOrgAdminUser} isAdmin={isAdmin} resourceName="pipelines" orgName={user.organizationName} />

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
            <input type="text" value={nameSearch} onChange={(e) => setNameSearch(e.target.value)} placeholder="Search pipelines..." className="filter-input" />
          </div>
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
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">Showing {filteredPipelines.length} of {pipelines.length} pipelines</p>
        )}
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12"><LoadingSpinner size="lg" /></div>
      ) : filteredPipelines.length === 0 && hasActiveFilters && pipelines.length > 0 ? (
        <EmptyState
          icon={Search}
          title="No pipelines match your filters"
          description="Try adjusting your search or filter criteria."
          action={<button onClick={clearFilters} className="btn btn-secondary">Clear filters</button>}
        />
      ) : filteredPipelines.length === 0 ? (
        <EmptyState
          icon={GitBranch}
          title="No pipelines yet"
          description={canViewPublic ? 'Get started by creating your first pipeline.' : 'No private pipelines available for your organization.'}
          action={<button onClick={() => setShowCreateModal(true)} className="btn btn-primary">Create Pipeline</button>}
        />
      ) : (
        <div className="data-table">
          <table className="min-w-full">
            <thead>
              <tr>
                <th>Name</th>
                <th>Project</th>
                <th>Organization</th>
                <th>Access</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredPipelines.map((pipeline, i) => (
                <motion.tr
                  key={pipeline.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.2, delay: i * 0.03 }}
                >
                  <td>
                    <div className="text-sm font-medium text-gray-900 dark:text-gray-100">{pipeline.pipelineName}</div>
                    {pipeline.description && (
                      <div className="text-sm text-gray-500 dark:text-gray-400 truncate max-w-xs">{pipeline.description}</div>
                    )}
                  </td>
                  <td className="text-sm text-gray-500 dark:text-gray-400">{pipeline.project}</td>
                  <td className="text-sm text-gray-500 dark:text-gray-400">{pipeline.organization}</td>
                  <td>
                    <Badge color={pipeline.accessModifier === 'public' ? 'green' : 'gray'}>{pipeline.accessModifier}</Badge>
                  </td>
                  <td>
                    <Badge color={pipeline.isActive ? 'green' : 'red'}>{pipeline.isActive ? 'Active' : 'Inactive'}</Badge>
                  </td>
                  <td className="text-sm">
                    <div className="flex items-center space-x-3">
                      {isSysAdmin || pipeline.accessModifier === 'private' ? (
                        <button onClick={() => setEditPipeline(pipeline)} className="text-blue-600 dark:text-blue-400 hover:text-blue-900 dark:hover:text-blue-300 font-medium transition-colors">Edit</button>
                      ) : (
                        <span className="text-gray-400 dark:text-gray-500 text-xs">Read-only</span>
                      )}
                      {canDelete(pipeline) && (
                        <button onClick={() => setDeleteTarget(pipeline)} className="text-red-600 dark:text-red-400 hover:text-red-900 dark:hover:text-red-300 font-medium transition-colors">Delete</button>
                      )}
                    </div>
                  </td>
                </motion.tr>
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
