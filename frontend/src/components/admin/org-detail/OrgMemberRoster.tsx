// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Users } from 'lucide-react';
import api from '@/lib/api';
import { useFetch } from '@/hooks/useFetch';
import { usePagination } from '@/hooks/usePagination';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Pagination } from '@/components/ui/Pagination';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { DataTable, type Column } from '@/components/ui/DataTable';

const ROLE_COLOR = { owner: 'purple', admin: 'blue', member: 'gray' } as const;

/**
 * The org's member roster, paged server-side.
 *
 * `GET /organization/:id` embeds one page of the roster (`membersLimit` /
 * `membersOffset`, oldest member first) alongside `memberCount`, the full
 * total — so the sysadmin can see WHO is in the org, not just how many, without
 * a second endpoint. Each page is its own read; the page shell's org read asks
 * for a one-member roster and leaves the list to this card.
 */
export function OrgMemberRoster({ orgId }: { orgId: string }) {
  const page = usePagination();

  const { data, loading, error, refetch } = useFetch(
    async (signal) => {
      const res = await api.getOrganization(orgId, { membersLimit: page.limit, membersOffset: page.offset }, { signal });
      return { members: res.data?.members ?? [], total: res.data?.memberCount ?? 0 };
    },
    [orgId, page.limit, page.offset],
  );

  const members = data?.members ?? [];
  const pagination = page.withTotal(data?.total ?? 0);
  const total = pagination.total;

  const columns: Column<(typeof members)[number]>[] = [
    {
      id: 'member',
      header: 'Member',
      render: (m) => (
        <>
          <div className="font-medium text-fg">{m.username || '—'}</div>
          <div className="text-xs text-fg-muted">{m.email || ''}</div>
        </>
      ),
    },
    { id: 'role', header: 'Role', render: (m) => <Badge color={ROLE_COLOR[m.role] ?? 'gray'}>{m.role}</Badge> },
    {
      id: 'joined',
      header: 'Joined',
      cellClassName: 'text-fg-muted',
      render: (m) => (m.joinedAt ? <RelativeTime value={m.joinedAt} /> : '—'),
    },
  ];

  return (
    <Card>
      <div className="flex items-center gap-2 mb-3">
        <Users className="w-5 h-5 text-fg-muted" />
        <h3 className="text-base font-semibold text-fg">Members</h3>
        {data && <span className="text-sm text-fg-muted">({total})</span>}
      </div>

      <DataTable
        data={members}
        columns={columns}
        isLoading={loading && !data}
        animated={false}
        getRowKey={(m) => m._id}
        loadFailed={!!error}
        onRetry={refetch}
        emptyState={{ icon: Users, title: 'No members', description: 'This organization has no members yet.' }}
      />
      {total > 0 && (
        <Pagination
          pagination={pagination}
          onPageChange={page.setOffset}
          onPageSizeChange={page.setLimit}
        />
      )}
    </Card>
  );
}
