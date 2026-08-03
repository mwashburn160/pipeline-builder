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
import { Activity, Search, ArrowLeft, Download, ShieldCheck, ShieldAlert, ShieldQuestion, Ban } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { SideDrawer } from '@/components/ui/SideDrawer';
import { Pagination } from '@/components/ui/Pagination';
import { CopyableId } from '@/components/ui/CopyableId';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { Button } from '@/components/ui/Button';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { formatError } from '@/lib/constants';
import { downloadCsv, downloadJsonl } from '@/lib/csv-export';
import { redactDetails } from '@/lib/redact';
import type { AuditLogEvent, AuditChainVerification } from '@/types/audit';
import api from '@/lib/api';

const DEFAULT_LIMIT = 50;

/** The action string for a denied-authorization audit event. */
const DENIED_ACTION = 'authz.denied';

export default function AuditPage() {
  const router = useRouter();
  const { isReady, user, isSuperAdmin } = useAuthGuard({ requireAdmin: true });
  const [selected, setSelected] = useState<AuditLogEvent | null>(null);

  // Hydrate filters from URL on first render. `action`, `actorId`,
  // `affectedOrgId` are deep-linkable from other admin pages.
  const [action, setAction] = useState<string>('');
  const [actorId, setActorId] = useState<string>('');
  const [affectedOrgId, setAffectedOrgId] = useState<string>('');
  const [requestId, setRequestId] = useState<string>('');
  const [outcome, setOutcome] = useState<'' | 'success' | 'failure'>('');
  // Target-type scope (e.g. pipeline / plugin / user). Empty = any target.
  const [targetType, setTargetType] = useState<string>('');
  // createdAt range bounds (ISO date strings from <input type="date">, or empty).
  const [from, setFrom] = useState<string>('');
  const [to, setTo] = useState<string>('');
  const [offset, setOffset] = useState(0);
  const [limit, setLimit] = useState(DEFAULT_LIMIT);

  useEffect(() => {
    if (!router.isReady) return;
    if (typeof router.query.action === 'string') setAction(router.query.action);
    if (typeof router.query.actorId === 'string') setActorId(router.query.actorId);
    // `affectedOrgId` is a sysadmin-only scope: the backend ignores it for
    // org-admins (they're forced to their own org), so hydrating it for a
    // non-sysadmin would render a banner asserting a scope that isn't in
    // effect. Gate the state on `isSuperAdmin` so it only exists when it bites.
    if (isSuperAdmin && typeof router.query.affectedOrgId === 'string') setAffectedOrgId(router.query.affectedOrgId);
    // `requestId` deep-links from "view related events" affordances; `outcome`
    // lets a dashboard panel link straight to failed logins.
    if (typeof router.query.requestId === 'string') setRequestId(router.query.requestId);
    if (router.query.outcome === 'success' || router.query.outcome === 'failure') setOutcome(router.query.outcome);
    if (typeof router.query.targetType === 'string') setTargetType(router.query.targetType);
    // createdAt range deep-links (e.g. "events since <incident time>").
    if (typeof router.query.from === 'string') setFrom(router.query.from);
    if (typeof router.query.to === 'string') setTo(router.query.to);
  }, [router.isReady, router.query, isSuperAdmin]);

  const [events, setEvents] = useState<AuditLogEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Hash-chain tamper-verify (sysadmin only). Runs against the org currently in
  // scope — the affected-org filter when set, else the sysadmin's own org.
  const verifyOrgId = affectedOrgId || user?.organizationId || '';
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<AuditChainVerification | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  const runVerify = async () => {
    if (!verifyOrgId) return;
    setVerifying(true);
    setVerifyResult(null);
    setVerifyError(null);
    try {
      const res = await api.verifyAuditChain(verifyOrgId);
      if (res.success && res.data) setVerifyResult(res.data);
      else setVerifyError(res.message || 'Failed to verify audit chain');
    } catch (e) {
      setVerifyError(formatError(e, 'Failed to verify audit chain'));
    } finally {
      setVerifying(false);
    }
  };

  // Reset any stale verify result when the org in scope changes.
  useEffect(() => { setVerifyResult(null); setVerifyError(null); }, [verifyOrgId]);

  const deniedActive = action === DENIED_ACTION;
  const toggleDenied = () => {
    setAction((prev) => (prev === DENIED_ACTION ? '' : DENIED_ACTION));
    setOffset(0);
  };

  const filters = useMemo(() => ({
    ...(action && { action }),
    ...(actorId && { actorId }),
    ...(requestId && { requestId }),
    ...(outcome && { outcome }),
    ...(targetType && { targetType }),
    ...(from && { from }),
    ...(to && { to }),
    // Org admins are forced to their own org by the backend; this filter
    // is sysadmin-only. UI still sends it, server ignores for non-sysadmins.
    ...(isSuperAdmin && affectedOrgId && { affectedOrgId }),
    offset,
    limit,
  }), [action, actorId, requestId, outcome, targetType, from, to, affectedOrgId, isSuperAdmin, offset, limit]);

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
      {/* Sysadmin-only: the affected-org scope is ignored by the backend for
          org-admins, so the banner (and its underlying state) is gated too. */}
      {isSuperAdmin && affectedOrgId && (
        <div className="mb-4">
          <button
            onClick={() => { setAffectedOrgId(''); setOffset(0); }}
            className="action-link inline-flex items-center gap-1 text-sm"
          >
            <ArrowLeft className="w-4 h-4" /> Clear org scope (showing events affecting org {affectedOrgId})
          </button>
        </div>
      )}

      {/* Hash-chain integrity verify — sysadmin only. Unobtrusive: a button
          plus an inline result badge sitting above the filters. */}
      {isSuperAdmin && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Button
            onClick={runVerify}
            disabled={verifying || !verifyOrgId}
            variant="secondary"
            className="inline-flex items-center gap-1.5"
            title={verifyOrgId
              ? `Verify the audit hash-chain for org ${verifyOrgId}`
              : 'No org in scope to verify'}
          >
            <ShieldCheck className="w-4 h-4" />
            {verifying ? 'Verifying…' : 'Verify integrity'}
          </Button>
          {verifyOrgId && (
            <span className="text-xs text-gray-500 dark:text-gray-400 inline-flex items-center gap-1">
              org <CopyableId value={verifyOrgId} size="sm" />
            </span>
          )}
          {verifyError && (
            <span className="inline-flex items-center gap-1 text-xs text-red-600 dark:text-red-400">
              <ShieldQuestion className="w-4 h-4" /> {verifyError}
            </span>
          )}
          {verifyResult && (verifyResult.ok ? (
            <Badge color="green">
              <span className="inline-flex items-center gap-1">
                <ShieldCheck className="w-3.5 h-3.5" />
                Chain intact ({verifyResult.count} event{verifyResult.count === 1 ? '' : 's'})
              </span>
            </Badge>
          ) : (
            <Badge color="red">
              <span className="inline-flex items-center gap-1">
                <ShieldAlert className="w-3.5 h-3.5" />
                TAMPER DETECTED — chain broken at {verifyResult.brokenAt ?? 'unknown'}
              </span>
            </Badge>
          ))}
        </div>
      )}

      <ErrorAlert message={error} className="mb-4" />

      {/* Quick filters */}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={toggleDenied}
          aria-pressed={deniedActive}
          className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
            deniedActive
              ? 'border-red-300 bg-red-50 text-red-700 dark:border-red-700 dark:bg-red-900/30 dark:text-red-300'
              : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'
          }`}
          title="Spotlight authz.denied events (probing / privilege-escalation attempts)"
        >
          <Ban className="w-3.5 h-3.5" />
          Denied attempts
        </button>
      </div>

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
        <input
          type="text"
          placeholder="Request id (correlation)"
          value={requestId}
          onChange={(e) => { setRequestId(e.target.value); setOffset(0); }}
          className="filter-input"
        />
        <select
          aria-label="Filter by outcome"
          value={outcome}
          onChange={(e) => { setOutcome(e.target.value as '' | 'success' | 'failure'); setOffset(0); }}
          className="filter-input"
        >
          <option value="">All outcomes</option>
          <option value="success">Success</option>
          <option value="failure">Failure</option>
        </select>
        <select
          aria-label="Filter by target type"
          value={targetType}
          onChange={(e) => { setTargetType(e.target.value); setOffset(0); }}
          className="filter-input"
        >
          <option value="">Any target type</option>
          <option value="pipeline">Pipeline</option>
          <option value="plugin">Plugin</option>
          <option value="user">User</option>
          <option value="organization">Organization</option>
          <option value="role">Role</option>
          <option value="invitation">Invitation</option>
          <option value="policy">Policy</option>
          <option value="rule">Rule</option>
          <option value="dashboard">Dashboard</option>
        </select>
        <label className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
          <span className="shrink-0">From</span>
          <input
            type="date"
            aria-label="Filter events created on or after"
            value={from}
            max={to || undefined}
            onChange={(e) => { setFrom(e.target.value); setOffset(0); }}
            className="filter-input"
          />
        </label>
        <label className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
          <span className="shrink-0">To</span>
          <input
            type="date"
            aria-label="Filter events created on or before"
            value={to}
            min={from || undefined}
            onChange={(e) => { setTo(e.target.value); setOffset(0); }}
            className="filter-input"
          />
        </label>
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
        <Card className="mt-2 overflow-hidden">
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
        </Card>
      )}

      {/* Export bar — only on the current page worth of events. The richer
          dashboard at /dashboard/observability/audit-activity is the right
          tool for whole-history exports; this is for ad-hoc filter dumps. */}
      {events.length > 0 && (
        <div className="mt-2 flex items-center justify-end gap-2 text-xs text-gray-500 dark:text-gray-400">
          <span>{events.length} event{events.length === 1 ? '' : 's'} on this page</span>
          <Button
            onClick={() => downloadCsv(
              events.map((e) => ({
                createdAt: e.createdAt,
                action: e.action,
                outcome: e.outcome ?? '',
                actorId: e.actorId,
                actorEmail: e.actorEmail ?? '',
                actorRole: e.actorRole ?? '',
                impersonatorId: e.impersonatorId ?? '',
                orgId: e.orgId ?? '',
                affectedOrgId: e.affectedOrgId ?? '',
                targetType: e.targetType ?? '',
                targetId: e.targetId ?? '',
                groupId: e.groupId ?? '',
                ip: e.ip ?? '',
                userAgent: e.userAgent ?? '',
                requestId: e.requestId ?? '',
                traceId: e.traceId ?? '',
                details: e.details ? JSON.stringify(redactDetails(e.details)) : '',
              })),
              ['createdAt', 'action', 'outcome', 'actorId', 'actorEmail', 'actorRole', 'impersonatorId', 'orgId', 'affectedOrgId', 'targetType', 'targetId', 'groupId', 'ip', 'userAgent', 'requestId', 'traceId', 'details'],
              `audit-page-${new Date().toISOString().slice(0, 10)}`,
            )}
            variant="secondary"
            className="inline-flex items-center gap-1"
            title="Export the current page of events as CSV"
          >
            <Download className="w-3.5 h-3.5" /> CSV
          </Button>
          <Button
            onClick={() => downloadJsonl(
              events.map((e) => (e.details ? { ...e, details: redactDetails(e.details) } : e)),
              `audit-page-${new Date().toISOString().slice(0, 10)}`,
            )}
            variant="secondary"
            className="inline-flex items-center gap-1"
            title="Export the current page as JSON Lines (preserves nested details)"
          >
            <Download className="w-3.5 h-3.5" /> JSONL
          </Button>
        </div>
      )}

      {/* Results */}
      <Card className="mt-2 overflow-hidden">
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
                className="group px-4 py-3 text-sm cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/50 focus:bg-gray-50 dark:focus:bg-gray-800/50 focus:outline-none transition-colors"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="inline-flex items-center gap-1.5 min-w-0">
                    <code className="text-xs font-medium text-blue-600 dark:text-blue-400 underline decoration-dotted underline-offset-2 group-hover:decoration-solid">{event.action}</code>
                    {event.outcome === 'failure' && <Badge color="red">failed</Badge>}
                  </span>
                  <span className="text-xs text-gray-500 dark:text-gray-400 shrink-0">
                    <RelativeTime value={event.createdAt} />
                  </span>
                </div>
                <div className="mt-1 text-xs text-gray-600 dark:text-gray-400 flex flex-wrap gap-x-3 gap-y-1 items-center">
                  <span className="inline-flex items-center gap-1">
                    Actor: <CopyableId value={event.actorId} display={event.actorEmail || event.actorId} size="sm" />
                    {event.actorRole && <span className="text-gray-400 dark:text-gray-500">({event.actorRole})</span>}
                  </span>
                  {event.impersonatorId && (
                    <span className="inline-flex items-center gap-1">via <CopyableId value={event.impersonatorId} size="sm" /></span>
                  )}
                  {event.orgId && <span className="inline-flex items-center gap-1">Org: <CopyableId value={event.orgId} size="sm" /></span>}
                  {event.affectedOrgId && event.affectedOrgId !== event.orgId && (
                    <span className="inline-flex items-center gap-1">Affected: <CopyableId value={event.affectedOrgId} size="sm" /></span>
                  )}
                  {event.targetType && (
                    <span className="inline-flex items-center gap-1">
                      Target: <code>{event.targetType}</code>
                      {event.targetId && <>: <CopyableId value={event.targetId} size="sm" /></>}
                    </span>
                  )}
                  {event.ip && <span>IP: <code>{event.ip}</code></span>}
                  {event.requestId && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setRequestId(event.requestId!); setOffset(0); }}
                      className="inline-flex items-center gap-1 hover:underline"
                      title="Filter to this request's correlation id"
                    >
                      Req: <code>{event.requestId.slice(0, 8)}</code>
                    </button>
                  )}
                </div>
                {event.details && Object.keys(event.details).length > 0 && (
                  <p className="mt-1 text-xs text-gray-400 dark:text-gray-500 font-mono truncate">
                    {JSON.stringify(redactDetails(event.details))}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      {total > limit && (
        <div className="mt-3">
          <Pagination
            pagination={{ total, offset, limit }}
            onPageChange={(nextOffset) => setOffset(nextOffset)}
            onPageSizeChange={(size) => { setLimit(size); setOffset(0); }}
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
            <dt className="text-gray-500 dark:text-gray-400">Outcome</dt>
            <dd>{selected.outcome === 'failure'
              ? <Badge color="red">failure</Badge>
              : selected.outcome === 'success'
                ? <Badge color="green">success</Badge>
                : <Badge color="gray">unknown</Badge>}</dd>
            <dt className="text-gray-500 dark:text-gray-400">Actor</dt>
            <dd className="text-gray-900 dark:text-gray-100 inline-flex items-center gap-1 min-w-0">
              <span className="truncate">{selected.actorEmail || selected.actorId}</span>
              {selected.actorRole && <span className="text-gray-400 dark:text-gray-500">({selected.actorRole})</span>}
              <CopyableId value={selected.actorId} size="sm" />
            </dd>
            {selected.impersonatorId && (<><dt className="text-gray-500 dark:text-gray-400">Impersonator</dt><dd><CopyableId value={selected.impersonatorId} size="sm" /></dd></>)}
            {selected.orgId && (<><dt className="text-gray-500 dark:text-gray-400">Org</dt><dd><CopyableId value={selected.orgId} size="sm" /></dd></>)}
            {selected.affectedOrgId && (<><dt className="text-gray-500 dark:text-gray-400">Affected org</dt><dd><CopyableId value={selected.affectedOrgId} size="sm" /></dd></>)}
            {selected.targetType && (
              <>
                <dt className="text-gray-500 dark:text-gray-400">Target</dt>
                <dd className="inline-flex items-center gap-1"><code className="text-xs">{selected.targetType}</code>{selected.targetId && <><span>:</span><CopyableId value={selected.targetId} size="sm" /></>}</dd>
              </>
            )}
            {selected.groupId && (<><dt className="text-gray-500 dark:text-gray-400">Group</dt><dd><CopyableId value={selected.groupId} size="sm" /></dd></>)}
            {selected.ip && (<><dt className="text-gray-500 dark:text-gray-400">IP</dt><dd><code className="text-xs">{selected.ip}</code></dd></>)}
            {selected.userAgent && (<><dt className="text-gray-500 dark:text-gray-400">User agent</dt><dd className="text-xs text-gray-700 dark:text-gray-300 break-all">{selected.userAgent}</dd></>)}
            {selected.requestId && (<><dt className="text-gray-500 dark:text-gray-400">Request id</dt><dd><CopyableId value={selected.requestId} size="sm" /></dd></>)}
            {selected.traceId && (<><dt className="text-gray-500 dark:text-gray-400">Trace id</dt><dd><CopyableId value={selected.traceId} size="sm" /></dd></>)}
          </dl>
          {selected.details && Object.keys(selected.details).length > 0 && (
            <div className="mt-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-2">Details</p>
              <pre className="text-xs font-mono bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded p-3 whitespace-pre-wrap break-all max-h-96 overflow-y-auto">{JSON.stringify(redactDetails(selected.details), null, 2)}</pre>
            </div>
          )}
        </SideDrawer>
      )}
    </DashboardLayout>
  );
}
