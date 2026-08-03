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

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, ShieldCheck, Pencil } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { Badge } from '@/components/ui/Badge';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { CopyableId } from '@/components/ui/CopyableId';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { formatError } from '@/lib/constants';
import api from '@/lib/api';
import type { OrgIdpConfigDto } from '@/types';

export default function IdpRosterPage() {
  const { isReady, user, isAuthenticated, isSuperAdmin } = useAuthGuard({ requireSystemAdmin: true });

  const [configs, setConfigs] = useState<OrgIdpConfigDto[]>([]);
  // orgId → display name, resolved best-effort from the orgs list so the roster
  // shows names instead of bare ids. Missing entries fall back to the id.
  const [orgNames, setOrgNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!isAuthenticated || !isSuperAdmin) return;
    setLoading(true);
    setError(null);
    try {
      // The roster is the source of truth; org-name resolution is a best-effort
      // enrichment, so a failure there must not blank the page.
      const [idpRes, orgsRes] = await Promise.all([
        api.listOrgIdpConfigs(),
        api.listOrganizations({ limit: 200 }).catch(() => null),
      ]);
      if (idpRes.success && idpRes.data) setConfigs(idpRes.data.configs ?? []);
      else throw new Error(idpRes.message || 'Failed to load IdP roster');
      if (orgsRes?.success && orgsRes.data) {
        const map: Record<string, string> = {};
        for (const o of orgsRes.data.organizations) map[o.id] = o.name;
        setOrgNames(map);
      }
    } catch (e) {
      // Fail-soft: a 403/404 renders an empty roster rather than crashing.
      setConfigs([]);
      setError(formatError(e, 'Failed to load IdP roster'));
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated, isSuperAdmin]);

  useEffect(() => { void load(); }, [load]);

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
          href={`/dashboard/admin/orgs/${c.orgId}`}
          className="action-link inline-flex items-center gap-1"
          title="Open the org's IdP editor"
        >
          <Pencil className="w-3.5 h-3.5" /> Edit
        </Link>
      ),
    },
  ], [orgNames]);

  if (!isReady || !user) return <LoadingPage />;

  const enabledCount = configs.filter((c) => c.enabled).length;

  return (
    <DashboardLayout
      title="IdP / SSO roster"
      subtitle="Every organization with an SSO / IdP configuration"
      titleExtra={<Badge color="red">System Admin</Badge>}
    >
      <div className="mb-4">
        <Link href="/dashboard/organizations" className="action-link inline-flex items-center gap-1 text-sm">
          <ArrowLeft className="w-4 h-4" /> Back to organizations
        </Link>
      </div>

      <ErrorAlert message={error} onDismiss={() => setError(null)} />

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
    </DashboardLayout>
  );
}
