import { useEffect, useState, useCallback } from 'react';
import { motion } from 'framer-motion';
import { Plus, Search, GitBranch } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useDebounce } from '@/hooks/useDebounce';
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

interface PipelineFilters {
  name: string;
  id: string;
  orgId: string;
  project: string;
  organization: string;
  access: 'all' | 'public' | 'private';
  status: 'all' | 'active' | 'inactive';
  default: 'all' | 'default' | 'non-default';
}

const initialFilters: PipelineFilters = {
  name: '', id: '', orgId: '', project: '', organization: '',
  access: 'all', status: 'all', default: 'all',
};

export default function PipelinesPage() {
  const { user, isReady, isAuthenticated, isSysAdmin, isOrgAdminUser, isAdmin } = useAuthGuard();
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [filters, setFilters] = useState<PipelineFilters>(initialFilters);
  const updateFilter = <K extends keyof PipelineFilters>(key: K, value: PipelineFilters[K]) =>
    setFilters(prev => ({ ...prev, [key]: value }));

  // Debounce text inputs to avoid API calls on every keystroke
  const debouncedName = useDebounce(filters.name, 300);
  const debouncedId = useDebounce(filters.id, 300);
  const debouncedOrgId = useDebounce(filters.orgId, 300);
  const debouncedProject = useDebounce(filters.project, 300);
  const debouncedOrganization = useDebounce(filters.organization, 300);

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createSuccess, setCreateSuccess] = useState<string | null>(null);
  const [editPipeline, setEditPipeline] = useState<Pipeline | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Pipeline | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  const canViewPublic = isSysAdmin;
  const canCreatePublic = isSysAdmin;

  const fetchPipelines = useCallback(async () => {
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
      if (debouncedProject.trim()) params.project = debouncedProject.trim();
      if (debouncedOrganization.trim()) params.organization = debouncedOrganization.trim();
      if (debouncedName.trim()) params.pipelineName = debouncedName.trim();
      const response = await api.listPipelines(params);
      setPipelines((response.pipelines || []) as Pipeline[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load pipelines');
    } finally {
      setIsLoading(false);
    }
  }, [isAuthenticated, debouncedId, debouncedOrgId, debouncedProject, debouncedOrganization, debouncedName, filters.access, filters.status, filters.default, canViewPublic]);

  useEffect(() => {
    if (isAuthenticated) fetchPipelines();
  }, [isAuthenticated, fetchPipelines]);

  const hasActiveFilters = Object.entries(filters).some(([key, value]) => {
    if (['access', 'status', 'default'].includes(key)) return value !== 'all';
    return value !== '';
  });

  const clearFilters = () => setFilters(initialFilters);

  const filteredPipelines = canViewPublic
    ? pipelines
    : pipelines.filter(p => p.accessModifier !== 'public');

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
            <input type="text" value={filters.name} onChange={(e) => updateFilter('name', e.target.value)} placeholder="Pipeline name..." className="filter-input" />
          </div>
          <input type="text" value={filters.id} onChange={(e) => updateFilter('id', e.target.value)} placeholder="ID..." className="filter-input max-w-[160px]" />
          <input type="text" value={filters.orgId} onChange={(e) => updateFilter('orgId', e.target.value)} placeholder="Org ID..." className="filter-input max-w-[140px]" />
          <input type="text" value={filters.project} onChange={(e) => updateFilter('project', e.target.value)} placeholder="Project..." className="filter-input max-w-[160px]" />
          <input type="text" value={filters.organization} onChange={(e) => updateFilter('organization', e.target.value)} placeholder="Organization..." className="filter-input max-w-[160px]" />
          <select value={filters.status} onChange={(e) => updateFilter('status', e.target.value as PipelineFilters['status'])} className="filter-select">
            <option value="all">All Status</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
          <select value={filters.default} onChange={(e) => updateFilter('default', e.target.value as PipelineFilters['default'])} className="filter-select">
            <option value="all">All Default</option>
            <option value="default">Default</option>
            <option value="non-default">Non-Default</option>
          </select>
          {canViewPublic && (
            <select value={filters.access} onChange={(e) => updateFilter('access', e.target.value as PipelineFilters['access'])} className="filter-select">
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
                <th>Default</th>
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
                  <td>
                    {pipeline.isDefault && <Badge color="blue">Default</Badge>}
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
