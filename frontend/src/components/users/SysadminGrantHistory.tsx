// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { LoadingSpinner } from '@/components/ui/Loading';
import { Badge } from '@/components/ui/Badge';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { useFetch } from '@/hooks/useFetch';
import type { AuditLogEvent } from '@/types/audit';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';

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

  const read = useFetch<AuditLogEvent[]>(async (signal) => {
    if (!expanded) return [];
    const res = await api.listAuditEvents({
      targetId: userId,
      // Two actions to fetch; substring match against the regex filter.
      action: 'admin.superadmin',
      limit: 10,
    }, { signal });
    if (!res.success || !res.data) throw new Error(res.message || 'Failed to load grant history');
    return res.data.events;
  }, [userId, expanded]);
  const events = read.data ?? [];
  const loading = expanded && read.loading;
  const error = read.error ? formatError(read.error) : null;

  return (
    <div className="rounded-lg border border-default px-3 py-2 text-sm">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between text-left font-medium text-fg-muted"
      >
        <span>Platform-admin grant history {isSuperAdmin && <Badge color="red">currently granted</Badge>}</span>
        <span className="text-xs text-fg-muted">{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded && (
        <div className="mt-2">
          {loading && <LoadingSpinner size="sm" />}
          {error && <p className="text-xs text-danger">{error}</p>}
          {!loading && events.length === 0 && (
            <p className="text-xs text-fg-muted">No grant events on file.</p>
          )}
          {events.length > 0 && (
            <ul className="space-y-1.5 text-xs text-fg-muted">
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
                      <strong className="text-fg-muted">{verb}</strong>
                      {' '}by{' '}<code>{e.actorEmail || e.actorId}</code>
                      {source && <> · <code>{source}</code></>}
                    </span>
                    <span className="text-fg-subtle whitespace-nowrap">
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
