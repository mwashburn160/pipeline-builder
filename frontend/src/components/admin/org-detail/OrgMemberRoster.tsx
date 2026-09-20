// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { Users } from 'lucide-react';
import api from '@/lib/api';
import { useFetch } from '@/hooks/useFetch';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/Loading';
import { Pagination } from '@/components/ui/Pagination';
import { RetryError } from '@/components/ui/RetryError';
import { RelativeTime } from '@/components/ui/RelativeTime';

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
  const [limit, setLimit] = useState(25);
  const [offset, setOffset] = useState(0);

  const { data, loading, error, refetch } = useFetch(
    async (signal) => {
      const res = await api.getOrganization(orgId, { membersLimit: limit, membersOffset: offset }, { signal });
      return { members: res.data?.members ?? [], total: res.data?.memberCount ?? 0 };
    },
    [orgId, limit, offset],
  );

  const members = data?.members ?? [];
  const total = data?.total ?? 0;

  return (
    <Card>
      <div className="flex items-center gap-2 mb-3">
        <Users className="w-5 h-5 text-fg-muted" />
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">Members</h3>
        {data && <span className="text-sm text-fg-muted">({total})</span>}
      </div>

      {error ? (
        <RetryError message={error.message || 'Failed to load the member roster'} onRetry={refetch} />
      ) : loading && !data ? (
        <LoadingSpinner />
      ) : total === 0 ? (
        <EmptyState icon={Users} title="No members" description="This organization has no members yet." />
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-fg-muted">
                  <th className="py-2 pr-4 font-medium">Member</th>
                  <th className="py-2 pr-4 font-medium">Role</th>
                  <th className="py-2 font-medium">Joined</th>
                </tr>
              </thead>
              <tbody className={`divide-y divide-gray-100 dark:divide-gray-800 ${loading ? 'opacity-60' : ''}`}>
                {members.map((m) => (
                  <tr key={m._id}>
                    <td className="py-2 pr-4">
                      <div className="font-medium text-gray-900 dark:text-gray-100">{m.username || '—'}</div>
                      <div className="text-xs text-fg-muted">{m.email || ''}</div>
                    </td>
                    <td className="py-2 pr-4"><Badge color={ROLE_COLOR[m.role] ?? 'gray'}>{m.role}</Badge></td>
                    <td className="py-2 text-fg-muted">
                      {m.joinedAt ? <RelativeTime value={m.joinedAt} /> : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            pagination={{ limit, offset, total }}
            onPageChange={setOffset}
            onPageSizeChange={(next) => { setLimit(next); setOffset(0); }}
          />
        </>
      )}
    </Card>
  );
}
