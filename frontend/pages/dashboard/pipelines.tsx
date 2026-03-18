import { useState, useMemo } from 'react';
import { formatError } from '@/lib/constants';
import { Plus, GitBranch, Search } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useListPage } from '@/hooks/useListPage';
import { useDelete } from '@/hooks/useDelete';
import { useFormState } from '@/hooks/useFormState';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { RoleBanner } from '@/components/ui/RoleBanner';
import { Badge } from '@/components/ui/Badge';
import { DeleteConfirmModal } from '@/components/ui/DeleteConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Pagination } from '@/components/ui/Pagination';
import { FilterBar } from '@/components/ui/FilterBar';
import EditPipelineModal from '@/components/pipeline/EditPipelineModal';
import CreatePipelineModal from '@/components/pipeline/CreatePipelineModal';
import api from '@/lib/api';
import { mapCommonParams, canModify } from '@/lib/resource-helpers';
import type { Pipeline, BuilderProps } from '@/types';

// ─── Page ───────────────────────────────────────────────

/** Pipeline management page. Lists, creates, edits, and deletes CI/CD pipelines with filtering and sorting. */
export default function PipelinesPage() {
  const { user, isReady, isAuthenticated, isSysAdmin, isOrgAdminUser, isAdmin } = useAuthGuard();
  const canViewPublic = isSysAdmin;

  // ── Data ──

  const list = useListPage<Pipeline>({
    fields: [
      { key: 'name', type: 'text', defaultValue: '', primary: true },
      { key: 'id', type: 'text', defaultValue: '' },
      { key: 'orgId', type: 'text', defaultValue: '' },
      { key: 'project', type: 'text', defaultValue: '' },
      { key: 'organization', type: 'text', defaultValue: '' },
      { key: 'access', type: 'select', defaultValue: 'all' },
      { key: 'status', type: 'select', defaultValue: 'all' },
      { key: 'default', type: 'select', defaultValue: 'all' },
    ],
    fetcher: async (params) => {
      const p: Record<string, string> = {
        ...mapCommonParams(params, canViewPublic),
        limit: params.limit,
        offset: params.offset,
      };
      if (params.name) p.pipelineName = params.name;
      if (params.id) p.id = params.id;
      if (params.orgId) p.orgId = params.orgId;
      if (params.project) p.project = params.project;
      if (params.organization) p.organization = params.organization;
      const response = await api.listPipelines(p);
      return { items: response.data?.pipelines || [], pagination: response.data?.pagination };
    },
    enabled: isAuthenticated,
  });

  const del = useDelete<Pipeline>(
    (p) => api.deletePipeline(p.id),
    list.refresh,
    (err) => list.setError(formatError(err, 'Failed to delete pipeline')),
  );

  const filteredPipelines = canViewPublic
    ? list.data
    : list.data.filter(p => p.accessModifier !== 'public');

  // ── Create ──

  const [showCreateModal, setShowCreateModal] = useState(false);
  const createForm = useFormState();
  const [createSuccess, setCreateSuccess] = useState<string | null>(null);
  const [editPipeline, setEditPipeline] = useState<Pipeline | null>(null);

  const handleCreatePipeline = async (props: BuilderProps, accessModifier: 'public' | 'private', description?: string, keywords?: string[]) => {
    setCreateSuccess(null);
    const result = await createForm.run(() =>
      api.createPipeline({
        project: props.project,
        organization: props.organization,
        pipelineName: props.pipelineName,
        description,
        keywords,
        props,
        accessModifier,
      }),
    );
    if (result?.success) {
      setCreateSuccess('Pipeline created successfully!');
      list.refresh();
      setTimeout(() => { setShowCreateModal(false); setCreateSuccess(null); }, 2000);
    }
  };

  // ── Filters ──

  const [showAdvanced, setShowAdvanced] = useState(false);

  // ── Columns ──

  const pipelineColumns: Column<Pipeline>[] = useMemo(() => [
    {
      id: 'name',
      header: 'Name',
      sortValue: (p) => p.pipelineName || '',
      render: (p) => (
        <div>
          <div className="text-sm font-medium text-gray-900 dark:text-gray-100">{p.pipelineName}</div>
          {p.description && <div className="text-sm text-gray-500 dark:text-gray-400 truncate max-w-xs">{p.description}</div>}
        </div>
      ),
    },
    {
      id: 'pipelineId',
      header: 'Pipeline ID',
      cellClassName: 'text-sm text-gray-500 dark:text-gray-400 font-mono',
      sortValue: (p) => p.id,
      render: (p) => <>{p.id}</>,
    },
    {
      id: 'project',
      header: 'Project',
      cellClassName: 'text-sm text-gray-500 dark:text-gray-400',
      sortValue: (p) => p.project,
      render: (p) => <>{p.project}</>,
    },
    {
      id: 'organization',
      header: 'Organization',
      cellClassName: 'text-sm text-gray-500 dark:text-gray-400',
      sortValue: (p) => p.organization,
      render: (p) => <>{p.organization}</>,
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
      render: (pipeline) => (
        <div className="flex items-center space-x-3">
          {canModify(isSysAdmin, pipeline.accessModifier) ? (
            <button onClick={() => setEditPipeline(pipeline)} className="action-link">Edit</button>
          ) : (
            <span className="text-gray-400 dark:text-gray-500 text-xs">Read-only</span>
          )}
          {canModify(isSysAdmin, pipeline.accessModifier) && (
            <button onClick={() => del.open(pipeline)} className="action-link-danger">Delete</button>
          )}
        </div>
      ),
    },
  ], [isSysAdmin]);

  // ── Render ──

  if (!isReady || !user) return <LoadingPage />;

  return (
    <DashboardLayout
      title="Pipelines"
      subtitle="Create, edit, and monitor pipeline configurations"
      actions={
        <button onClick={() => { setShowCreateModal(true); createForm.reset(); setCreateSuccess(null); }} className="btn btn-primary">
          <Plus className="w-4 h-4 mr-2" />
          Create Pipeline
        </button>
      }
    >
      <div className="page-section">
        <RoleBanner isSysAdmin={isSysAdmin} isOrgAdmin={isOrgAdminUser} isAdmin={isAdmin} resourceName="pipelines" orgName={user.organizationName} />

        {list.error && <div className="alert-error"><p>{list.error}</p></div>}

        <FilterBar
          searchValue={list.filters.name}
          onSearchChange={(v) => list.updateFilter('name', v)}
          searchPlaceholder="Search pipelines..."
          showAdvanced={showAdvanced}
          onToggleAdvanced={() => setShowAdvanced(!showAdvanced)}
          advancedFilterCount={list.advancedFilterCount}
          onClearAll={list.clearFilters}
          summary={!list.isLoading && list.hasActiveFilters ? `Showing ${filteredPipelines.length} of ${list.pagination.total} pipelines` : undefined}
          advancedContent={
            <>
              <input type="text" value={list.filters.project} onChange={(e) => list.updateFilter('project', e.target.value)} placeholder="Project..." className="filter-input max-w-[160px]" />
              <input type="text" value={list.filters.organization} onChange={(e) => list.updateFilter('organization', e.target.value)} placeholder="Organization..." className="filter-input max-w-[160px]" />
              <select value={list.filters.status} onChange={(e) => list.updateFilter('status', e.target.value)} className="filter-select">
                <option value="all">All Status</option>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
              <select value={list.filters.default} onChange={(e) => list.updateFilter('default', e.target.value)} className="filter-select">
                <option value="all">All Default</option>
                <option value="default">Default</option>
                <option value="non-default">Non-Default</option>
              </select>
              {canViewPublic && (
                <select value={list.filters.access} onChange={(e) => list.updateFilter('access', e.target.value)} className="filter-select">
                  <option value="all">All Access</option>
                  <option value="public">Public</option>
                  <option value="private">Private</option>
                </select>
              )}
              <input type="text" value={list.filters.id} onChange={(e) => list.updateFilter('id', e.target.value)} placeholder="ID..." className="filter-input max-w-[160px]" />
              <input type="text" value={list.filters.orgId} onChange={(e) => list.updateFilter('orgId', e.target.value)} placeholder="Org ID..." className="filter-input max-w-[140px]" />
            </>
          }
        />

        {!list.isLoading && filteredPipelines.length === 0 && list.hasActiveFilters && list.data.length > 0 ? (
          <EmptyState
            icon={Search}
            title="No pipelines match your filters"
            description="Try adjusting your search or filter criteria."
            action={<button onClick={list.clearFilters} className="btn btn-secondary">Clear filters</button>}
          />
        ) : (
          <>
            <DataTable
              data={filteredPipelines}
              columns={pipelineColumns}
              isLoading={list.isLoading}
              emptyState={{
                icon: GitBranch,
                title: 'No pipelines yet',
                description: canViewPublic ? 'Get started by creating your first pipeline.' : 'No private pipelines available for your organization.',
                action: <button onClick={() => setShowCreateModal(true)} className="btn btn-primary">Create Pipeline</button>,
              }}
              getRowKey={(p) => p.id}
              defaultSortColumn="name"
            />
            {!list.isLoading && list.pagination.total > 0 && (
              <Pagination pagination={list.pagination} onPageChange={list.handlePageChange} onPageSizeChange={list.handlePageSizeChange} />
            )}
          </>
        )}
      </div>

      <CreatePipelineModal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onSubmit={handleCreatePipeline}
        createLoading={createForm.loading}
        createError={createForm.error}
        createSuccess={createSuccess}
        canCreatePublic={isSysAdmin}
      />

      {del.target && (
        <DeleteConfirmModal title="Delete Pipeline" itemName={del.target.pipelineName || 'Unnamed Pipeline'} loading={del.loading} onConfirm={del.confirm} onCancel={del.close} />
      )}

      {editPipeline && (
        <EditPipelineModal pipeline={editPipeline} isSysAdmin={isSysAdmin} onClose={() => setEditPipeline(null)} onSaved={list.refresh} />
      )}
    </DashboardLayout>
  );
}
