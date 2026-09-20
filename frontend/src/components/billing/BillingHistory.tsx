// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { Receipt } from 'lucide-react';
import api from '@/lib/api';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { Button } from '@/components/ui/Button';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Pagination } from '@/components/ui/Pagination';
import { RetryError } from '@/components/ui/RetryError';
import { useFetch } from '@/hooks/useFetch';
import { formatError } from '@/lib/constants';
import type { BillingEvent } from '@/types';

const DEFAULT_PAGE_SIZE = 25;

interface BillingHistoryProps {
  isSuperAdmin: boolean;
}

/** Billing history events, paged on the server. Sysadmins see the fleet-wide
 *  feed via `/admin/events` (with the org column); everyone else sees their OWN
 *  account via `/events` (billing:read) rather than a 403 off the admin route.
 *  Loaded on demand ("View events"), since most visits never open it. */
export function BillingHistory({ isSuperAdmin }: BillingHistoryProps) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState({ offset: 0, limit: DEFAULT_PAGE_SIZE });

  const { data, loading, error, refetch } = useFetch(async (signal) => {
    if (!open) return null;
    const res = isSuperAdmin
      ? await api.listBillingEvents(page, { signal })
      : await api.listOwnBillingEvents(page, { signal });
    return { events: res.data?.events ?? [], total: res.data?.total ?? 0 };
  }, [open, isSuperAdmin, page.offset, page.limit]);

  const columns: Column<BillingEvent>[] = [
    { id: 'when', header: 'When', render: (evt) => <RelativeTime value={evt.createdAt} /> },
    { id: 'type', header: 'Type', render: (evt) => <Badge color="blue">{evt.type}</Badge> },
    ...(isSuperAdmin
      ? [{
          id: 'org',
          header: 'Organization',
          cellClassName: 'font-mono text-xs text-fg-muted',
          render: (evt: BillingEvent) => evt.orgId,
        }]
      : []),
  ];

  return (
    <div className="mt-8">
      <div className="flex items-center justify-between mb-4">
        <h2 className="h2">Billing history</h2>
        {!open && (
          <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>View events</Button>
        )}
      </div>
      {open && (error ? (
        <RetryError message={formatError(error, 'Failed to load billing events')} onRetry={refetch} />
      ) : (
        <>
          <Card className="overflow-hidden">
            <DataTable
              data={data?.events ?? []}
              columns={columns}
              isLoading={loading}
              getRowKey={(evt) => evt.id}
              emptyState={{
                icon: Receipt,
                title: 'No billing events',
                description: 'No billing events recorded for this organization.',
              }}
            />
          </Card>
          {!!data && data.total > page.limit && (
            <Pagination
              pagination={{ ...page, total: data.total }}
              onPageChange={(offset) => setPage((p) => ({ ...p, offset }))}
              onPageSizeChange={(limit) => setPage({ offset: 0, limit })}
            />
          )}
        </>
      ))}
    </div>
  );
}
