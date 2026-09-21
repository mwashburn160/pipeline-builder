import { useState, useMemo, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { useOpenOnCreateQuery } from '@/hooks/useOpenOnCreateQuery';
import { useToast } from '@/components/ui/Toast';
import { formatError } from '@/lib/constants';
import { Plus, GitBranch, Search, Upload } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { useFeatureGate } from '@/hooks/useFeatureGate';
import { FeatureLockedAction } from '@/components/ui/FeatureLock';
import { useListPage } from '@/hooks/useListPage';
import { useDelete } from '@/hooks/useDelete';
import { useFormState } from '@/hooks/useFormState';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { RoleBanner } from '@/components/ui/RoleBanner';
import { TabBar } from '@/components/ui/TabBar';
import { Button } from '@/components/ui/Button';
import { DeleteConfirmModal } from '@/components/ui/DeleteConfirmModal';
import { FilterInput } from '@/components/ui/FilterInput';
import { FilterSelect } from '@/components/ui/FilterSelect';
import { DataTable } from '@/components/ui/DataTable';
import { ResourceList } from '@/components/ui/ResourceList';
import { FilterBar } from '@/components/ui/FilterBar';
import { DeployedPipelinesPanel } from '@/components/pipeline/DeployedPipelinesPanel';
import { usePipelineColumns, PIPELINE_SORT_FIELD } from '@/components/pipeline/usePipelineColumns';
import { BulkActionBar, BulkActionBarSpacer, useRowSelection } from '@/components/dashboard/BulkActionBar';
import api from '@/lib/api';
// Every refresh below follows a write, so the shared pipeline cache the command
// palette / dashboard home / deployment-drift view read from must be dropped too.
import { invalidate } from '@/lib/api-cache';
import { PIPELINE_LIST_FIELDS, type PipelineSummary } from '@/lib/api/domains/pipelines';
import { mapCommonParams, canWritePipeline } from '@/lib/resource-helpers';
import { buildListSummary } from '@/lib/list-summary';
import type { BuilderProps, Visibility } from '@/types';

// Modals and the recently-deleted panel load on first use — none of them is
// part of the list's first paint, and the create/edit wizards are large.
const CreatePipelineModal = dynamic(() => import('@/components/pipeline/CreatePipelineModal'), { ssr: false });
const EditPipelineModal = dynamic(() => import('@/components/pipeline/EditPipelineModal'), { ssr: false });
const BulkImportPipelinesModal = dynamic(() => import('@/components/pipeline/BulkImportPipelinesModal'), { ssr: false });
const RecentlyDeletedPanel = dynamic(() => import('@/components/RecentlyDeletedPanel').then((m) => m.RecentlyDeletedPanel), { ssr: false });

/** `fields` for the list request — every rendered column, never `props`. */
const LIST_FIELDS = PIPELINE_LIST_FIELDS.join(',');

// ─── Page ───────────────────────────────────────────────

/** Pipeline management page. Lists, creates, edits, and deletes CI/CD pipelines with filtering and sorting. */
export default function PipelinesPage() {
  const { accessDenied, user, isReady, isAuthenticated, isSuperAdmin, isOrgAdminUser, isAdmin, can } = useAuthGuard();
  const toast = useToast();
  const canViewPublic = isSuperAdmin;
  // Fine-grained RBAC: write controls (create/edit/delete/bulk/select) unlock
  // on `pipelines:write`, not org-admin role, so a custom-group member granted
  // the capability gets them too. Role-admins hold it in their bundle.
  const canWrite = can('pipelines:write');
  // Batch create/update/delete is a tier-gated feature: the backend attaches
  // `requireFeature('bulk_operations')` to the bulk routes, so without the flag
  // every bulk action 403s. Gate the select checkboxes + bulk toolbar on it so
  // we don't surface controls that are guaranteed to fail. (`can`-gated too, so
  // read-only members never see them.) The Bulk-import ENTRY point stays visible
  // as a FeatureLockedAction — a row checkbox can't carry a reason, a button can.
  const bulkGate = useFeatureGate('bulk_operations');
  const canBulk = canWrite && bulkGate.entitled;

  // ── Data ──

  // Offset-paged (page numbers, page size and a URL-synced offset), so the
  // keyset `cursor` the endpoint also offers doesn't fit here; `fields` does —
  // the list never renders `props`, the heaviest column by far.
  const list = useListPage<PipelineSummary>({
    fields: [
      { key: 'name', type: 'text', defaultValue: '', primary: true },
      { key: 'id', type: 'text', defaultValue: '' },
      { key: 'orgId', type: 'text', defaultValue: '' },
      { key: 'project', type: 'text', defaultValue: '' },
      { key: 'visibility', type: 'select', defaultValue: 'all' },
      { key: 'status', type: 'select', defaultValue: 'all' },
      { key: 'default', type: 'select', defaultValue: 'all' },
    ],
    // Server-side default sort mirrors the previous client-side default
    // (name ascending) so the initial view is unchanged.
    initialSort: { sortBy: 'pipelineName', sortOrder: 'asc' },
    fetcher: async (params, signal) => {
      const p: Record<string, string> = {
        ...mapCommonParams(params),
        limit: params.limit,
        offset: params.offset,
        includeTotal: 'true',
        fields: LIST_FIELDS,
      };
      if (params.name) p.pipelineName = params.name;
      if (params.id) p.id = params.id;
      if (params.orgId) p.orgId = params.orgId;
      if (params.project) p.project = params.project;
      if (params.sortBy) p.sortBy = params.sortBy;
      if (params.sortOrder) p.sortOrder = params.sortOrder;
      const response = await api.listPipelines(p, { signal });
      return { items: response.data?.pipelines || [], pagination: response.data?.pagination };
    },
    enabled: isAuthenticated,
    urlSync: true,
  });

  // Any write here invalidates the shared pipeline cache AND re-reads this page.
  const { refresh: refreshList } = list;
  const afterWrite = useCallback(() => { invalidate.pipelines(); refreshList(); }, [refreshList]);

  const del = useDelete<PipelineSummary>(
    (p) => api.deletePipeline(p.id),
    () => { afterWrite(); toast.success('Pipeline deleted'); },
    (err) => list.setError(formatError(err, 'Failed to delete pipeline')),
  );

  // Backend already returns the right scope (own org + system-public catalog)
  // for non-admins. No client-side filter — see resource-helpers.mapCommonParams.
  const filteredPipelines = list.data;

  // Always-on result feedback + current-page exception surfacing. The list is
  // server-paginated, so inactive/private counts are scoped to THIS page (hence
  // the "on this page" qualifier) — surfacing anomalies without claiming totals.
  const listSummary = useMemo(
    () => buildListSummary(filteredPipelines, list.pagination.total, {
      noun: 'pipeline',
      isLoading: list.isLoading,
      flags: [
        { label: 'inactive', pred: (p) => !p.isActive },
        { label: 'private', pred: (p) => p.visibility !== 'public' },
      ],
    }),
    [filteredPipelines, list.isLoading, list.pagination.total],
  );

  // ── Create ──

  const [showCreateModal, setShowCreateModal] = useState(false);
  // Active vs. Recently-deleted view (tabs). Restore is write-gated, so the tab
  // only renders for writers.
  const [deletedView, setDeletedView] = useState<'active' | 'deleted'>('active');
  const createForm = useFormState();
  const [createSuccess, setCreateSuccess] = useState<string | null>(null);
  const [editPipeline, setEditPipeline] = useState<PipelineSummary | null>(null);
  const [showBulkCreate, setShowBulkCreate] = useState(false);

  // Open the create modal when arrived via the sidebar "Create pipeline"
  // shortcut (`?create=1`).
  useOpenOnCreateQuery(() => { if (canWrite) setShowCreateModal(true); }, isReady && !!user);

  const openCreate = () => { setShowCreateModal(true); createForm.reset(); setCreateSuccess(null); };

  const handleCreatePipeline = async (props: BuilderProps, visibility: Visibility, description?: string, keywords?: string[]) => {
    setCreateSuccess(null);
    const result = await createForm.run(() =>
      api.createPipeline({
        project: props.project,
        organization: props.organization,
        pipelineName: props.pipelineName,
        description,
        keywords,
        props,
        visibility,
      }),
    );
    if (result?.success) {
      setCreateSuccess('Pipeline created successfully!');
      afterWrite();
      toast.success('Pipeline created');
      setTimeout(() => { setShowCreateModal(false); setCreateSuccess(null); }, 2000);
    }
  };

  // ── Bulk Operations ──

  const selection = useRowSelection();
  const { selectedIds, clear: clearSelection } = selection;
  const [bulkLoading, setBulkLoading] = useState(false);
  // Gate bulk delete behind a confirmation modal (mirrors single-row delete's
  // DeleteConfirmModal), since the bulk action is destructive and irreversible.
  const [showBulkDelete, setShowBulkDelete] = useState(false);

  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return;
    setBulkLoading(true);
    try {
      const count = selectedIds.size;
      await api.bulkDeletePipelines(Array.from(selectedIds));
      clearSelection();
      setShowBulkDelete(false);
      afterWrite();
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
      afterWrite();
      toast.success(`${count} pipeline${count > 1 ? 's' : ''} ${isActive ? 'activated' : 'deactivated'}`);
    } catch (err) {
      list.setError(formatError(err, `Failed to ${isActive ? 'activate' : 'deactivate'} pipelines`));
    } finally {
      setBulkLoading(false);
    }
  };

  // ── Filters ──

  const [showAdvanced, setShowAdvanced] = useState(false);

  // Server-side sort: translate a column click into sortBy/sortOrder query
  // params the backend honors, instead of an in-memory reorder of one page.
  const { setSort } = list;
  const handleServerSort = useCallback((columnId: string, direction: 'asc' | 'desc') => {
    setSort(PIPELINE_SORT_FIELD[columnId] ?? columnId, direction);
  }, [setSort]);

  // ── Columns ──

  const canWriteRow = useCallback(
    (pipeline: PipelineSummary) => canWritePipeline(can, isSuperAdmin, pipeline, user?.id),
    [can, isSuperAdmin, user?.id],
  );
  const openDelete = del.open;
  const pipelineColumns = usePipelineColumns({
    selectable: canBulk,
    selectedIds,
    onToggleSelect: selection.toggle,
    canWriteRow,
    onEdit: setEditPipeline,
    onDelete: openDelete,
  });

  // ── Render ──

  if (accessDenied) return <AccessDenied denial={accessDenied} />;
  if (!isReady || !user) return <LoadingPage />;

  return (
    <DashboardLayout
      title="Pipelines"
      subtitle="Create, edit, and monitor pipeline configurations"
      actions={
        canWrite ? (
          <div className="flex items-center gap-2">
            {/* Bulk import needs the `bulk_operations` feature — the backend
                bulk route 403s without it. Show the entry either way: enabled
                when entitled, otherwise muted + lock-marked with the reason, so
                the capability is discoverable instead of silently absent. */}
            {canBulk ? (
              <Button variant="secondary" onClick={() => setShowBulkCreate(true)}>
                <Upload className="w-4 h-4 mr-2" />
                Bulk import
              </Button>
            ) : (
              <FeatureLockedAction flag="bulk_operations" label="Bulk import" icon={Upload} />
            )}
            <Button onClick={openCreate}>
              <Plus className="w-4 h-4 mr-2" />
              Create Pipeline
            </Button>
          </div>
        ) : undefined
      }
    >
      <div className="page-section">
        <RoleBanner isSuperAdmin={isSuperAdmin} isOrgAdmin={isOrgAdminUser} isAdmin={isAdmin} resourceName="pipelines" orgName={user.organizationName} size="sm" />

        {/* Active / Recently-deleted tabs (restore is write-gated). */}
        {canWrite && (
          <TabBar
            className="mb-4"
            items={[{ id: 'active', label: 'Active' }, { id: 'deleted', label: 'Recently deleted' }]}
            activeId={deletedView}
            onSelect={(id) => setDeletedView(id as 'active' | 'deleted')}
          />
        )}

        {canWrite && deletedView === 'deleted' ? (
          <RecentlyDeletedPanel resource="pipeline" onRestored={afterWrite} canRestoreRow={(r) => canWritePipeline(can, isSuperAdmin, { visibility: r.visibility, createdBy: r.createdBy }, user?.id)} />
        ) : (
        <>
        <DeployedPipelinesPanel canWrite={canWrite} />

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
          summary={listSummary}
          advancedContent={
            <>
              <FilterInput type="text" aria-label="Filter by project" value={list.filters.project} onChange={(e) => list.updateFilter('project', e.target.value)} placeholder="Project..." className="max-w-[160px]" />
              <FilterSelect aria-label="Filter by status" value={list.filters.status} onChange={(e) => list.updateFilter('status', e.target.value)}>
                <option value="all">All status</option>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </FilterSelect>
              <FilterSelect aria-label="Filter by default" value={list.filters.default} onChange={(e) => list.updateFilter('default', e.target.value)}>
                <option value="all">All pipelines</option>
                <option value="default">Default only</option>
              </FilterSelect>
              {canViewPublic && (
                <FilterSelect aria-label="Filter by visibility" value={list.filters.visibility} onChange={(e) => list.updateFilter('visibility', e.target.value)}>
                  <option value="all">All visibility</option>
                  <option value="public">Public</option>
                  {/* The ladder has THREE rungs — omitting `org` made every
                      org-shared row invisible under both other filter values. */}
                  <option value="org">Org</option>
                  <option value="private">Private</option>
                </FilterSelect>
              )}
            </>
          }
        />

        {/* Spacer when sticky bulk bar is visible */}
        {canBulk && <BulkActionBarSpacer count={selectedIds.size} />}

        {/* ResourceList owns: error+retry, refresh button, empty state, and
            offset Pagination. Body is custom so we preserve DataTable's
            defaultSortColumn + showColumnToggle features (which ResourceList's
            table-mode slot doesn't forward). We swap emptyState manually when
            filters are active because ResourceList's built-in
            `filteredEmptyState` keys off the filter input it renders itself,
            and our filter input lives in FilterBar above. */}
        <ResourceList<PipelineSummary>
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
            action: canWrite ? <Button onClick={() => setShowCreateModal(true)}>Create pipeline</Button> : undefined,
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
              action: canWrite ? <Button onClick={() => setShowCreateModal(true)}>Create pipeline</Button> : undefined,
            }}
            getRowKey={(p) => p.id}
            defaultSortColumn="name"
            showColumnToggle
            serverSort
            onSortChange={handleServerSort}
          />
        </ResourceList>

        </>
        )}
      </div>

      {showCreateModal && (
      <CreatePipelineModal
        isOpen
        onClose={() => setShowCreateModal(false)}
        onSubmit={handleCreatePipeline}
        createLoading={createForm.loading}
        createError={createForm.error}
        createSuccess={createSuccess}
        canPublish={can('pipelines:publish')}
      />
      )}

      {showBulkCreate && (
        <BulkImportPipelinesModal onClose={() => setShowBulkCreate(false)} onImported={refreshList} />
      )}

      {del.target && (
        <DeleteConfirmModal title="Delete pipeline" itemName={del.target.pipelineName || 'Unnamed Pipeline'} loading={del.loading} onConfirm={del.confirm} onCancel={del.close} />
      )}

      {showBulkDelete && (
        <DeleteConfirmModal
          title="Delete pipelines"
          itemName={`${selectedIds.size} pipeline${selectedIds.size > 1 ? 's' : ''}`}
          loading={bulkLoading}
          onConfirm={handleBulkDelete}
          onCancel={() => setShowBulkDelete(false)}
        />
      )}

      {editPipeline && (
        <EditPipelineModal pipeline={editPipeline} canPublish={can('pipelines:publish')} onClose={() => setEditPipeline(null)} onSaved={refreshList} />
      )}

      {/* Sticky bottom bulk actions bar */}
      {canBulk && (
        <BulkActionBar
          count={selectedIds.size}
          busy={bulkLoading}
          onActivate={(isActive) => void handleBulkActivate(isActive)}
          onDelete={() => setShowBulkDelete(true)}
          onClear={clearSelection}
        />
      )}
    </DashboardLayout>
  );
}
