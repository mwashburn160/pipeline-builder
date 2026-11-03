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
import { usePagination } from '@/hooks/usePagination';
import { formatError } from '@/lib/constants';
import type { BadgeColor } from '@/components/ui/Badge';
import type { BillingEvent } from '@/types';

interface BillingHistoryProps {
  isSuperAdmin: boolean;
}

/** Billing history events, paged on the server. Sysadmins see the fleet-wide
 *  feed via `/admin/events` (with the org column); everyone else sees their OWN
 *  account via `/events` (billing:read) rather than a 403 off the admin route.
 *  Loaded on demand ("View events"), since most visits never open it. */
export function BillingHistory({ isSuperAdmin }: BillingHistoryProps) {
  const [open, setOpen] = useState(false);
  const page = usePagination();

  const { data, loading, error, refetch } = useFetch(async (signal) => {
    if (!open) return null;
    const query = { offset: page.offset, limit: page.limit };
    const res = isSuperAdmin
      ? await api.listBillingEvents(query, { signal })
      : await api.listOwnBillingEvents(query, { signal });
    return { events: res.data?.events ?? [], total: res.data?.total ?? 0 };
  }, [open, isSuperAdmin, page.offset, page.limit]);

/**
 * Human label and colour for a billing event type.
 *
 * The type rendered raw (`discount_floor_clamped`) is readable by whoever wrote
 * the backend and nobody else, and every type looked identical — so the two
 * events that mean "a credit was reduced or refused" sat in a blue badge beside
 * the routine ones. An unlisted type falls back to its raw id, so a new backend
 * event degrades to the old behaviour instead of rendering blank.
 */
const EVENT_LABELS: Record<string, { label: string; color: BadgeColor }> = {
  credit_applied: { label: 'Credit applied', color: 'green' },
  credit_consumed: { label: 'Credit consumed', color: 'blue' },
  credit_exhausted: { label: 'Credit exhausted', color: 'gray' },
  discount_generated: { label: 'Discount minted', color: 'blue' },
  discount_issued: { label: 'Code issued', color: 'blue' },
  discount_applied: { label: 'Discount applied', color: 'green' },
  discount_removed: { label: 'Discount removed', color: 'gray' },
  discount_expired: { label: 'Discount expired', color: 'gray' },
  discount_revoked: { label: 'Discount revoked', color: 'red' },
  // The two that say a credit did NOT land in full. Called out in yellow
  // because this is the line support needs when a customer asks why their
  // discount got smaller.
  discount_floor_clamped: { label: 'Discount reduced (discount floor)', color: 'yellow' },
  promotion_floor_refused: { label: 'Promotion refused (discount floor)', color: 'yellow' },
  promotion_granted: { label: 'Promotion granted', color: 'green' },
  combo_expired: { label: 'Bundle combo expired', color: 'gray' },
};

  const columns: Column<BillingEvent>[] = [
    { id: 'when', header: 'When', render: (evt) => <RelativeTime value={evt.createdAt} /> },
    {
      id: 'type',
      header: 'Type',
      render: (evt) => {
        const known = EVENT_LABELS[evt.type];
        return <Badge color={known?.color ?? 'blue'}>{known?.label ?? evt.type}</Badge>;
      },
    },
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
              pagination={page.withTotal(data.total)}
              onPageChange={page.setOffset}
              onPageSizeChange={page.setLimit}
            />
          )}
        </>
      ))}
    </div>
  );
}
