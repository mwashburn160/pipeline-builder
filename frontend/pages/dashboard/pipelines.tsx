import { useState, useMemo, useCallback } from 'react';
import Link from 'next/link';
import { useOpenOnCreateQuery } from '@/hooks/useOpenOnCreateQuery';
import { useToast } from '@/components/ui/Toast';
import { formatError } from '@/lib/constants';
import { Plus, GitBranch, Search, Trash2, X, Upload, Lock } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useFeatures } from '@/hooks/useFeatures';
import { useListPage } from '@/hooks/useListPage';
import { useDelete } from '@/hooks/useDelete';
import { useFormState } from '@/hooks/useFormState';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { RoleBanner } from '@/components/ui/RoleBanner';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { Textarea } from '@/components/ui/Textarea';
import { IconButton } from '@/components/ui/IconButton';
import { DeleteConfirmModal } from '@/components/ui/DeleteConfirmModal';
import { FilterInput } from '@/components/ui/FilterInput';
import { FilterSelect } from '@/components/ui/FilterSelect';
import { Modal } from '@/components/ui/Modal';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { ResourceList } from '@/components/ui/ResourceList';
import { FilterBar } from '@/components/ui/FilterBar';
import { RelativeTime } from '@/components/ui/RelativeTime';
import EditPipelineModal from '@/components/pipeline/EditPipelineModal';
import CreatePipelineModal from '@/components/pipeline/CreatePipelineModal';
import { DeployedPipelinesPanel } from '@/components/pipeline/DeployedPipelinesPanel';
import { RecentlyDeletedPanel } from '@/components/RecentlyDeletedPanel';
import api from '@/lib/api';
import type { BulkPipelineSpec, BulkCreateResult } from '@/lib/api/domains/pipelines';
import { mapCommonParams, canWritePipeline } from '@/lib/resource-helpers';
import type { Pipeline, BuilderProps } from '@/types';

// Maps a DataTable column id to the server-side sort field the pipelines list
// endpoint honors (via parsePaginationParams → sortBy). Columns absent here
// fall back to their own id.
const PIPELINE_SORT_FIELD: Record<string, string> = {
  name: 'pipelineName',
  pipelineId: 'id',
  project: 'project',
  organization: 'organization',
  access: 'accessModifier',
  status: 'isActive',
  default: 'isDefault',
  createdBy: 'createdBy',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt',
};

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
  // Batch create/update/delete is a tier-gated feature: the backend attaches
  // `requireFeature('bulk_operations')` to the bulk routes, so without the flag
  // every bulk action 403s. Gate the select checkboxes + bulk toolbar on it so
  // we don't surface controls that are guaranteed to fail. (`can`-gated too, so
  // read-only members never see them.)
  const { isEnabled } = useFeatures();
  const canBulk = canWrite && isEnabled('bulk_operations');

  // ── Data ──

  const list = useListPage<Pipeline>({
    fields: [
      { key: 'name', type: 'text', defaultValue: '', primary: true },
      { key: 'id', type: 'text', defaultValue: '' },
      { key: 'orgId', type: 'text', defaultValue: '' },
      { key: 'project', type: 'text', defaultValue: '' },
      { key: 'organization', type: 'text', defaultValue: '' },
      { key: 'keyword', type: 'text', defaultValue: '' },
      { key: 'access', type: 'select', defaultValue: 'all' },
      { key: 'status', type: 'select', defaultValue: 'all' },
      { key: 'default', type: 'select', defaultValue: 'all' },
    ],
    // Server-side default sort mirrors the previous client-side default
    // (name ascending) so the initial view is unchanged.
    initialSort: { sortBy: 'pipelineName', sortOrder: 'asc' },
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
      if (params.keyword) p.keyword = params.keyword;
      if (params.sortBy) p.sortBy = params.sortBy;
      if (params.sortOrder) p.sortOrder = params.sortOrder;
      const response = await api.listPipelines(p);
      return { items: response.data?.pipelines || [], pagination: response.data?.pagination };
    },
    enabled: isAuthenticated,
    urlSync: true,
  });

  const del = useDelete<Pipeline>(
    (p) => api.deletePipeline(p.id),
    () => { list.refresh(); toast.success('Pipeline deleted'); },
    (err) => list.setError(formatError(err, 'Failed to delete pipeline')),
  );

  // Backend already returns the right scope (own org + system-public catalog)
  // for non-admins. No client-side filter — see resource-helpers.mapCommonParams.
  const filteredPipelines = list.data;

  // Always-on result feedback + current-page exception surfacing. The list is
  // server-paginated, so inactive/private counts are scoped to THIS page (hence
  // the "on this page" qualifier) — surfacing anomalies without claiming totals.
  const listSummary = useMemo(() => {
    if (list.isLoading) return undefined;
    const shown = filteredPipelines.length;
    const total = list.pagination.total;
    const base = `Showing ${shown} of ${total} pipeline${total === 1 ? '' : 's'}`;
    const inactive = filteredPipelines.filter((p) => !p.isActive).length;
    const priv = filteredPipelines.filter((p) => p.accessModifier !== 'public').length;
    const flags = [
      inactive ? `${inactive} inactive` : null,
      priv ? `${priv} private` : null,
    ].filter(Boolean);
    return flags.length ? `${base} · ${flags.join(' · ')} on this page` : base;
  }, [filteredPipelines, list.isLoading, list.pagination.total]);

  // ── Create ──

  const [showCreateModal, setShowCreateModal] = useState(false);
  const createForm = useFormState();
  const [createSuccess, setCreateSuccess] = useState<string | null>(null);
  const [editPipeline, setEditPipeline] = useState<Pipeline | null>(null);

  // Open the create modal when arrived via the sidebar "Create Pipeline"
  // shortcut (`?create=1`).
  useOpenOnCreateQuery(() => { if (canWrite) setShowCreateModal(true); });

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
  // Gate bulk delete behind a confirmation modal (mirrors single-row delete's
  // DeleteConfirmModal), since the bulk action is destructive and irreversible.
  const [showBulkDelete, setShowBulkDelete] = useState(false);

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
      setShowBulkDelete(false);
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

  // ── Bulk Create (import) ──

  const [showBulkCreate, setShowBulkCreate] = useState(false);
  const [bulkText, setBulkText] = useState('');
  const [bulkCreating, setBulkCreating] = useState(false);
  const [bulkCreateError, setBulkCreateError] = useState<string | null>(null);
  const [bulkCreateResult, setBulkCreateResult] = useState<BulkCreateResult | null>(null);

  const openBulkCreate = () => {
    setBulkText('');
    setBulkCreateError(null);
    setBulkCreateResult(null);
    setShowBulkCreate(true);
  };

  const handleBulkCreate = async () => {
    setBulkCreateError(null);
    setBulkCreateResult(null);

    let specs: BulkPipelineSpec[];
    try {
      const parsed = JSON.parse(bulkText);
      // Accept either a bare array or a { pipelines: [...] } envelope so users
      // can paste whichever shape they exported.
      const arr = Array.isArray(parsed) ? parsed : (parsed?.pipelines ?? null);
      if (!Array.isArray(arr) || arr.length === 0) {
        setBulkCreateError('Provide a non-empty JSON array of pipeline specs (or a { "pipelines": [...] } object).');
        return;
      }
      specs = arr as BulkPipelineSpec[];
    } catch {
      setBulkCreateError('Invalid JSON. Paste a valid JSON array of pipeline specs.');
      return;
    }

    setBulkCreating(true);
    try {
      const res = await api.bulkCreatePipelines(specs);
      if (res.success && res.data) {
        setBulkCreateResult(res.data);
        list.refresh();
        const { created, updated, failed } = res.data;
        if (failed === 0) {
          toast.success(`${created} created${updated > 0 ? `, ${updated} updated` : ''}`);
        } else {
          toast.error(`${created} created, ${failed} failed`);
        }
      } else {
        setBulkCreateError(formatError(res, 'Bulk create failed'));
      }
    } catch (err) {
      setBulkCreateError(formatError(err, 'Bulk create failed'));
    } finally {
      setBulkCreating(false);
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

  const pipelineColumns: Column<Pipeline>[] = useMemo(() => [
    ...(canBulk ? [{
      id: 'select',
      header: '',
      locked: true,
      render: (pipeline: Pipeline) => (
        canWritePipeline(can, isSuperAdmin, pipeline.accessModifier) ? (
          <Checkbox
            checked={selectedIds.has(pipeline.id)}
            onChange={(e) => {
              e.stopPropagation();
              toggleSelect(pipeline.id);
            }}
          />
        ) : null
      ),
    } as Column<Pipeline>] : []),
    {
      id: 'name',
      header: 'Name',
      sortValue: (p) => p.pipelineName || '',
      render: (p) => (
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {/* Name links to the pipeline detail; project folds in as a mono chip
                so the standalone Project column can stay hidden (see below). */}
            <Link
              href={`/dashboard/pipelines/${encodeURIComponent(p.id)}`}
              className="text-sm font-medium text-gray-900 dark:text-gray-100 hover:text-blue-600 dark:hover:text-blue-400 hover:underline truncate"
            >
              {p.pipelineName}
            </Link>
            {p.project && (
              <span className="shrink-0 text-[11px] font-mono text-gray-400 dark:text-gray-500 border border-gray-200 dark:border-gray-700 rounded px-1 py-0.5">{p.project}</span>
            )}
          </div>
          {p.description && <div className="text-xs text-gray-500 dark:text-gray-400 truncate max-w-md mt-0.5">{p.description}</div>}
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
      // Hidden by default: the project now shows as a chip in the Name cell, so
      // a standalone column is redundant. Re-enable via the column toggle.
      hidden: true,
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
      // Public is the common case → muted; private is the exception → make it
      // legible with a lock so the eye catches what actually differs.
      render: (p) => (
        p.accessModifier === 'public'
          ? <span className="text-xs text-gray-400 dark:text-gray-500">Public</span>
          : <span className="inline-flex items-center gap-1 text-xs font-medium text-gray-700 dark:text-gray-300"><Lock className="h-3 w-3" />Private</span>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      sortValue: (p) => p.isActive,
      // Active (common) → subtle dot; Inactive (exception) → loud red badge.
      render: (p) => (
        p.isActive
          ? <span className="inline-flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400"><span className="h-1.5 w-1.5 rounded-full bg-green-500" />Active</span>
          : <Badge color="red">Inactive</Badge>
      ),
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
        canWritePipeline(can, isSuperAdmin, pipeline.accessModifier) ? (
          <div className="flex items-center gap-1">
            <button onClick={() => setEditPipeline(pipeline)} className="action-link">Edit</button>
            {/* Delete as a muted icon (red only on hover, guarded by a confirm
                modal) so it doesn't sit as loud red text a click from Edit. */}
            <IconButton tone="danger" title="Delete pipeline" aria-label="Delete pipeline" onClick={() => del.open(pipeline)}>
              <Trash2 className="h-4 w-4" />
            </IconButton>
          </div>
        ) : (
          <span className="text-gray-400 dark:text-gray-500 text-xs">Read-only</span>
        )
      ),
    },
  ], [isSuperAdmin, canWrite, canBulk, can, selectedIds, toggleSelect]);

  // ── Render ──

  if (!isReady || !user) return <LoadingPage />;

  return (
    <DashboardLayout
      title="Pipelines"
      subtitle="Create, edit, and monitor pipeline configurations"
      actions={
        canWrite ? (
          <div className="flex items-center gap-2">
            {/* Bulk import needs the `bulk_operations` feature — the backend
                bulk route 403s without it, so hide the entry when disabled. */}
            {canBulk && (
              <Button variant="secondary" onClick={openBulkCreate}>
                <Upload className="w-4 h-4 mr-2" />
                Bulk import
              </Button>
            )}
            <Button onClick={() => { setShowCreateModal(true); createForm.reset(); setCreateSuccess(null); }}>
              <Plus className="w-4 h-4 mr-2" />
              Create Pipeline
            </Button>
          </div>
        ) : undefined
      }
    >
      <div className="page-section">
        <RoleBanner isSuperAdmin={isSuperAdmin} isOrgAdmin={isOrgAdminUser} isAdmin={isAdmin} resourceName="pipelines" orgName={user.organizationName} size="sm" />

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
              <FilterInput type="text" aria-label="Filter by organization" value={list.filters.organization} onChange={(e) => list.updateFilter('organization', e.target.value)} placeholder="Organization..." className="max-w-[160px]" />
              <FilterInput type="text" aria-label="Filter by keyword" value={list.filters.keyword} onChange={(e) => list.updateFilter('keyword', e.target.value)} placeholder="Keyword..." className="max-w-[160px]" />
              <FilterSelect aria-label="Filter by status" value={list.filters.status} onChange={(e) => list.updateFilter('status', e.target.value)}>
                <option value="all">All Status</option>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </FilterSelect>
              <FilterSelect aria-label="Filter by default" value={list.filters.default} onChange={(e) => list.updateFilter('default', e.target.value)}>
                <option value="all">All Pipelines</option>
                <option value="default">Default only</option>
              </FilterSelect>
              {canViewPublic && (
                <FilterSelect aria-label="Filter by access" value={list.filters.access} onChange={(e) => list.updateFilter('access', e.target.value)}>
                  <option value="all">All Access</option>
                  <option value="public">Public</option>
                  <option value="private">Private</option>
                </FilterSelect>
              )}
            </>
          }
        />

        {/* Spacer when sticky bulk bar is visible */}
        {canBulk && selectedIds.size > 0 && <div className="h-16" />}

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
            serverSort
            onSortChange={handleServerSort}
          />
        </ResourceList>

        {/* Recently deleted — restore soft-deleted pipelines within the
            retention window. Only for users who can write (restore is
            pipelines:write + step-up gated). */}
        {canWrite && (
          <div className="mt-6">
            <RecentlyDeletedPanel resource="pipeline" onRestored={list.refresh} canRestoreRow={(r) => canWritePipeline(can, isSuperAdmin, r.accessModifier ?? 'private')} />
          </div>
        )}
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

      {showBulkCreate && (
        <Modal
          title="Bulk import pipelines"
          onClose={() => bulkCreating ? undefined : setShowBulkCreate(false)}
          maxWidth="max-w-2xl"
          footer={
            <div className="flex items-center justify-end gap-2">
              <Button variant="secondary" onClick={() => setShowBulkCreate(false)} disabled={bulkCreating}>
                Close
              </Button>
              <Button onClick={handleBulkCreate} disabled={bulkCreating || !bulkText.trim()}>
                {bulkCreating ? 'Importing…' : 'Import'}
              </Button>
            </div>
          }
        >
          <div className="space-y-3 text-sm">
            <p className="text-gray-600 dark:text-gray-400">
              Paste a JSON array of pipeline specs (each with <code className="font-mono">project</code>, <code className="font-mono">organization</code>, and <code className="font-mono">props</code>; optional <code className="font-mono">pipelineName</code>, <code className="font-mono">description</code>, <code className="font-mono">keywords</code>, <code className="font-mono">accessModifier</code>). A <code className="font-mono">{'{ "pipelines": [...] }'}</code> wrapper is also accepted.
            </p>
            <Textarea
              value={bulkText}
              onChange={(e) => { setBulkText(e.target.value); setBulkCreateError(null); }}
              placeholder={'[\n  { "project": "web", "organization": "acme", "props": { /* BuilderProps */ } }\n]'}
              rows={12}
              className="font-mono text-xs w-full"
              disabled={bulkCreating}
              spellCheck={false}
            />
            {bulkCreateError && (
              <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-3">
                <p className="text-red-800 dark:text-red-300">{bulkCreateError}</p>
              </div>
            )}
            {bulkCreateResult && (
              <div className="rounded-lg bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 p-3 space-y-2">
                <div className="flex flex-wrap gap-2">
                  <Badge color="green">{bulkCreateResult.created} created</Badge>
                  {bulkCreateResult.updated > 0 && <Badge color="blue">{bulkCreateResult.updated} updated</Badge>}
                  {bulkCreateResult.failed > 0 && <Badge color="red">{bulkCreateResult.failed} failed</Badge>}
                </div>
                {bulkCreateResult.errors.length > 0 && (
                  <ul className="text-xs text-red-700 dark:text-red-300 space-y-1 max-h-40 overflow-y-auto">
                    {bulkCreateResult.errors.map((e) => (
                      <li key={e.index}>
                        <span className="font-mono">#{e.index}</span>: {e.error}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </Modal>
      )}

      {del.target && (
        <DeleteConfirmModal title="Delete Pipeline" itemName={del.target.pipelineName || 'Unnamed Pipeline'} loading={del.loading} onConfirm={del.confirm} onCancel={del.close} />
      )}

      {showBulkDelete && (
        <DeleteConfirmModal
          title="Delete Pipelines"
          itemName={`${selectedIds.size} pipeline${selectedIds.size > 1 ? 's' : ''}`}
          loading={bulkLoading}
          onConfirm={handleBulkDelete}
          onCancel={() => setShowBulkDelete(false)}
        />
      )}

      {editPipeline && (
        <EditPipelineModal pipeline={editPipeline} isSuperAdmin={isSuperAdmin} onClose={() => setEditPipeline(null)} onSaved={list.refresh} />
      )}

      {/* Sticky bottom bulk actions bar */}
      {canBulk && selectedIds.size > 0 && (
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
              <Button variant="danger" size="xs" onClick={() => setShowBulkDelete(true)} disabled={bulkLoading}>
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
