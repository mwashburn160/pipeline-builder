// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react';
import { LoadingSpinner } from '@/components/ui/Loading';
import { Badge } from '@/components/ui/Badge';
import { RelativeTime } from '@/components/ui/RelativeTime';
import type { AuditLogEvent } from '@/types/audit';
import api from '@/lib/api';

/**
 * Inline timeline of platform-admin grant/revoke events for a user. Queries
 * the audit log filtered to `targetId = userId + action LIKE
 * admin.superadmin.*`. Shows the most recent few entries with date,
 * action, and source ('admin-api' vs 'bootstrap-env').
 *
 * Renders nothing until expanded — keeps the modal lean for the common
 * case (non-sysadmin user edits).
 */
export function SysadminGrantHistory({ userId, isSuperAdmin }: { userId: string; isSuperAdmin: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [events, setEvents] = useState<AuditLogEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    setLoading(true);
    setError(null); // clear any prior error so it doesn't render during reload
    api.listAuditEvents({
      targetId: userId,
      // Two actions to fetch; substring match against the regex filter.
      action: 'admin.superadmin',
      limit: 10,
    }).then((res) => {
      if (cancelled) return;
      if (res.success && res.data) setEvents(res.data.events);
      else setError(res.message || 'Failed to load grant history');
    }).catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [userId, expanded]);

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2 text-sm">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between text-left font-medium text-gray-700 dark:text-gray-300"
      >
        <span>Platform-admin grant history {isSuperAdmin && <Badge color="red">currently granted</Badge>}</span>
        <span className="text-xs text-gray-500 dark:text-gray-400">{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded && (
        <div className="mt-2">
          {loading && <LoadingSpinner size="sm" />}
          {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
          {!loading && events.length === 0 && (
            <p className="text-xs text-gray-500 dark:text-gray-400">No grant events on file.</p>
          )}
          {events.length > 0 && (
            <ul className="space-y-1.5 text-xs text-gray-600 dark:text-gray-400">
              {events.map((e) => {
                const source = (e.details as { source?: string } | undefined)?.source;
                // Branch explicitly so a non-grant/non-revoke superadmin.* action
                // isn't mislabelled "Revoked".
                const verb = e.action.endsWith('.grant') ? 'Granted'
                  : e.action.endsWith('.revoke') ? 'Revoked'
                  : e.action;
                return (
                  <li key={e._id} className="flex items-baseline justify-between gap-2">
                    <span>
                      <strong className="text-gray-700 dark:text-gray-300">{verb}</strong>
                      {' '}by{' '}<code>{e.actorEmail || e.actorId}</code>
                      {source && <> · <code>{source}</code></>}
                    </span>
                    <span className="text-gray-500 dark:text-gray-500 whitespace-nowrap">
                      <RelativeTime value={e.createdAt} />
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
