// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { Button } from '@/components/ui/Button';

interface BillingHistoryProps {
  isSuperAdmin: boolean;
  showEvents: boolean;
  billingEvents: Array<{ id: string; type: string; orgId: string; createdAt: string; detail?: Record<string, unknown> }>;
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
  return (    <div className="mt-8">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Billing history</h2>
        {!showEvents && (                <Button variant="secondary" size="sm" onClick={onViewEvents}>View events</Button>
        )}
      </div>
      {showEvents && billingEvents.length > 0 && (              <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 dark:bg-gray-800/50">
                <th className="px-4 py-2.5 text-left font-medium text-gray-700 dark:text-gray-300">When</th>
                <th className="px-4 py-2.5 text-left font-medium text-gray-700 dark:text-gray-300">Type</th>
                {isSuperAdmin && (
                  <th className="px-4 py-2.5 text-left font-medium text-gray-700 dark:text-gray-300">Organization</th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
              {billingEvents.map((evt) => (                      <tr key={evt.id}>
                  <td className="px-4 py-2 text-gray-500 dark:text-gray-400"><RelativeTime value={evt.createdAt} /></td>
                  <td className="px-4 py-2"><Badge color="blue">{evt.type}</Badge></td>
                  {isSuperAdmin && (
                    <td className="px-4 py-2 text-gray-500 dark:text-gray-400 font-mono text-xs">{evt.orgId}</td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {showEvents && billingEvents.length === 0 && (
        <Card className="py-6 text-center text-sm text-gray-500 dark:text-gray-400">
          No billing events recorded for this organization.
        </Card>
      )}
    </div>
  );
}
