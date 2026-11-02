// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useMemo } from 'react';
import Link from 'next/link';
import { ShieldCheck, Pencil } from 'lucide-react';
import { useFetch } from '@/hooks/useFetch';
import { RetryError } from '@/components/ui/RetryError';
import { Badge } from '@/components/ui/Badge';
import { CopyableId } from '@/components/ui/CopyableId';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { formatError } from '@/lib/constants';
import api from '@/lib/api';
import { useOrgNames } from '@/components/ui/OrgPicker';
import type { OrgIdpConfigDto } from '@/types';

interface Props {
  /** False while the viewer may not read the roster, or the page is not ready. */
  enabled: boolean;
}

/**
 * The fleet-wide IdP / SSO roster: every org with an SSO config, which provider,
 * and whether it is on — with a jump to each org's own IdP editor.
 *
 * It used to be its own page at `/dashboard/admin/idp`, reached from an eighth
 * item in the Platform nav section. It is a **tab on All organizations** now, for
 * the reason its own page gave away: the first thing it rendered was a "Back to
 * organizations" link. A per-org attribute is a COLUMN of the org list, not a
 * separate destination, and the nav section is the most crowded in the app.
 *
 * Per-org CRUD stays on the org-detail page's IdP editor; this is the read-only
 * overview that answers "which orgs have SSO set up, and is it working".
 */
export function OrgIdpRosterPanel({ enabled }: Props) {
  const roster = useFetch(async (signal): Promise<OrgIdpConfigDto[]> => {
    if (!enabled) return [];
    const res = await api.listOrgIdpConfigs({ signal });
    if (!res.success || !res.data) throw new Error(res.message || 'Failed to load IdP roster');
    return res.data.configs ?? [];
  }, [enabled]);
  // Memoized so the empty (loading/error) case keeps ONE array identity — the
  // column and org-name memos below key off it.
  const configs = useMemo(() => roster.data ?? [], [roster.data]);
  const loading = roster.loading;
  const load = roster.refetch;

  // orgId → display name for exactly the orgs in the roster (a best-effort
  // enrichment — a failure never blanks the roster; missing names fall back to
  // the id).
  const rosterOrgIds = useMemo(() => configs.map((c) => c.orgId), [configs]);
  const orgNameMap = useOrgNames(rosterOrgIds, enabled);
  const orgNames = useMemo(() => Object.fromEntries(orgNameMap) as Record<string, string>, [orgNameMap]);

  const columns: Column<OrgIdpConfigDto>[] = useMemo(() => [
    {
      id: 'org',
      header: 'Organization',
      sortValue: (c) => orgNames[c.orgId] ?? c.orgId,
      render: (c) => (
        <div>
          <div className="text-sm font-medium text-fg">
            {orgNames[c.orgId] ?? <span className="text-fg-muted">(unknown org)</span>}
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
      cellClassName: 'text-sm text-fg-muted',
      render: (c) => (c.allowedEmailDomains.length > 0 ? c.allowedEmailDomains.join(', ') : <span className="text-fg-subtle">—</span>),
    },
    {
      id: 'updated',
      header: 'Updated',
      cellClassName: 'text-sm text-fg-muted',
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

  const enabledCount = configs.filter((c) => c.enabled).length;

  // On failure show ONLY a retryable error — not the "No IdP configurations"
  // empty state layered under an error banner.
  if (roster.error) {
    return <RetryError message={formatError(roster.error, 'Failed to load IdP roster')} onRetry={load} />;
  }

  return (
    <>
      {!loading && configs.length > 0 && (
        <div className="mb-4 text-sm text-fg-muted">
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
  );
}
