import { useMemo, useState, useCallback } from 'react';
import { formatError } from '@/lib/constants';
import { Building2, AlertTriangle, Search, KeyRound, FileDown, ShieldCheck, ExternalLink, Plus } from 'lucide-react';
import Link from 'next/link';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useListPage } from '@/hooks/useListPage';
import { useFormState } from '@/hooks/useFormState';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { Badge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';
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

/** Organization management page (system admin only). Lists all organizations with delete capability. */
export default function OrganizationsPage() {
  const { user, isReady, isAuthenticated, isSuperAdmin } = useAuthGuard({ requireSystemAdmin: true });

  const list = useListPage<Organization>({
    fields: [
      { key: 'search', type: 'text', defaultValue: '', primary: true },
      { key: 'tier', type: 'select', defaultValue: 'all' },
      // KMS / IdP facets are stored as filter state but applied client-side
      // (see `filteredOrgs` below). Server-side filtering would require an
      // extra index per facet and these are sysadmin-only views with bounded
      // pages — the cost of the extra Mongo join isn't justified.
      { key: 'kms', type: 'select', defaultValue: 'all' },
      { key: 'idp', type: 'select', defaultValue: 'all' },
    ],
    fetcher: async (params) => {
      const tierParam = String(params.tier || 'all');
      const response = await api.listOrganizations({
        ...(params.search && { search: params.search }),
        ...(tierParam !== 'all' && { tier: tierParam as 'developer' | 'pro' | 'unlimited' }),
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
    return list.data.filter((org) => {
      if (kmsFacet === 'yes' && !org.kmsConfigured) return false;
      if (kmsFacet === 'no' && org.kmsConfigured) return false;
      if (idpFacet === 'yes' && !org.idpConfigured) return false;
      if (idpFacet === 'no' && org.idpConfigured) return false;
      return true;
    });
  }, [list.data, list.filters.kms, list.filters.idp]);

  // Two-phase delete: the existing DeleteConfirmModal collects intent, then
  // a StepUpModal collects password reverify. Backend requires the step-up
  // token; clicking delete without re-prompt would 401.
  const [pendingDeleteOrg, setPendingDeleteOrg] = useState<Organization | null>(null);
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

  // Create a new top-level organization (sysadmin). The creator becomes the
  // initial owner; ownership can be transferred from the org's detail page.
  const toast = useToast();
  const [createOpen, setCreateOpen] = useState(false);
  const [newOrgName, setNewOrgName] = useState('');
  const [newOrgTier, setNewOrgTier] = useState<'developer' | 'pro' | 'unlimited'>('developer');
  const createForm = useFormState();

  const handleCreateOrg = async () => {
    const name = newOrgName.trim();
    if (!name) return;
    const result = await createForm.run(() => api.createOrganization({ name, tier: newOrgTier }));
    if (result !== null) {
      setNewOrgName('');
      setNewOrgTier('developer');
      setCreateOpen(false);
      list.refresh();
      toast.success(`Organization "${name}" created`);
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

  const orgColumns: Column<Organization>[] = useMemo(() => [
    {
      id: 'name',
      header: 'Organization',
      sortValue: (org) => org.name,
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
            {org.tier && <Badge color={org.tier === 'unlimited' ? 'red' : org.tier === 'pro' ? 'purple' : 'gray'}>{org.tier}</Badge>}
            {org.kmsConfigured && <Badge color="blue">KMS</Badge>}
            {org.idpConfigured && <Badge color="green">SSO</Badge>}
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
      sortValue: (org) => org.memberCount,
      render: (org) => <>{org.memberCount} member{org.memberCount !== 1 ? 's' : ''}</>,
    },
    {
      id: 'created',
      header: 'Created',
      cellClassName: 'text-sm text-gray-500 dark:text-gray-400',
      sortValue: (org) => org.createdAt ? new Date(org.createdAt) : null,
      render: (org) => <RelativeTime value={org.createdAt} />,
    },
    {
      id: 'actions',
      header: 'Actions',
      headerClassName: 'text-right',
      cellClassName: 'text-right text-sm font-medium',
      render: (org) => (
        org.id !== 'system' ? (
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
              onClick={() => setPendingYamlOrg(org)}
              className="action-link inline-flex items-center gap-1"
              title="Download k8s namespace YAML"
            >
              <FileDown className="w-3.5 h-3.5" /> Namespace
            </button>
            <button onClick={() => del.open(org)} className="action-link-danger">Delete</button>
          </div>
        ) : (
          <span className="text-gray-400 dark:text-gray-500 text-xs">Protected</span>
        )
      ),
    },
  ], [del]);

  if (!isReady || !user) return <LoadingPage />;

  return (
    <DashboardLayout
      title="Organizations"
      subtitle="Manage organizations and access"
      titleExtra={<Badge color="red">System Admin</Badge>}
      actions={
        <button
          onClick={() => { setNewOrgName(''); setNewOrgTier('developer'); createForm.reset(); setCreateOpen(true); }}
          className="btn btn-primary"
        >
          <Plus className="w-4 h-4 mr-1.5" /> New Organization
        </button>
      }
    >
      {list.error && (
        <div className="alert-error">
          <p>{list.error}</p>
          <button onClick={() => list.setError(null)} className="action-link-danger mt-2 underline">Dismiss</button>
        </div>
      )}

      <div className="filter-bar flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[16rem]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-gray-500" />
          <input
            type="text"
            placeholder="Search organizations..."
            value={list.filters.search}
            onChange={(e) => list.updateFilter('search', e.target.value)}
            className="filter-input"
          />
        </div>
        <select
          value={list.filters.tier}
          onChange={(e) => list.updateFilter('tier', e.target.value)}
          className="filter-select"
          aria-label="Filter by tier"
        >
          <option value="all">All tiers</option>
          <option value="developer">Developer</option>
          <option value="pro">Pro</option>
          <option value="unlimited">Unlimited</option>
        </select>
        <select
          value={list.filters.kms}
          onChange={(e) => list.updateFilter('kms', e.target.value)}
          className="filter-select"
          aria-label="Filter by per-org KMS"
        >
          <option value="all">KMS: any</option>
          <option value="yes">KMS: configured</option>
          <option value="no">KMS: not configured</option>
        </select>
        <select
          value={list.filters.idp}
          onChange={(e) => list.updateFilter('idp', e.target.value)}
          className="filter-select"
          aria-label="Filter by SSO / IdP"
        >
          <option value="all">SSO: any</option>
          <option value="yes">SSO: configured</option>
          <option value="no">SSO: not configured</option>
        </select>
      </div>

      <DataTable
        data={filteredOrgs}
        columns={orgColumns}
        isLoading={list.isLoading}
        emptyState={{ icon: Building2, title: 'No organizations', description: 'No organizations found.' }}
        getRowKey={(org) => org.id}
        defaultSortColumn="name"
      />

      {!list.isLoading && list.pagination.total > 0 && (
        <Pagination pagination={list.pagination} onPageChange={list.handlePageChange} onPageSizeChange={list.handlePageSizeChange} />
      )}

      {/* Warning */}
      <div className="card mt-6 border-yellow-200/60 dark:border-yellow-800/60 bg-yellow-50/80 dark:bg-yellow-900/20">
        <div className="flex">
          <AlertTriangle className="h-5 w-5 text-yellow-400 dark:text-yellow-500 flex-shrink-0" />
          <div className="ml-3">
            <h3 className="text-sm font-medium text-yellow-800 dark:text-yellow-300">Warning</h3>
            <p className="mt-1 text-sm text-yellow-700 dark:text-yellow-400">
              Deleting an organization will remove all members from the organization.
              This action cannot be undone. Users will not be deleted but will no longer belong to any organization.
            </p>
          </div>
        </div>
      </div>

      {createOpen && (
        <Modal
          title="Create Organization"
          onClose={() => setCreateOpen(false)}
          footer={
            <div className="flex justify-end gap-2">
              <button onClick={() => setCreateOpen(false)} className="btn btn-secondary" disabled={createForm.loading}>Cancel</button>
              <button onClick={handleCreateOrg} disabled={createForm.loading || !newOrgName.trim()} className="btn btn-primary">
                {createForm.loading ? 'Creating...' : 'Create Organization'}
              </button>
            </div>
          }
        >
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
            Create a new top-level organization. You become its initial <strong>owner</strong> —
            transfer ownership from the org&apos;s detail page afterward.
          </p>
          <div className="space-y-3">
            <div className="space-y-1">
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Organization name</label>
              <input
                type="text"
                placeholder="e.g. acme-platform"
                value={newOrgName}
                onChange={(e) => setNewOrgName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCreateOrg()}
                className="input text-sm"
                autoFocus
                disabled={createForm.loading}
              />
            </div>
            <div className="space-y-1">
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Tier</label>
              <select
                value={newOrgTier}
                onChange={(e) => setNewOrgTier(e.target.value as 'developer' | 'pro' | 'unlimited')}
                className="input text-sm"
                disabled={createForm.loading}
              >
                <option value="developer">Developer</option>
                <option value="pro">Pro</option>
                <option value="unlimited">Unlimited</option>
              </select>
            </div>
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
    </DashboardLayout>
  );
}
