// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Sysadmin IdP / SSO roster.
 *
 * A fleet-wide view of every org that has an IdP (SSO) config, sourced from
 * `GET /api/admin/org-idp`. Per-org CRUD already lives on the org-detail page's
 * IdP editor; this page is the read-only overview answering "which orgs have SSO
 * set up, with which provider, and is it enabled?" — with a jump to each org's
 * editor. Guarded sysadmin-only like the other Platform surfaces.
 */

import { useMemo } from 'react';
import Link from 'next/link';
import { ArrowLeft, ShieldCheck, Pencil } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useFetch } from '@/hooks/useFetch';
import { useQuery } from '@/hooks/useQuery';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { RetryError } from '@/components/ui/RetryError';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { Badge } from '@/components/ui/Badge';
import { CopyableId } from '@/components/ui/CopyableId';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { formatError } from '@/lib/constants';
import api from '@/lib/api';
import { queries } from '@/lib/api-cache';
import type { OrgIdpConfigDto } from '@/types';

export default function IdpRosterPage() {
  // The sysadmin gate comes from the nav entry (`systemAdminOnly`) via page-access.
  const { accessDenied, isReady, user, isAuthenticated, isSuperAdmin } = useAuthGuard();
  const enabled = isAuthenticated && isSuperAdmin;

  // The roster is the source of truth.
  const roster = useFetch(async (signal): Promise<OrgIdpConfigDto[]> => {
    if (!enabled) return [];
    const res = await api.listOrgIdpConfigs({ signal });
    if (!res.success || !res.data) throw new Error(res.message || 'Failed to load IdP roster');
    return res.data.configs ?? [];
  }, [enabled]);
  const configs = roster.data ?? [];
  const loading = roster.loading;
  const load = roster.refetch;

  // orgId → display name, a best-effort enrichment through the shared org-list
  // cache (the orgs page and audit log read the same list), so a failure there
  // never blanks the roster. Missing entries fall back to the id.
  const orgList = useQuery(enabled ? queries.listOrganizations({ limit: 200 }) : null);
  const orgNames = useMemo(() => {
    const map: Record<string, string> = {};
    for (const o of orgList.data?.data?.organizations ?? []) map[o.id] = o.name;
    return map;
  }, [orgList.data]);

  const columns: Column<OrgIdpConfigDto>[] = useMemo(() => [
    {
      id: 'org',
      header: 'Organization',
      sortValue: (c) => orgNames[c.orgId] ?? c.orgId,
      render: (c) => (
        <div>
          <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
            {orgNames[c.orgId] ?? <span className="text-gray-500 dark:text-gray-400">(unknown org)</span>}
          </div>
          <CopyableId value={c.orgId} size="sm" />
        </div>
      ),
    },
    {
      id: 'provider',
      header: 'Provider',
      sortValue: (c) => c.provider,
      render: (c) => <code className="text-xs">{c.provider}</code>,
    },
    {
      id: 'status',
      header: 'Status',
      sortValue: (c) => (c.enabled ? 1 : 0),
      render: (c) => (c.enabled ? <Badge color="green">enabled</Badge> : <Badge color="yellow">disabled</Badge>),
    },
    {
      id: 'domains',
      header: 'Allowed domains',
      cellClassName: 'text-sm text-gray-500 dark:text-gray-400',
      render: (c) => (c.allowedEmailDomains.length > 0 ? c.allowedEmailDomains.join(', ') : <span className="text-gray-400 dark:text-gray-500">—</span>),
    },
    {
      id: 'updated',
      header: 'Updated',
      cellClassName: 'text-sm text-gray-500 dark:text-gray-400',
      sortValue: (c) => (c.updatedAt ? new Date(c.updatedAt) : null),
      render: (c) => <RelativeTime value={c.updatedAt} />,
    },
    {
      id: 'actions',
      header: 'Actions',
      headerClassName: 'text-right',
      cellClassName: 'text-right text-sm font-medium',
      render: (c) => (
        <Link
          href={`/dashboard/admin/orgs/${c.orgId}?edit=idp`}
          className="action-link inline-flex items-center gap-1"
          title="Open the org's IdP editor"
        >
          <Pencil className="w-3.5 h-3.5" /> Edit
        </Link>
      ),
    },
  ], [orgNames]);

  if (accessDenied) return <AccessDenied denial={accessDenied} />;
  if (!isReady || !user) return <LoadingPage />;

  const enabledCount = configs.filter((c) => c.enabled).length;

  return (
    <DashboardLayout
      title="IdP / SSO"
      subtitle="Every organization with an SSO / IdP configuration"
      titleExtra={<Badge color="red">System Admin</Badge>}
    >
      <div className="mb-4">
        <Link href="/dashboard/organizations" className="action-link inline-flex items-center gap-1 text-sm">
          <ArrowLeft className="w-4 h-4" /> Back to organizations
        </Link>
      </div>

      {/* On failure, show ONLY a retryable error — not the "No IdP configurations"
          empty state layered under an error banner (the old fail-soft set
          configs=[] AND error, rendering both and offering no retry). */}
      {roster.error ? (
        <RetryError message={formatError(roster.error, 'Failed to load IdP roster')} onRetry={load} />
      ) : (
        <>
          {!loading && configs.length > 0 && (
            <div className="mb-4 text-sm text-gray-500 dark:text-gray-400">
              {configs.length} org{configs.length !== 1 ? 's' : ''} with an IdP configured · {enabledCount} enabled
            </div>
          )}

          <DataTable
            data={configs}
            columns={columns}
            isLoading={loading}
            emptyState={{
              icon: ShieldCheck,
              title: 'No IdP configurations',
              description: 'No organization has an SSO / IdP config yet. Configure one from an org’s detail page.',
            }}
            getRowKey={(c) => c.orgId}
            defaultSortColumn="org"
          />
        </>
      )}
    </DashboardLayout>
  );
}
