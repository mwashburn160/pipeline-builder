import { useMemo, useState, useCallback } from 'react';
import { formatError } from '@/lib/constants';
import { Building2, Search, KeyRound, FileDown, ShieldCheck, ExternalLink, Plus, Layers, RotateCcw } from 'lucide-react';
import Link from 'next/link';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useListPage } from '@/hooks/useListPage';
import { useFormState } from '@/hooks/useFormState';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { Badge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Checkbox } from '@/components/ui/Checkbox';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { InfoAlert } from '@/components/ui/InfoAlert';
import { WarningAlert } from '@/components/ui/WarningAlert';
import { FilterInput } from '@/components/ui/FilterInput';
import { FilterSelect } from '@/components/ui/FilterSelect';
import { ModalFooter } from '@/components/ui/ModalFooter';
import { useToast } from '@/components/ui/Toast';
import { DeleteConfirmModal } from '@/components/ui/DeleteConfirmModal';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Pagination } from '@/components/ui/Pagination';
import { useDelete } from '@/hooks/useDelete';
import { OrgKmsConfigModal } from '@/components/admin/OrgKmsConfigModal';
import { OrgIdpConfigModal } from '@/components/admin/OrgIdpConfigModal';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { RelativeTime } from '@/components/ui/RelativeTime';
import api from '@/lib/api';
import { Organization } from '@/types';
import type { OrganizationListItem } from '@/lib/api/domains/organizations';

/** Organization management page (system admin only). Lists all organizations with delete capability. */
export default function OrganizationsPage() {
  const { user, isReady, isAuthenticated, isSuperAdmin } = useAuthGuard({ requireSystemAdmin: true });

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
      const blob = new Blob([yaml], { type: 'application/yaml' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `pb-org-${org.slug ?? org.id}.yaml`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
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
          <div className="flex justify-end gap-3">
            <Link
              href={`/dashboard/admin/orgs/${org.id}`}
              className="action-link inline-flex items-center gap-1"
              title="Open org details"
            >
              <ExternalLink className="w-3.5 h-3.5" /> Details
            </Link>
            <button
              onClick={() => setKmsOrg(org)}
              className="action-link inline-flex items-center gap-1"
              title="Manage per-org KMS config"
            >
              <KeyRound className="w-3.5 h-3.5" /> KMS
            </button>
            <button
              onClick={() => setIdpOrg(org)}
              className="action-link inline-flex items-center gap-1"
              title="Manage SSO / IdP config"
            >
              <ShieldCheck className="w-3.5 h-3.5" /> IdP
            </button>
            <button
              onClick={() => openTier(org)}
              className="action-link inline-flex items-center gap-1"
              title="Change pricing tier"
            >
              <Layers className="w-3.5 h-3.5" /> Tier
            </button>
            <button
              onClick={() => setPendingYamlOrg(org)}
              className="action-link inline-flex items-center gap-1"
              title="Download k8s namespace YAML"
            >
              <FileDown className="w-3.5 h-3.5" /> Namespace
            </button>
            <button onClick={() => del.open(org)} className="action-link-danger">Delete</button>
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

      <div className="filter-bar flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[16rem]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-gray-500" />
          <FilterInput
            type="text"
            placeholder="Search organizations..."
            value={list.filters.search}
            onChange={(e) => list.updateFilter('search', e.target.value)}
            aria-label="Search organizations"
          />
        </div>
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
        <div className="inline-flex items-center gap-1" role="group" aria-label="Filter by org scope">
          {([['all', 'All'], ['top', 'Top-level'], ['team', 'Teams']] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => list.updateFilter('scope', value)}
              aria-pressed={String(list.filters.scope) === value}
              className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${String(list.filters.scope) === value
                ? 'bg-blue-600 text-white border-blue-600'
                : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700'}`}
            >
              {label}
            </button>
          ))}
        </div>
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

      {/* Warning */}
      <WarningAlert
        className="mt-6"
        message="Deleting an organization removes all members from it. This action cannot be undone. Users are not deleted but will no longer belong to any organization."
      />

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
