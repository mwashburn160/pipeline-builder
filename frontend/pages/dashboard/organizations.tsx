import { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import { formatError } from '@/lib/constants';
import { triggerBlobDownload } from '@/lib/csv-export';
import { Building2, KeyRound, FileDown, ShieldCheck, ExternalLink, Plus, Layers, RotateCcw, MoreHorizontal, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useListPage } from '@/hooks/useListPage';
import { useFormState } from '@/hooks/useFormState';
import { LoadingPage } from '@/components/ui/Loading';
import { SearchInput } from '@/components/ui/SearchInput';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { SegmentedFilter } from '@/components/ui/SegmentedFilter';
import { Badge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Checkbox } from '@/components/ui/Checkbox';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { InfoAlert } from '@/components/ui/InfoAlert';
import { FilterSelect } from '@/components/ui/FilterSelect';
import { ModalFooter } from '@/components/ui/ModalFooter';
import { useToast } from '@/components/ui/Toast';
import { DeleteConfirmModal } from '@/components/ui/DeleteConfirmModal';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { TabBar } from '@/components/ui/TabBar';
import { Pagination } from '@/components/ui/Pagination';
import { RecentlyDeletedPanel } from '@/components/RecentlyDeletedPanel';
import { useDelete } from '@/hooks/useDelete';
import { OrgKmsConfigModal } from '@/components/admin/OrgKmsConfigModal';
import { OrgIdpConfigModal } from '@/components/admin/OrgIdpConfigModal';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { RelativeTime } from '@/components/ui/RelativeTime';
import api from '@/lib/api';
import { Organization } from '@/types';
import type { OrganizationListItem } from '@/lib/api/domains/organizations';

/**
 * Trash / "Deleted items" resources exposed in the admin restore view. Keys are
 * the exact `resource` keys the shared `RecentlyDeletedPanel` registry supports
 * (each has a backend list-deleted + restore route); labels are display-only.
 * `as const` keeps the union assignable to the panel's internal `Resource` type.
 */
const TRASH_RESOURCES = [
  { key: 'pipeline', label: 'Pipelines' },
  { key: 'plugin', label: 'Plugins' },
  { key: 'template', label: 'Templates' },
  { key: 'message', label: 'Messages' },
  { key: 'compliance-rule', label: 'Compliance rules' },
  { key: 'compliance-policy', label: 'Compliance policies' },
] as const;
type TrashResource = (typeof TRASH_RESOURCES)[number]['key'];

/**
 * Per-row overflow menu for the less-common admin actions (KMS, IdP, tier,
 * namespace) with Delete separated below as the destructive action. Rendered
 * with fixed positioning off the trigger's rect so the menu isn't clipped by
 * the table's `overflow-x-auto` scroll container.
 */
function RowActionsMenu({
  canKms, canIdp, onKms, onIdp, onTier, onNamespace, onDelete,
}: {
  canKms: boolean;
  canIdp: boolean;
  onKms: () => void;
  onIdp: () => void;
  onTier: () => void;
  onNamespace: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; right: number }>({ top: 0, right: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node) || btnRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    // The menu is fixed-positioned off a rect snapshot; any scroll/resize would
    // desync it, so just close on those rather than re-measuring.
    const onMove = () => setOpen(false);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [open]);

  const toggle = () => {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setCoords({ top: r.bottom + 4, right: window.innerWidth - r.right });
    }
    setOpen((o) => !o);
  };

  const run = (fn: () => void) => () => { setOpen(false); fn(); };

  const itemClass = 'w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700/60 transition-colors';

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More actions"
        className="inline-flex items-center justify-center w-8 h-8 rounded-md text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
      >
        <MoreHorizontal className="w-4 h-4" />
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          style={{ position: 'fixed', top: coords.top, right: coords.right, zIndex: 50 }}
          className="w-56 py-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl shadow-xl text-left"
        >
          {canKms && (
            <button type="button" role="menuitem" onClick={run(onKms)} className={itemClass}>
              <KeyRound className="w-3.5 h-3.5 text-gray-400" /> KMS config
            </button>
          )}
          {canIdp && (
            <button type="button" role="menuitem" onClick={run(onIdp)} className={itemClass}>
              <ShieldCheck className="w-3.5 h-3.5 text-gray-400" /> SSO / IdP config
            </button>
          )}
          <button type="button" role="menuitem" onClick={run(onTier)} className={itemClass}>
            <Layers className="w-3.5 h-3.5 text-gray-400" /> Change tier
          </button>
          <button type="button" role="menuitem" onClick={run(onNamespace)} className={itemClass}>
            <FileDown className="w-3.5 h-3.5 text-gray-400" /> Namespace YAML
          </button>
          <div className="my-1 border-t border-gray-100 dark:border-gray-700" />
          <button
            type="button"
            role="menuitem"
            onClick={run(onDelete)}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" /> Delete organization
          </button>
          <p className="px-3 pt-1 pb-1.5 text-[11px] leading-snug text-gray-400 dark:text-gray-500">
            Removes all members from the org (users aren&apos;t deleted). Cannot be undone.
          </p>
        </div>
      )}
    </>
  );
}

/** Organization management page (system admin only). Lists all organizations with delete capability. */
export default function OrganizationsPage() {
  const { user, isReady, isAuthenticated, isSuperAdmin, can } = useAuthGuard({ requireSystemAdmin: true });

  // Top-level view: the org list vs. the aggregated "Deleted items" (trash)
  // restore surface. The trash tab is a System-Admin surface, gated on the same
  // system-admin context that guards every destructive action on this page.
  const [tab, setTab] = useState<'organizations' | 'deleted'>('organizations');
  const [trashResource, setTrashResource] = useState<TrashResource>('pipeline');

  const list = useListPage<OrganizationListItem>({
    fields: [
      { key: 'search', type: 'text', defaultValue: '', primary: true },
      { key: 'tier', type: 'select', defaultValue: 'all' },
      // Soft-deleted orgs are returned inline by the list endpoint (flagged
      // `pendingDeletion`); this facet (client-side) hides them by default.
      { key: 'deleted', type: 'select', defaultValue: 'hide' },
      // KMS / IdP facets are stored as filter state but applied client-side
      // (see `filteredOrgs` below). Server-side filtering would require an
      // extra index per facet and these are sysadmin-only views with bounded
      // pages — the cost of the extra Mongo join isn't justified.
      { key: 'kms', type: 'select', defaultValue: 'all' },
      { key: 'idp', type: 'select', defaultValue: 'all' },
      // Top-level vs. team (nested) facet — also applied client-side via
      // `parentOrgId` in `filteredOrgs`.
      { key: 'scope', type: 'select', defaultValue: 'all' },
    ],
    fetcher: async (params) => {
      const tierParam = String(params.tier || 'all');
      const response = await api.listOrganizations({
        ...(params.search && { search: params.search }),
        ...(tierParam !== 'all' && { tier: tierParam as 'developer' | 'pro' | 'team' | 'enterprise' }),
        offset: Number(params.offset || 0),
        limit: Number(params.limit || 25),
      });
      const data = response.data;
      return {
        items: data?.organizations || [],
        pagination: data?.pagination,
      };
    },
    enabled: isAuthenticated && isSuperAdmin,
  });

  // Client-side facet filtering for KMS / IdP. Pagination still reflects
  // the server total — operators see the unfiltered total above, and the
  // narrowed list inside. A filter that hides every row on the current
  // page just shows an empty table; they can clear or page forward.
  const filteredOrgs = useMemo(() => {
    const kmsFacet = String(list.filters.kms || 'all');
    const idpFacet = String(list.filters.idp || 'all');
    const scopeFacet = String(list.filters.scope || 'all');
    const deletedFacet = String(list.filters.deleted || 'hide');
    return list.data.filter((org) => {
      if (deletedFacet === 'hide' && org.pendingDeletion) return false;
      if (deletedFacet === 'only' && !org.pendingDeletion) return false;
      if (kmsFacet === 'yes' && !org.kmsConfigured) return false;
      if (kmsFacet === 'no' && org.kmsConfigured) return false;
      if (idpFacet === 'yes' && !org.idpConfigured) return false;
      if (idpFacet === 'no' && org.idpConfigured) return false;
      if (scopeFacet === 'team' && !org.parentOrgId) return false;
      if (scopeFacet === 'top' && org.parentOrgId) return false;
      return true;
    });
  }, [list.data, list.filters.kms, list.filters.idp, list.filters.scope, list.filters.deleted]);

  // The KMS / SSO / scope / deletion facets are applied client-side over the
  // current page only (see `filteredOrgs`), so when one narrows the view we label
  // that it's page-scoped rather than pretending it filtered the whole account.
  const clientFacetActive =
    String(list.filters.kms || 'all') !== 'all' ||
    String(list.filters.idp || 'all') !== 'all' ||
    String(list.filters.scope || 'all') !== 'all' ||
    String(list.filters.deleted || 'hide') !== 'hide';

  // Two-phase delete: the existing DeleteConfirmModal collects intent, then
  // a StepUpModal collects password reverify. Backend requires the step-up
  // token; clicking delete without re-prompt would 401.
  const [pendingDeleteOrg, setPendingDeleteOrg] = useState<Organization | null>(null);
  // Restore a soft-deleted org. Step-up gated like delete, so it routes through
  // a StepUpModal before POST /organization/:id/restore fires.
  const [pendingRestoreOrg, setPendingRestoreOrg] = useState<OrganizationListItem | null>(null);
  const del = useDelete<Organization>(
    async (org) => {
      // Defer the actual delete to the step-up step.
      setPendingDeleteOrg(org);
    },
    () => undefined,
    (err) => list.setError(formatError(err, 'Failed to delete organization')),
  );

  // Sysadmin admin actions: manage per-org KMS binding + IdP config +
  // download the k8s namespace manifest for enterprise customers. All in
  // modals so they don't clutter the row view. The org-detail page links
  // out from each row for a consolidated view of the org's posture.
  const [kmsOrg, setKmsOrg] = useState<Organization | null>(null);
  const [idpOrg, setIdpOrg] = useState<Organization | null>(null);
  const [pendingYamlOrg, setPendingYamlOrg] = useState<Organization | null>(null);

  // Inline per-row tier change. Two-phase like delete: pick the new tier in a
  // small modal, then re-verify via StepUpModal (the backend PATCH is step-up
  // gated because a tier change reseeds quota limits / affects billing).
  const [tierOrg, setTierOrg] = useState<Organization | null>(null);
  const [newTier, setNewTier] = useState<'developer' | 'pro' | 'team' | 'enterprise'>('developer');
  const [pendingTierChange, setPendingTierChange] = useState<{ org: Organization; tier: 'developer' | 'pro' | 'team' | 'enterprise' } | null>(null);

  const openTier = useCallback((org: Organization) => {
    setTierOrg(org);
    setNewTier((org.tier as 'developer' | 'pro' | 'team' | 'enterprise') ?? 'developer');
  }, []);

  // Advance from tier-picker to the step-up prompt (no-op if unchanged).
  const confirmTierSelection = useCallback(() => {
    if (!tierOrg) return;
    if (newTier !== tierOrg.tier) setPendingTierChange({ org: tierOrg, tier: newTier });
    setTierOrg(null);
  }, [tierOrg, newTier]);

  // Create a new top-level organization (sysadmin). The creator becomes the
  // initial owner; ownership can be transferred from the org's detail page.
  const toast = useToast();
  const [createOpen, setCreateOpen] = useState(false);
  const [newOrgName, setNewOrgName] = useState('');
  const [newOrgTier, setNewOrgTier] = useState<'developer' | 'pro' | 'team' | 'enterprise'>('developer');
  // The "New Organization" button defaults to a top-level org (matching its
  // label); check the Team box to instead nest under a parent. Parent
  // candidates are the existing root orgs.
  const [createAsSubOrg, setCreateAsSubOrg] = useState(false);
  const [parentOrgId, setParentOrgId] = useState('');
  const [parentOptions, setParentOptions] = useState<Organization[]>([]);
  const createForm = useFormState();

  // Open the create modal, resetting state and loading the root orgs that can
  // act as a parent for a team.
  const openCreate = async () => {
    setNewOrgName('');
    setNewOrgTier('developer');
    setCreateAsSubOrg(false);
    setParentOrgId('');
    setParentOptions([]);
    createForm.reset();
    setCreateOpen(true);
    try {
      const res = await api.listOrganizations({ limit: 200 });
      setParentOptions((res.data?.organizations ?? []).filter((o) => !o.parentOrgId));
    } catch { /* best-effort — the team option simply won't have parents to pick */ }
  };

  const handleCreateOrg = async () => {
    const name = newOrgName.trim();
    if (!name) return;
    if (createAsSubOrg && !parentOrgId) {
      createForm.setError('Choose a parent organization for the team (or uncheck to create a top-level org).');
      return;
    }
    const result = await createForm.run(() => api.createOrganization({
      name,
      tier: newOrgTier,
      ...(createAsSubOrg && parentOrgId ? { parentOrgId } : {}),
    }));
    if (result !== null) {
      setCreateOpen(false);
      list.refresh();
      toast.success(`${createAsSubOrg ? 'Team' : 'Organization'} "${name}" created`);
    }
  };

  const downloadNamespaceYaml = useCallback(async (org: Organization, stepUpToken: string) => {
    try {
      const yaml = await api.getOrgNamespaceYaml(org.id, stepUpToken);
      // Browser-side download — render endpoint returns text/yaml with a
      // Content-Disposition header but we set our own to be explicit.
      triggerBlobDownload(new Blob([yaml], { type: 'application/yaml' }), `pb-org-${org.slug ?? org.id}.yaml`);
    } catch (err) {
      list.setError(formatError(err, 'Failed to download namespace YAML'));
    }
  }, [list]);

  const orgColumns: Column<OrganizationListItem>[] = useMemo(() => [
    // NOTE: no `sortValue` on these columns. The list is server-paginated and the
    // list endpoint has no sort param, so a client sort would only reorder the
    // current page (and worse, only the client-facet-filtered subset of it).
    // Sort affordance intentionally dropped until the backend supports it.
    {
      id: 'name',
      header: 'Organization',
      render: (org) => (
        <div>
          <div className="text-sm font-medium text-gray-900 dark:text-gray-100 flex flex-wrap items-center gap-1.5">
            {org.name}
            {org.id === 'system' && <Badge color="purple">System</Badge>}
            {org.parentOrgId && (
              <Badge color="indigo">
                {org.parentOrgName ? `Team of ${org.parentOrgName}` : 'Team'}
              </Badge>
            )}
            {org.tier && <Badge color={org.tier === 'enterprise' ? 'red' : org.tier === 'team' ? 'green' : org.tier === 'pro' ? 'purple' : 'gray'}>{org.tier}</Badge>}
            {org.kmsConfigured && <Badge color="blue">KMS</Badge>}
            {org.idpConfigured && <Badge color="green">SSO</Badge>}
            {org.pendingDeletion && <Badge color="red">Pending deletion</Badge>}
          </div>
          {org.description && (
            <div className="text-sm text-gray-500 dark:text-gray-400 truncate max-w-xs">{org.description}</div>
          )}
        </div>
      ),
    },
    {
      id: 'members',
      header: 'Members',
      cellClassName: 'text-sm text-gray-500 dark:text-gray-400',
      render: (org) => <>{org.memberCount} member{org.memberCount !== 1 ? 's' : ''}</>,
    },
    {
      id: 'created',
      header: 'Created',
      cellClassName: 'text-sm text-gray-500 dark:text-gray-400',
      render: (org) => <RelativeTime value={org.createdAt} />,
    },
    {
      id: 'actions',
      header: 'Actions',
      headerClassName: 'text-right',
      cellClassName: 'text-right text-sm font-medium',
      render: (org) => (
        org.id === 'system' ? (
          <span className="text-gray-400 dark:text-gray-500 text-xs">Protected</span>
        ) : org.pendingDeletion ? (
          // Soft-deleted: only Details + Restore make sense (the destructive
          // actions are moot on a tombstoned org).
          <div className="flex justify-end gap-3">
            <Link
              href={`/dashboard/admin/orgs/${org.id}`}
              className="action-link inline-flex items-center gap-1"
              title="Open org details"
            >
              <ExternalLink className="w-3.5 h-3.5" /> Details
            </Link>
            <button
              onClick={() => setPendingRestoreOrg(org)}
              className="action-link inline-flex items-center gap-1"
              title="Restore this soft-deleted organization"
            >
              <RotateCcw className="w-3.5 h-3.5" /> Restore
            </button>
          </div>
        ) : (
          // Primary action (Details) stays visible; the less-common admin
          // actions and the destructive Delete collapse into an overflow menu
          // so the row reads cleanly.
          <div className="flex justify-end items-center gap-2">
            <Link
              href={`/dashboard/admin/orgs/${org.id}`}
              className="action-link inline-flex items-center gap-1"
              title="Open org details"
            >
              <ExternalLink className="w-3.5 h-3.5" /> Details
            </Link>
            <RowActionsMenu
              canKms={can('org:kms')}
              canIdp={can('org:idp')}
              onKms={() => setKmsOrg(org)}
              onIdp={() => setIdpOrg(org)}
              onTier={() => openTier(org)}
              onNamespace={() => setPendingYamlOrg(org)}
              onDelete={() => del.open(org)}
            />
          </div>
        )
      ),
    },
  ], [del, openTier]);

  if (!isReady || !user) return <LoadingPage />;

  return (
    <DashboardLayout
      title="Organizations"
      subtitle="Manage organizations and access"
      titleExtra={<Badge color="red">System Admin</Badge>}
      actions={
        <Button onClick={openCreate}>
          <Plus className="w-4 h-4 mr-1.5" /> New Organization
        </Button>
      }
    >
      <ErrorAlert message={list.error} onDismiss={() => list.setError(null)} />

      <TabBar
        items={[
          { id: 'organizations', label: 'Organizations' },
          { id: 'deleted', label: 'Deleted items' },
        ]}
        activeId={tab}
        onSelect={(id) => setTab(id as 'organizations' | 'deleted')}
      />

      {tab === 'deleted' ? (
        // Aggregated trash view: pick a resource kind, then reuse the shared
        // restore panel + its list-deleted/restore APIs. System-admin only
        // (the whole page is), matching the gating on the destructive actions.
        isSuperAdmin ? (
          <div className="space-y-4">
            <SegmentedFilter
              ariaLabel="Choose a deleted resource type to restore"
              options={TRASH_RESOURCES.map((r) => ({ value: r.key, label: r.label }))}
              value={trashResource}
              onChange={(v) => setTrashResource(v)}
            />
            <RecentlyDeletedPanel
              // key forces a fresh mount per resource so the panel reloads its
              // list when the selector changes.
              key={trashResource}
              resource={trashResource}
              onRestored={() => { /* trash view has no main list to refresh; the panel reloads itself */ }}
            />
          </div>
        ) : (
          <InfoAlert message="You do not have permission to view deleted items." />
        )
      ) : (
      <>
      <div className="filter-bar flex flex-wrap items-center gap-2">
        <SearchInput
          containerClassName="flex-1 min-w-[16rem]"
          placeholder="Search organizations..."
          value={list.filters.search}
          onChange={(v) => list.updateFilter('search', v)}
          aria-label="Search organizations"
        />
        <FilterSelect
          value={list.filters.tier}
          onChange={(e) => list.updateFilter('tier', e.target.value)}
          aria-label="Filter by tier"
        >
          <option value="all">All tiers</option>
          <option value="developer">Developer</option>
          <option value="pro">Pro</option>
          <option value="team">Team</option>
          <option value="enterprise">Enterprise</option>
        </FilterSelect>
        <FilterSelect
          value={list.filters.kms}
          onChange={(e) => list.updateFilter('kms', e.target.value)}
          aria-label="Filter by per-org KMS"
        >
          <option value="all">KMS: any</option>
          <option value="yes">KMS: configured</option>
          <option value="no">KMS: not configured</option>
        </FilterSelect>
        <FilterSelect
          value={list.filters.idp}
          onChange={(e) => list.updateFilter('idp', e.target.value)}
          aria-label="Filter by SSO / IdP"
        >
          <option value="all">SSO: any</option>
          <option value="yes">SSO: configured</option>
          <option value="no">SSO: not configured</option>
        </FilterSelect>
        <FilterSelect
          value={list.filters.deleted}
          onChange={(e) => list.updateFilter('deleted', e.target.value)}
          aria-label="Filter by deletion state"
        >
          <option value="hide">Deleted: hidden</option>
          <option value="show">Deleted: shown</option>
          <option value="only">Deleted: only</option>
        </FilterSelect>
        <SegmentedFilter
          className="ml-auto"
          ariaLabel="Filter by org scope"
          options={[{ value: 'all', label: 'All' }, { value: 'top', label: 'Top-level' }, { value: 'team', label: 'Teams' }]}
          value={String(list.filters.scope)}
          onChange={(v) => list.updateFilter('scope', v)}
        />
      </div>

      {clientFacetActive && (
        <InfoAlert
          className="mt-3"
          message={`Showing ${filteredOrgs.length} of ${list.data.length} on this page — the KMS, SSO, scope, and deletion filters apply to the current page only.`}
        />
      )}

      <DataTable
        data={filteredOrgs}
        columns={orgColumns}
        isLoading={list.isLoading}
        emptyState={{ icon: Building2, title: 'No organizations', description: 'No organizations found.' }}
        getRowKey={(org) => org.id}
      />

      {!list.isLoading && list.pagination.total > 0 && (
        <Pagination pagination={list.pagination} onPageChange={list.handlePageChange} onPageSizeChange={list.handlePageSizeChange} />
      )}
      </>
      )}

      {createOpen && (
        <Modal
          title={createAsSubOrg ? 'Create Team' : 'Create Organization'}
          onClose={() => setCreateOpen(false)}
          footer={
            <ModalFooter
              onCancel={() => setCreateOpen(false)}
              onConfirm={handleCreateOrg}
              confirmLabel={createAsSubOrg ? 'Create Team' : 'Create Organization'}
              loading={createForm.loading}
              confirmDisabled={!newOrgName.trim() || (createAsSubOrg && !parentOrgId)}
            />
          }
        >
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
            {createAsSubOrg
              ? 'Create a team nested under a parent organization. You become its initial owner; transfer ownership from the org’s detail page afterward.'
              : 'Create a top-level organization. You become its initial owner; transfer ownership from the org’s detail page afterward.'}
          </p>
          <div className="space-y-3">
            <div className="space-y-1">
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">
                {createAsSubOrg ? 'Team name' : 'Organization name'}
              </label>
              <Input
                type="text"
                placeholder="e.g. acme-platform"
                value={newOrgName}
                onChange={(e) => setNewOrgName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCreateOrg()}
                className="text-sm"
                autoFocus
                disabled={createForm.loading}
              />
            </div>
            <div className="space-y-1">
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Tier</label>
              <Select
                value={newOrgTier}
                onChange={(e) => setNewOrgTier(e.target.value as 'developer' | 'pro' | 'team' | 'enterprise')}
                className="text-sm"
                disabled={createForm.loading}
              >
                <option value="developer">Developer</option>
                <option value="pro">Pro</option>
                <option value="team">Team</option>
                <option value="enterprise">Enterprise</option>
              </Select>
            </div>

            {/* Team toggle — defaults OFF (top-level org). When on, pick the parent. */}
            <label className="flex items-start gap-2 text-xs text-gray-700 dark:text-gray-300 pt-1">
              <Checkbox
                checked={createAsSubOrg}
                onChange={(e) => setCreateAsSubOrg(e.target.checked)}
                disabled={createForm.loading}
                className="mt-0.5"
              />
              <span>
                <strong>Team</strong> — nest this organization under a parent org.
                Uncheck to create a standalone top-level organization.
              </span>
            </label>

            {createAsSubOrg && (
              <div className="space-y-1">
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Parent organization</label>
                <Select
                  value={parentOrgId}
                  onChange={(e) => setParentOrgId(e.target.value)}
                  className="text-sm"
                  disabled={createForm.loading}
                >
                  <option value="">Select a parent organization…</option>
                  {parentOptions.map((o) => (
                    <option key={o.id} value={o.id}>{o.name}</option>
                  ))}
                </Select>
                {parentOptions.length === 0 && (
                  <p className="text-xs text-amber-600 dark:text-amber-400">
                    No top-level organizations available to nest under — uncheck above to create one.
                  </p>
                )}
              </div>
            )}
          </div>
          {createForm.error && <p className="text-sm text-red-600 dark:text-red-400 mt-3">{createForm.error}</p>}
        </Modal>
      )}

      {del.target && (
        <DeleteConfirmModal
          title="Delete Organization"
          itemName={del.target.name}
          loading={del.loading}
          onConfirm={del.confirm}
          onCancel={del.close}
        />
      )}

      {kmsOrg && (
        <OrgKmsConfigModal org={kmsOrg} onClose={() => setKmsOrg(null)} />
      )}

      {idpOrg && (
        <OrgIdpConfigModal org={idpOrg} onClose={() => setIdpOrg(null)} />
      )}

      {pendingDeleteOrg && (
        <StepUpModal
          action={`Delete organization ${pendingDeleteOrg.name}`}
          onConfirmed={async (stepUpToken) => {
            try {
              const res = await api.deleteOrganization(pendingDeleteOrg.id, stepUpToken);
              if (!res.success) throw new Error(res.message || 'Delete failed');
              list.refresh();
              toast.success(`${pendingDeleteOrg.name} deleted`);
            } catch (err) {
              list.setError(formatError(err, 'Failed to delete organization'));
            }
          }}
          onClose={() => setPendingDeleteOrg(null)}
        />
      )}

      {pendingYamlOrg && (
        <StepUpModal
          action={`Download k8s namespace YAML for ${pendingYamlOrg.name}`}
          onConfirmed={(stepUpToken) => downloadNamespaceYaml(pendingYamlOrg, stepUpToken)}
          onClose={() => setPendingYamlOrg(null)}
        />
      )}

      {pendingRestoreOrg && (
        <StepUpModal
          action={`Restore organization ${pendingRestoreOrg.name}`}
          onConfirmed={async (stepUpToken) => {
            try {
              const res = await api.restoreOrganization(pendingRestoreOrg.id, stepUpToken);
              if (!res.success) throw new Error(res.message || 'Restore failed');
              list.refresh();
              toast.success(`${pendingRestoreOrg.name} restored`);
            } catch (err) {
              list.setError(formatError(err, 'Failed to restore organization'));
            }
          }}
          onClose={() => setPendingRestoreOrg(null)}
        />
      )}

      {tierOrg && (
        <Modal
          title={`Change tier — ${tierOrg.name}`}
          onClose={() => setTierOrg(null)}
          footer={
            <ModalFooter
              onCancel={() => setTierOrg(null)}
              onConfirm={confirmTierSelection}
              confirmLabel="Continue"
              confirmDisabled={newTier === tierOrg.tier}
            />
          }
        >
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
            Changing the tier reseeds this organization’s quota limits and affects billing.
            You’ll be asked to re-verify before the change is applied.
          </p>
          <div className="space-y-1">
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Tier</label>
            <Select
              value={newTier}
              onChange={(e) => setNewTier(e.target.value as 'developer' | 'pro' | 'team' | 'enterprise')}
              className="text-sm"
            >
              <option value="developer">Developer</option>
              <option value="pro">Pro</option>
              <option value="team">Team</option>
              <option value="enterprise">Enterprise</option>
            </Select>
          </div>
        </Modal>
      )}

      {pendingTierChange && (
        <StepUpModal
          action={`Change ${pendingTierChange.org.name} to the ${pendingTierChange.tier} tier`}
          onConfirmed={async (stepUpToken) => {
            try {
              const res = await api.updateOrganizationTier(pendingTierChange.org.id, pendingTierChange.tier, stepUpToken);
              if (!res.success) throw new Error(res.message || 'Tier change failed');
              list.refresh();
              toast.success(`${pendingTierChange.org.name} moved to ${pendingTierChange.tier}`);
            } catch (err) {
              list.setError(formatError(err, 'Failed to change tier'));
            }
          }}
          onClose={() => setPendingTierChange(null)}
        />
      )}
    </DashboardLayout>
  );
}
