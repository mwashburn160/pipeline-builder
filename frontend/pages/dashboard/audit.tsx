// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Sysadmin audit log surface.
 *
 * The `Audit Activity` DB-stored dashboard remains for richer query-builder
 * UX (under /dashboard/observability/audit-activity). This focused page
 * supports the three new sysadmin filters operators reach for most:
 *   - `action`      — exact or partial match against the AuditAction vocab
 *   - `actorId`     — "what did user X do"
 *   - `affectedOrgId` — "what was done TO org X" (independent of who did it)
 *
 * URL params drive the initial filter state, so deep-links from other
 * admin surfaces (org-detail "View audit log" button) land here with the
 * right scope.
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { Activity, Search, ArrowLeft, Download } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { Badge } from '@/components/ui/Badge';
import { SideDrawer } from '@/components/ui/SideDrawer';
import { Pagination } from '@/components/ui/Pagination';
import { CopyableId } from '@/components/ui/CopyableId';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { formatError } from '@/lib/constants';
import { downloadCsv, downloadJsonl } from '@/lib/csv-export';
import api from '@/lib/api';

interface AuditEvent {
  _id: string;
  action: string;
  actorId: string;
  actorEmail?: string;
  orgId?: string;
  affectedOrgId?: string;
  targetType?: string;
  targetId?: string;
  details?: Record<string, unknown>;
  ip?: string;
  createdAt: string;
}

const LIMIT = 50;

export default function AuditPage() {
  const router = useRouter();
  const { isReady, user, isSuperAdmin } = useAuthGuard({ requireAdmin: true });
  const [selected, setSelected] = useState<AuditEvent | null>(null);

  // Hydrate filters from URL on first render. `action`, `actorId`,
  // `affectedOrgId` are deep-linkable from other admin pages.
  const [action, setAction] = useState<string>('');
  const [actorId, setActorId] = useState<string>('');
  const [affectedOrgId, setAffectedOrgId] = useState<string>('');
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    if (!router.isReady) return;
    if (typeof router.query.action === 'string') setAction(router.query.action);
    if (typeof router.query.actorId === 'string') setActorId(router.query.actorId);
    if (typeof router.query.affectedOrgId === 'string') setAffectedOrgId(router.query.affectedOrgId);
  }, [router.isReady, router.query]);

  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filters = useMemo(() => ({
    ...(action && { action }),
    ...(actorId && { actorId }),
    // Org admins are forced to their own org by the backend; this filter
    // is sysadmin-only. UI still sends it, server ignores for non-sysadmins.
    ...(isSuperAdmin && affectedOrgId && { affectedOrgId }),
    offset,
    limit: LIMIT,
  }), [action, actorId, affectedOrgId, isSuperAdmin, offset]);

  useEffect(() => {
    if (!isReady) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.listAuditEvents(filters).then((res) => {
      if (cancelled) return;
      if (res.success && res.data) {
        setEvents(res.data.events);
        setTotal(res.data.pagination.total);
      } else {
        setError(res.message || 'Failed to load audit events');
      }
    }).catch((e) => !cancelled && setError(formatError(e, 'Failed to load audit events')))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [isReady, filters]);

  if (!isReady || !user) return <LoadingPage />;

  return (
    <DashboardLayout
      title="Audit log"
      subtitle="System-wide action history"
      titleExtra={isSuperAdmin ? <Badge color="red">System Admin</Badge> : <Badge color="purple">Org Admin</Badge>}
    >
      {affectedOrgId && (
        <div className="mb-4">
          <button
            onClick={() => { setAffectedOrgId(''); setOffset(0); }}
            className="action-link inline-flex items-center gap-1 text-sm"
          >
            <ArrowLeft className="w-4 h-4" /> Clear org scope (showing events affecting org {affectedOrgId})
          </button>
        </div>
      )}

      {error && (
        <div className="alert-error mb-4">
          <p>{error}</p>
        </div>
      )}

      {/* Filter bar */}
      <div className="filter-bar grid grid-cols-1 md:grid-cols-3 gap-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-gray-500" />
          <input
            type="text"
            placeholder="Filter by action (substring match)"
            value={action}
            onChange={(e) => { setAction(e.target.value); setOffset(0); }}
            className="filter-input"
          />
        </div>
        <input
          type="text"
          placeholder="Actor user id"
          value={actorId}
          onChange={(e) => { setActorId(e.target.value); setOffset(0); }}
          className="filter-input"
        />
        {isSuperAdmin && (
          <input
            type="text"
            placeholder="Affected org id (sysadmin filter)"
            value={affectedOrgId}
            onChange={(e) => { setAffectedOrgId(e.target.value); setOffset(0); }}
            className="filter-input"
          />
        )}
      </div>

      {loading && (
        <div className="card mt-2 overflow-hidden">
          <div className="divide-y divide-gray-200 dark:divide-gray-700">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="px-4 py-3">
                <div className="flex items-baseline justify-between gap-2 mb-1.5">
                  <div className="h-3 skeleton w-1/4" />
                  <div className="h-3 skeleton w-16" />
                </div>
                <div className="h-3 skeleton w-2/3" />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Export bar — only on the current page worth of events. The richer
          dashboard at /dashboard/observability/audit-activity is the right
          tool for whole-history exports; this is for ad-hoc filter dumps. */}
      {events.length > 0 && (
        <div className="mt-2 flex items-center justify-end gap-2 text-xs text-gray-500 dark:text-gray-400">
          <span>{events.length} event{events.length === 1 ? '' : 's'} on this page</span>
          <button
            onClick={() => downloadCsv(
              events.map((e) => ({
                createdAt: e.createdAt,
                action: e.action,
                actorId: e.actorId,
                actorEmail: e.actorEmail ?? '',
                orgId: e.orgId ?? '',
                affectedOrgId: e.affectedOrgId ?? '',
                targetType: e.targetType ?? '',
                targetId: e.targetId ?? '',
                ip: e.ip ?? '',
                details: e.details ? JSON.stringify(e.details) : '',
              })),
              ['createdAt', 'action', 'actorId', 'actorEmail', 'orgId', 'affectedOrgId', 'targetType', 'targetId', 'ip', 'details'],
              `audit-page-${new Date().toISOString().slice(0, 10)}`,
            )}
            className="btn btn-secondary inline-flex items-center gap-1"
            title="Export the current page of events as CSV"
          >
            <Download className="w-3.5 h-3.5" /> CSV
          </button>
          <button
            onClick={() => downloadJsonl(events, `audit-page-${new Date().toISOString().slice(0, 10)}`)}
            className="btn btn-secondary inline-flex items-center gap-1"
            title="Export the current page as JSON Lines (preserves nested details)"
          >
            <Download className="w-3.5 h-3.5" /> JSONL
          </button>
        </div>
      )}

      {/* Results */}
      <div className="card mt-2 overflow-hidden">
        {events.length === 0 && !loading ? (
          <div className="px-4 py-8 text-center text-sm text-gray-500 dark:text-gray-400">
            <Activity className="w-8 h-8 mx-auto mb-2 opacity-50" />
            No matching audit events.
          </div>
        ) : (
          <div className="divide-y divide-gray-200 dark:divide-gray-700">
            {events.map((event) => (
              <div
                key={event._id}
                role="button"
                tabIndex={0}
                onClick={() => setSelected(event)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelected(event); } }}
                aria-label={`View audit event: ${event.action}`}
                className="px-4 py-3 text-sm cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/50 focus:bg-gray-50 dark:focus:bg-gray-800/50 focus:outline-none transition-colors"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <code className="text-xs font-medium text-blue-700 dark:text-blue-300">{event.action}</code>
                  <span className="text-xs text-gray-500 dark:text-gray-400 shrink-0">
                    <RelativeTime value={event.createdAt} />
                  </span>
                </div>
                <div className="mt-1 text-xs text-gray-600 dark:text-gray-400 flex flex-wrap gap-x-3 gap-y-1 items-center">
                  <span className="inline-flex items-center gap-1">Actor: <CopyableId value={event.actorId} display={event.actorEmail || event.actorId} small /></span>
                  {event.orgId && <span className="inline-flex items-center gap-1">Org: <CopyableId value={event.orgId} small /></span>}
                  {event.affectedOrgId && event.affectedOrgId !== event.orgId && (
                    <span className="inline-flex items-center gap-1">Affected: <CopyableId value={event.affectedOrgId} small /></span>
                  )}
                  {event.targetType && (
                    <span className="inline-flex items-center gap-1">
                      Target: <code>{event.targetType}</code>
                      {event.targetId && <>: <CopyableId value={event.targetId} small /></>}
                    </span>
                  )}
                  {event.ip && <span>IP: <code>{event.ip}</code></span>}
                </div>
                {event.details && Object.keys(event.details).length > 0 && (
                  <p className="mt-1 text-xs text-gray-400 dark:text-gray-500 font-mono truncate">
                    {JSON.stringify(event.details)}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {total > LIMIT && (
        <div className="mt-3">
          <Pagination
            pagination={{ total, offset, limit: LIMIT }}
            onPageChange={(nextOffset) => setOffset(nextOffset)}
            onPageSizeChange={() => undefined}
          />
        </div>
      )}

      <div className="mt-4 text-xs text-gray-500 dark:text-gray-400">
        For richer query-builder views, use the{' '}
        <Link href="/dashboard/observability/audit-activity" className="action-link">Audit Activity dashboard</Link>.
      </div>

      {selected && (
        <SideDrawer
          ariaLabel="Audit event details"
          onClose={() => setSelected(null)}
          title={selected.action}
          subtitle={<span className="tabular-nums">{new Date(selected.createdAt).toLocaleString()}</span>}
        >
          <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-2 text-sm">
            <dt className="text-gray-500 dark:text-gray-400">Actor</dt>
            <dd className="text-gray-900 dark:text-gray-100 inline-flex items-center gap-1 min-w-0">
              <span className="truncate">{selected.actorEmail || selected.actorId}</span>
              <CopyableId value={selected.actorId} small />
            </dd>
            {selected.orgId && (<><dt className="text-gray-500 dark:text-gray-400">Org</dt><dd><CopyableId value={selected.orgId} small /></dd></>)}
            {selected.affectedOrgId && (<><dt className="text-gray-500 dark:text-gray-400">Affected org</dt><dd><CopyableId value={selected.affectedOrgId} small /></dd></>)}
            {selected.targetType && (
              <>
                <dt className="text-gray-500 dark:text-gray-400">Target</dt>
                <dd className="inline-flex items-center gap-1"><code className="text-xs">{selected.targetType}</code>{selected.targetId && <><span>:</span><CopyableId value={selected.targetId} small /></>}</dd>
              </>
            )}
            {selected.ip && (<><dt className="text-gray-500 dark:text-gray-400">IP</dt><dd><code className="text-xs">{selected.ip}</code></dd></>)}
          </dl>
          {selected.details && Object.keys(selected.details).length > 0 && (
            <div className="mt-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-2">Details</p>
              <pre className="text-xs font-mono bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded p-3 whitespace-pre-wrap break-all max-h-96 overflow-y-auto">{JSON.stringify(selected.details, null, 2)}</pre>
            </div>
          )}
        </SideDrawer>
      )}
    </DashboardLayout>
  );
}
