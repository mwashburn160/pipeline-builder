// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Receipt } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { Button } from '@/components/ui/Button';
import { DataTable, type Column } from '@/components/ui/DataTable';

type BillingEvent = { id: string; type: string; orgId: string; createdAt: string; detail?: Record<string, unknown> };

interface BillingHistoryProps {
  isSuperAdmin: boolean;
  showEvents: boolean;
  billingEvents: BillingEvent[];
  onViewEvents: () => void;
}

/** Billing history. Sysadmins see the fleet-wide feed via `/admin/events`;
 *  everyone else sees their OWN account via `/events` (a separate endpoint —
 *  see `fetchEvents` in billing.tsx, which picks the route by `isSuperAdmin`).
 *  Quietly degrades to an empty section if the backend rejects. */
export function BillingHistory({
  isSuperAdmin,
  showEvents,
  billingEvents,
  onViewEvents,
}: BillingHistoryProps) {
  const columns: Column<BillingEvent>[] = [
    { id: 'when', header: 'When', render: (evt) => <RelativeTime value={evt.createdAt} /> },
    { id: 'type', header: 'Type', render: (evt) => <Badge color="blue">{evt.type}</Badge> },
    ...(isSuperAdmin
      ? [{
          id: 'org',
          header: 'Organization',
          cellClassName: 'font-mono text-xs text-gray-500 dark:text-gray-400',
          render: (evt: BillingEvent) => evt.orgId,
        }]
      : []),
  ];

  return (    <div className="mt-8">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Billing history</h2>
        {!showEvents && (                <Button variant="secondary" size="sm" onClick={onViewEvents}>View events</Button>
        )}
      </div>
      {showEvents && (              <Card className="overflow-hidden">
          <DataTable
            data={billingEvents}
            columns={columns}
            isLoading={false}
            getRowKey={(evt) => evt.id}
            emptyState={{
              icon: Receipt,
              title: 'No billing events',
              description: 'No billing events recorded for this organization.',
            }}
          />
        </Card>
      )}
    </div>
  );
}
