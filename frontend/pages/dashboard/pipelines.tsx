import { useState, useMemo, useCallback } from 'react';
import { useOpenOnCreateQuery } from '@/hooks/useOpenOnCreateQuery';
import { useToast } from '@/components/ui/Toast';
import { formatError } from '@/lib/constants';
import { Plus, GitBranch, Search, Trash2, X } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useListPage } from '@/hooks/useListPage';
import { useDelete } from '@/hooks/useDelete';
import { useFormState } from '@/hooks/useFormState';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { RoleBanner } from '@/components/ui/RoleBanner';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { DeleteConfirmModal } from '@/components/ui/DeleteConfirmModal';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { ResourceList } from '@/components/ui/ResourceList';
import { FilterBar } from '@/components/ui/FilterBar';
import { RelativeTime } from '@/components/ui/RelativeTime';
import EditPipelineModal from '@/components/pipeline/EditPipelineModal';
import CreatePipelineModal from '@/components/pipeline/CreatePipelineModal';
import { DeployedPipelinesPanel } from '@/components/pipeline/DeployedPipelinesPanel';
import api from '@/lib/api';
import { mapCommonParams, canWritePipeline } from '@/lib/resource-helpers';
import type { Pipeline, BuilderProps } from '@/types';

// ─── Page ───────────────────────────────────────────────

/** Pipeline management page. Lists, creates, edits, and deletes CI/CD pipelines with filtering and sorting. */
export default function PipelinesPage() {
  const { user, isReady, isAuthenticated, isSuperAdmin, isOrgAdminUser, isAdmin, can } = useAuthGuard();
  const toast = useToast();
  const canViewPublic = isSuperAdmin;
  // Fine-grained RBAC: write controls (create/edit/delete/bulk/select) unlock
  // on `pipelines:write`, not org-admin role, so a custom-group member granted
  // the capability gets them too. Role-admins hold it in their bundle.
  const canWrite = can('pipelines:write');

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
        ...mapCommonParams(params),
        limit: params.limit,
        offset: params.offset,
        includeTotal: 'true',
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
    () => { list.refresh(); toast.success('Pipeline deleted'); },
    (err) => list.setError(formatError(err, 'Failed to delete pipeline')),
  );

  // Backend already returns the right scope (own org + system-public catalog)
  // for non-admins. No client-side filter — see resource-helpers.mapCommonParams.
  const filteredPipelines = list.data;

  // ── Create ──

  const [showCreateModal, setShowCreateModal] = useState(false);
  const createForm = useFormState();
  const [createSuccess, setCreateSuccess] = useState<string | null>(null);
  const [editPipeline, setEditPipeline] = useState<Pipeline | null>(null);

  // Open the create modal when arrived via the sidebar "Create Pipeline"
  // shortcut (`?create=1`).
  useOpenOnCreateQuery(() => setShowCreateModal(true));

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
      toast.success('Pipeline created');
      setTimeout(() => { setShowCreateModal(false); setCreateSuccess(null); }, 2000);
    }
  };

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

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return;
    setBulkLoading(true);
    try {
      const count = selectedIds.size;
      await api.bulkDeletePipelines(Array.from(selectedIds));
      clearSelection();
      list.refresh();
      toast.success(`${count} pipeline${count > 1 ? 's' : ''} deleted`);
    } catch (err) {
      list.setError(formatError(err, 'Failed to delete pipelines'));
    } finally {
      setBulkLoading(false);
    }
  };

  const handleBulkActivate = async (isActive: boolean) => {
    if (selectedIds.size === 0) return;
    setBulkLoading(true);
    try {
      const count = selectedIds.size;
      await api.bulkUpdatePipelines(Array.from(selectedIds), { isActive });
      clearSelection();
      list.refresh();
      toast.success(`${count} pipeline${count > 1 ? 's' : ''} ${isActive ? 'activated' : 'deactivated'}`);
    } catch (err) {
      list.setError(formatError(err, `Failed to ${isActive ? 'activate' : 'deactivate'} pipelines`));
    } finally {
      setBulkLoading(false);
    }
  };

  // ── Filters ──

  const [showAdvanced, setShowAdvanced] = useState(false);

  // ── Columns ──

  const pipelineColumns: Column<Pipeline>[] = useMemo(() => [
    ...(canWrite ? [{
      id: 'select',
      header: '',
      locked: true,
      render: (pipeline: Pipeline) => (
        canWritePipeline(can, isSuperAdmin, pipeline.accessModifier) ? (
          <input
            type="checkbox"
            checked={selectedIds.has(pipeline.id)}
            onChange={(e) => {
              e.stopPropagation();
              toggleSelect(pipeline.id);
            }}
            className="rounded border-gray-300 dark:border-gray-600"
          />
        ) : null
      ),
    } as Column<Pipeline>] : []),
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
      hidden: true,
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
      hidden: true,
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
      hidden: true,
      sortValue: (p) => p.isDefault,
      render: (p) => p.isDefault ? <Badge color="blue">Default</Badge> : null,
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
      render: (p) => <RelativeTime value={p.createdAt} />,
    },
    {
      id: 'updatedAt',
      header: 'Updated',
      hidden: true,
      cellClassName: 'text-sm text-gray-500 dark:text-gray-400',
      sortValue: (p) => p.updatedAt,
      render: (p) => <RelativeTime value={p.updatedAt} />,
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
      render: (pipeline) => (
        <div className="flex items-center space-x-3">
          {canWritePipeline(can, isSuperAdmin, pipeline.accessModifier) ? (
            <button onClick={() => setEditPipeline(pipeline)} className="action-link">Edit</button>
          ) : (
            <span className="text-gray-400 dark:text-gray-500 text-xs">Read-only</span>
          )}
          {canWritePipeline(can, isSuperAdmin, pipeline.accessModifier) && (
            <button onClick={() => del.open(pipeline)} className="action-link-danger">Delete</button>
          )}
        </div>
      ),
    },
  ], [isSuperAdmin, canWrite, can, selectedIds, toggleSelect]);

  // ── Render ──

  if (!isReady || !user) return <LoadingPage />;

  return (
    <DashboardLayout
      title="Pipelines"
      subtitle="Create, edit, and monitor pipeline configurations"
      actions={
        canWrite ? (
          <Button onClick={() => { setShowCreateModal(true); createForm.reset(); setCreateSuccess(null); }}>
            <Plus className="w-4 h-4 mr-2" />
            Create Pipeline
          </Button>
        ) : undefined
      }
    >
      <div className="page-section">
        <RoleBanner isSuperAdmin={isSuperAdmin} isOrgAdmin={isOrgAdminUser} isAdmin={isAdmin} resourceName="pipelines" orgName={user.organizationName} />

        <DeployedPipelinesPanel />

        {/* Sticky search + advanced-filter panel stays above the list shell.
            FilterBar is its own sticky surface with a "/" hotkey and a
            collapsible advanced panel — pulling it into ResourceList's
            inline header would defeat both. */}
        <FilterBar
          sticky
          searchValue={list.filters.name}
          onSearchChange={(v) => list.updateFilter('name', v)}
          searchPlaceholder="Search pipelines... (press /)"
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
        {canWrite && selectedIds.size > 0 && <div className="h-16" />}

        {/* ResourceList owns: error+retry, refresh button, empty state, and
            offset Pagination. Body is custom so we preserve DataTable's
            defaultSortColumn + showColumnToggle features (which ResourceList's
            table-mode slot doesn't forward). We swap emptyState manually when
            filters are active because ResourceList's built-in
            `filteredEmptyState` keys off the filter input it renders itself,
            and our filter input lives in FilterBar above. */}
        <ResourceList<Pipeline>
          loading={list.isLoading}
          error={list.error}
          onRefresh={list.refresh}
          isEmpty={filteredPipelines.length === 0}
          pagination={list.pagination}
          onPageChange={list.handlePageChange}
          onPageSizeChange={list.handlePageSizeChange}
          errorTitle="Failed to load pipelines"
          emptyState={list.hasActiveFilters ? {
            icon: Search,
            title: 'No pipelines match your filters',
            description: 'Try adjusting your search or filter criteria.',
            action: <Button variant="secondary" onClick={list.clearFilters}>Clear filters</Button>,
          } : {
            icon: GitBranch,
            title: 'No pipelines yet',
            description: 'Get started by creating your first pipeline, or fork one from the system catalog.',
            action: canWrite ? <Button onClick={() => setShowCreateModal(true)}>Create Pipeline</Button> : undefined,
          }}
        >
          <DataTable
            data={filteredPipelines}
            columns={pipelineColumns}
            isLoading={list.isLoading}
            emptyState={{
              icon: GitBranch,
              title: 'No pipelines yet',
              description: 'Get started by creating your first pipeline, or fork one from the system catalog.',
              action: canWrite ? <Button onClick={() => setShowCreateModal(true)}>Create Pipeline</Button> : undefined,
            }}
            getRowKey={(p) => p.id}
            defaultSortColumn="name"
            showColumnToggle
          />
        </ResourceList>
      </div>

      <CreatePipelineModal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onSubmit={handleCreatePipeline}
        createLoading={createForm.loading}
        createError={createForm.error}
        createSuccess={createSuccess}
        canCreatePublic={isSuperAdmin}
      />

      {del.target && (
        <DeleteConfirmModal title="Delete Pipeline" itemName={del.target.pipelineName || 'Unnamed Pipeline'} loading={del.loading} onConfirm={del.confirm} onCancel={del.close} />
      )}

      {editPipeline && (
        <EditPipelineModal pipeline={editPipeline} isSuperAdmin={isSuperAdmin} onClose={() => setEditPipeline(null)} onSaved={list.refresh} />
      )}

      {/* Sticky bottom bulk actions bar */}
      {canWrite && selectedIds.size > 0 && (
        <div className="fixed bottom-0 left-0 right-0 z-40 bg-white dark:bg-gray-900 border-t border-gray-200 dark:border-gray-700 shadow-lg">
          <div className="max-w-7xl mx-auto flex items-center justify-between px-6 py-3">
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
              {selectedIds.size} selected
            </span>
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="xs" onClick={() => handleBulkActivate(true)} disabled={bulkLoading}>
                Activate
              </Button>
              <Button variant="secondary" size="xs" onClick={() => handleBulkActivate(false)} disabled={bulkLoading}>
                Deactivate
              </Button>
              <Button variant="danger" size="xs" onClick={handleBulkDelete} disabled={bulkLoading}>
                <Trash2 className="w-3.5 h-3.5" />
                Delete
              </Button>
              <IconButton onClick={clearSelection} title="Clear selection" aria-label="Clear selection">
                <X className="w-4 h-4" />
              </IconButton>
            </div>
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}
