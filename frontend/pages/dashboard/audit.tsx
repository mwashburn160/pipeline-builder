// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Audit log surface (org admins see their own org; sysadmins the fleet).
 *
 * The `Audit Activity` DB-stored dashboard remains for richer query-builder
 * UX (under /dashboard/observability/audit-activity). This focused page
 * filters on every field `GET /audit` accepts:
 *   - `action`        — exact or partial match against the AuditAction vocab
 *   - `actorId`       — "what did user X do"
 *   - `impersonatorId` — "what was done while operator X was viewing as someone"
 *   - `targetType` / `targetId` — "what happened to this pipeline / user / …"
 *   - `groupId`       — every event of one grouped operation (a bulk action)
 *   - `requestId`, `outcome`, `from` / `to`
 *   - sysadmin only: `orgId` ("what org X's people did") and `affectedOrgId`
 *     ("what was done TO org X"). The backend pins an org admin to their own
 *     org, so those two are never offered to one.
 *
 * Every filter is a URL param, so deep-links from other surfaces (org-detail
 * "View audit log") land with the right scope, and the ids on each row are
 * buttons that narrow the list to that actor / impersonator / target / group.
 */

import { Select } from '@/components/ui/Select';
import { SearchInput } from '@/components/ui/SearchInput';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { Activity, ArrowLeft, Download, ShieldCheck, ShieldAlert, ShieldQuestion, Ban, SlidersHorizontal, ChevronDown, X } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useFetch } from '@/hooks/useFetch';
import { useQuery } from '@/hooks/useQuery';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { SideDrawer } from '@/components/ui/SideDrawer';
import { Pagination } from '@/components/ui/Pagination';
import { CopyableId } from '@/components/ui/CopyableId';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { Button } from '@/components/ui/Button';
import { FilterInput } from '@/components/ui/FilterInput';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { formatError } from '@/lib/constants';
import { downloadCsv, downloadJsonl, datedFilename } from '@/lib/csv-export';
import { redactDetails } from '@/lib/redact';
import type { AuditLogEvent, AuditChainVerification } from '@/types/audit';
import api from '@/lib/api';
import { queries } from '@/lib/api-cache';
import { formatDateTime } from '@/lib/format';

const DEFAULT_LIMIT = 50;

/** The action string for a denied-authorization audit event. */
const DENIED_ACTION = 'authz.denied';

/** A row id rendered as a button that narrows the list to it. */
function FilterChip({ label, value, onFilter, title, children }: {
  label: string;
  value: string;
  onFilter: () => void;
  title: string;
  children?: ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onFilter(); }}
        className="hover:underline hover:text-fg"
        title={title}
      >
        {label}
      </button>
      {children ?? <CopyableId value={value} size="sm" />}
    </span>
  );
}

export default function AuditPage() {
  const router = useRouter();
  const { accessDenied, isReady, user, isSuperAdmin } = useAuthGuard();
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
  const [targetId, setTargetId] = useState<string>('');
  const [impersonatorId, setImpersonatorId] = useState<string>('');
  const [groupId, setGroupId] = useState<string>('');
  // "What org X's people did" — sysadmin only (org admins are pinned server-side).
  const [orgId, setOrgId] = useState<string>('');
  // createdAt range bounds (ISO date strings from <input type="date">, or empty).
  const [from, setFrom] = useState<string>('');
  const [to, setTo] = useState<string>('');
  const [offset, setOffset] = useState(0);
  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  // The full filter panel is collapsed by default to reclaim vertical space;
  // an active-filter count badge on the toggle signals when filters are on.
  const [filtersOpen, setFiltersOpen] = useState(false);

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
    if (typeof router.query.targetId === 'string') setTargetId(router.query.targetId);
    if (typeof router.query.impersonatorId === 'string') setImpersonatorId(router.query.impersonatorId);
    if (typeof router.query.groupId === 'string') setGroupId(router.query.groupId);
    // Same reasoning as affectedOrgId: only a sysadmin's `orgId` takes effect.
    if (isSuperAdmin && typeof router.query.orgId === 'string') setOrgId(router.query.orgId);
    // createdAt range deep-links (e.g. "events since <incident time>").
    if (typeof router.query.from === 'string') setFrom(router.query.from);
    if (typeof router.query.to === 'string') setTo(router.query.to);
  }, [router.isReady, router.query, isSuperAdmin]);

  // Org id → display name lookup, so org references render as `name (id)`
  // instead of a bare ObjectId. Read through the shared query cache (the orgs
  // page asks for the same list) and sysadmin only — the org-list endpoint is
  // sysadmin-scoped; org-admins only ever see their own org's events and
  // degrade to bare ids. Failure is non-fatal: an empty map falls back to ids.
  const orgList = useQuery(isReady && isSuperAdmin ? queries.listOrganizations({ limit: 200 }) : null);
  const orgNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const org of orgList.data?.data?.organizations ?? []) {
      if (org.id && org.name) map.set(org.id, org.name);
    }
    return map;
  }, [orgList.data]);

  // Render an org reference as `name (id)`, keeping the id copyable via
  // CopyableId. Unknown/unresolved orgs fall back to the bare id (no
  // "undefined (id)").
  const renderOrgRef = (id: string) => {
    const name = orgNames.get(id);
    if (!name) return <CopyableId value={id} size="sm" />;
    return (
      <span className="inline-flex items-center gap-1">
        <span className="whitespace-nowrap">{name}</span>
        <span className="inline-flex items-center">(<CopyableId value={id} size="sm" />)</span>
      </span>
    );
  };

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

  // Count of applied filter fields — surfaced as a badge on the (collapsed)
  // filter toggle so users know a scope is in effect without expanding it.
  const activeFilterCount = [
    action, actorId, requestId, outcome, targetType, targetId, impersonatorId, groupId, from, to,
    isSuperAdmin && affectedOrgId, isSuperAdmin && orgId,
  ].filter(Boolean).length;

  const clearFilters = () => {
    setAction('');
    setActorId('');
    setRequestId('');
    setOutcome('');
    setTargetType('');
    setTargetId('');
    setImpersonatorId('');
    setGroupId('');
    setFrom('');
    setTo('');
    setAffectedOrgId('');
    setOrgId('');
    setOffset(0);
  };

  /** Narrow to one value from a row (actor, impersonator, target, group, org). */
  const narrow = (set: (v: string) => void, value: string) => {
    set(value);
    setOffset(0);
  };

  const filters = useMemo(() => ({
    ...(action && { action }),
    ...(actorId && { actorId }),
    ...(requestId && { requestId }),
    ...(outcome && { outcome }),
    ...(targetType && { targetType }),
    ...(targetId && { targetId }),
    ...(impersonatorId && { impersonatorId }),
    ...(groupId && { groupId }),
    ...(from && { from }),
    ...(to && { to }),
    // Org admins are pinned to their own org by the backend; these two are
    // sysadmin-only and never sent for anyone else.
    ...(isSuperAdmin && affectedOrgId && { affectedOrgId }),
    ...(isSuperAdmin && orgId && { orgId }),
    offset,
    limit,
  }), [action, actorId, requestId, outcome, targetType, targetId, impersonatorId, groupId, from, to, affectedOrgId, orgId, isSuperAdmin, offset, limit]);

  const list = useFetch(
    async (signal) => {
      if (!isReady) return null;
      const res = await api.listAuditEvents(filters, { signal });
      if (!res.success || !res.data) throw new Error(res.message || 'Failed to load audit events');
      return res.data;
    },
    [isReady, filters],
  );
  const events: AuditLogEvent[] = list.data?.events ?? [];
  const total = list.data?.pagination.total ?? 0;
  const loading = list.loading;

  if (accessDenied) return <AccessDenied denial={accessDenied} />;
  if (!isReady || !user) return <LoadingPage />;

  return (
    <DashboardLayout
      title="Audit Log"
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
            <span className="text-xs text-fg-muted inline-flex items-center gap-1">
              org {renderOrgRef(verifyOrgId)}
            </span>
          )}
          {verifyError && (
            <span className="inline-flex items-center gap-1 text-xs text-danger">
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

      <ErrorAlert message={list.error ? formatError(list.error, 'Failed to load audit events') : null} className="mb-4" />

      {/* Toolbar: collapsible-filter toggle + quick filters. Keeps the tall
          input grid out of the way until the user reaches for it. */}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setFiltersOpen((o) => !o)}
          aria-expanded={filtersOpen}
          aria-controls="audit-filter-panel"
          className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
            activeFilterCount > 0
              ? 'border-info-border bg-info-bg text-info'
              : 'border-default bg-surface text-fg-muted hover:bg-surface-muted'
          }`}
          title={filtersOpen ? 'Hide filters' : 'Show filters'}
        >
          <SlidersHorizontal className="w-3.5 h-3.5" />
          Filters
          {activeFilterCount > 0 && (
            <span className="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1 rounded-full bg-brand text-white text-2xs font-semibold">
              {activeFilterCount}
            </span>
          )}
          <ChevronDown className={`w-3.5 h-3.5 transition-transform ${filtersOpen ? 'rotate-180' : ''}`} />
        </button>

        <button
          type="button"
          onClick={toggleDenied}
          aria-pressed={deniedActive}
          className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
            deniedActive
              ? 'border-danger-border bg-danger-bg text-danger'
              : 'border-default bg-surface text-fg-muted hover:bg-surface-muted'
          }`}
          title="Spotlight authz.denied events (probing / privilege-escalation attempts)"
        >
          <Ban className="w-3.5 h-3.5" />
          Denied attempts
        </button>

        {activeFilterCount > 0 && (
          <button
            type="button"
            onClick={clearFilters}
            className="inline-flex items-center gap-1 text-xs text-fg-muted hover:text-fg"
            title="Clear all filters"
          >
            <X className="w-3.5 h-3.5" /> Clear filters
          </button>
        )}
      </div>

      {/* Filter bar — collapsed by default (see toggle above). */}
      {filtersOpen && (
      <div id="audit-filter-panel" className="filter-bar grid grid-cols-1 md:grid-cols-3 gap-2">
        <SearchInput
          placeholder="Filter by action (substring match)"
          aria-label="Filter by action"
          value={action}
          onChange={(v) => { setAction(v); setOffset(0); }}
        />
        <FilterInput
          type="text"
          placeholder="Actor user id"
          aria-label="Filter by actor user id"
          value={actorId}
          onChange={(e) => { setActorId(e.target.value); setOffset(0); }}
        />
        <FilterInput
          type="text"
          placeholder="Request id (correlation)"
          aria-label="Filter by request id"
          value={requestId}
          onChange={(e) => { setRequestId(e.target.value); setOffset(0); }}
        />
        <Select
          aria-label="Filter by outcome"
          value={outcome}
          onChange={(e) => { setOutcome(e.target.value as '' | 'success' | 'failure'); setOffset(0); }}
          className="filter-input"
        >
          <option value="">All outcomes</option>
          <option value="success">Success</option>
          <option value="failure">Failure</option>
        </Select>
        <FilterInput
          type="text"
          placeholder="Impersonator user id"
          aria-label="Filter by impersonator user id"
          value={impersonatorId}
          onChange={(e) => { setImpersonatorId(e.target.value); setOffset(0); }}
        />
        <FilterInput
          type="text"
          placeholder="Target id"
          aria-label="Filter by target id"
          value={targetId}
          onChange={(e) => { setTargetId(e.target.value); setOffset(0); }}
        />
        <FilterInput
          type="text"
          placeholder="Group id (one grouped operation)"
          aria-label="Filter by group id"
          value={groupId}
          onChange={(e) => { setGroupId(e.target.value); setOffset(0); }}
        />
        <Select
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
        </Select>
        <label className="flex items-center gap-2 text-xs text-fg-muted">
          <span className="shrink-0">From</span>
          <FilterInput
            type="date"
            aria-label="Filter events created on or after"
            value={from}
            max={to || undefined}
            onChange={(e) => { setFrom(e.target.value); setOffset(0); }}
          />
        </label>
        <label className="flex items-center gap-2 text-xs text-fg-muted">
          <span className="shrink-0">To</span>
          <FilterInput
            type="date"
            aria-label="Filter events created on or before"
            value={to}
            min={from || undefined}
            onChange={(e) => { setTo(e.target.value); setOffset(0); }}
          />
        </label>
        {isSuperAdmin && (
          <>
            <FilterInput
              type="text"
              placeholder="Org id — events by its members (sysadmin)"
              aria-label="Filter by org id"
              value={orgId}
              onChange={(e) => { setOrgId(e.target.value); setOffset(0); }}
            />
            <FilterInput
              type="text"
              placeholder="Affected org id (sysadmin filter)"
              aria-label="Filter by affected org id"
              value={affectedOrgId}
              onChange={(e) => { setAffectedOrgId(e.target.value); setOffset(0); }}
            />
          </>
        )}
      </div>
      )}

      {loading && !list.data && (
        <Card className="mt-2 overflow-hidden">
          <div className="divide-y divide-default">
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
        <div className="mt-2 flex items-center justify-end gap-2 text-xs text-fg-muted">
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
              datedFilename('audit-page'),
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
              datedFilename('audit-page'),
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
          <EmptyState
            icon={Activity}
            title="No matching audit events"
            description={activeFilterCount > 0 ? 'Nothing matches these filters. Clear some to widen the search.' : 'No events have been recorded yet.'}
            action={activeFilterCount > 0 ? <Button variant="secondary" onClick={clearFilters}>Clear filters</Button> : undefined}
          />
        ) : (
          <div className="divide-y divide-default">
            {events.map((event) => (
              <div
                key={event._id}
                role="button"
                tabIndex={0}
                onClick={() => setSelected(event)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelected(event); } }}
                aria-label={`View audit event: ${event.action}`}
                className="group px-4 py-3 text-sm cursor-pointer hover:bg-surface-muted focus:bg-surface-muted focus:outline-none transition-colors"
              >
                {/* Primary line: action + plain-language actor + time. This is
                    the scan line — no opaque ids compete for attention here. */}
                <div className="flex items-baseline justify-between gap-2">
                  <span className="inline-flex items-baseline gap-1.5 min-w-0 flex-wrap">
                    <code className="text-xs font-medium text-brand underline decoration-dotted underline-offset-2 group-hover:decoration-solid">{event.action}</code>
                    {event.outcome === 'failure' && <Badge color="red">failed</Badge>}
                    <span className="text-xs text-fg-muted truncate">
                      by {event.actorEmail || `${event.actorId.slice(0, 8)}…`}
                      {event.actorRole && <span className="text-fg-subtle"> · {event.actorRole}</span>}
                      {event.impersonatorId && <span className="text-fg-subtle"> (impersonated)</span>}
                    </span>
                  </span>
                  <span className="text-xs text-fg-muted shrink-0">
                    <RelativeTime value={event.createdAt} />
                  </span>
                </div>
                {/* Secondary line: the ids, de-emphasized. CopyableId truncates
                    and offers one compact copy affordance apiece. Org id is
                    suppressed when it's just the org already in scope. */}
                <div className="mt-1 text-2xs text-fg-subtle flex flex-wrap gap-x-3 gap-y-1 items-center">
                  <FilterChip label="actor" value={event.actorId} title="Show only this actor's events" onFilter={() => narrow(setActorId, event.actorId)} />
                  {event.impersonatorId && (
                    <FilterChip label="via" value={event.impersonatorId} title="Show everything done while this operator was impersonating" onFilter={() => narrow(setImpersonatorId, event.impersonatorId!)} />
                  )}
                  {event.orgId && event.orgId !== user.organizationId && (
                    isSuperAdmin
                      ? <FilterChip label="org" value={event.orgId} title="Show only events by this org's members" onFilter={() => narrow(setOrgId, event.orgId!)}>{renderOrgRef(event.orgId)}</FilterChip>
                      : <span className="inline-flex items-center gap-1">org {renderOrgRef(event.orgId)}</span>
                  )}
                  {event.affectedOrgId && event.affectedOrgId !== event.orgId && (
                    <span className="inline-flex items-center gap-1">affected {renderOrgRef(event.affectedOrgId)}</span>
                  )}
                  {event.targetType && (
                    event.targetId ? (
                      <FilterChip
                        label={event.targetType}
                        value={event.targetId}
                        title="Show only events on this target"
                        onFilter={() => { setTargetType(event.targetType!); narrow(setTargetId, event.targetId!); }}
                      />
                    ) : <code>{event.targetType}</code>
                  )}
                  {event.groupId && (
                    <FilterChip label="group" value={event.groupId} title="Show every event of this grouped operation" onFilter={() => narrow(setGroupId, event.groupId!)} />
                  )}
                  {event.requestId && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setRequestId(event.requestId!); setOffset(0); }}
                      className="inline-flex items-center gap-1 hover:underline hover:text-fg"
                      title="Filter to this request's correlation id"
                    >
                      req <code>{event.requestId.slice(0, 8)}</code>
                    </button>
                  )}
                </div>
                {event.details && Object.keys(event.details).length > 0 && (
                  <p className="mt-1 text-2xs text-fg-subtle/80 font-mono truncate">
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

      <div className="mt-4 text-xs text-fg-muted">
        For richer query-builder views, use the{' '}
        <Link href="/dashboard/observability/audit-activity" className="action-link">Audit Activity dashboard</Link>.
      </div>

      {selected && (
        <SideDrawer
          ariaLabel="Audit event details"
          onClose={() => setSelected(null)}
          title={selected.action}
          subtitle={<span className="tabular-nums">{formatDateTime(selected.createdAt)}</span>}
        >
          <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-2 text-sm">
            <dt className="text-fg-muted">Outcome</dt>
            <dd>{selected.outcome === 'failure'
              ? <Badge color="red">failure</Badge>
              : selected.outcome === 'success'
                ? <Badge color="green">success</Badge>
                : <Badge color="gray">unknown</Badge>}</dd>
            <dt className="text-fg-muted">Actor</dt>
            <dd className="text-fg inline-flex items-center gap-1 min-w-0">
              <span className="truncate">{selected.actorEmail || selected.actorId}</span>
              {selected.actorRole && <span className="text-fg-subtle">({selected.actorRole})</span>}
              <CopyableId value={selected.actorId} size="sm" />
            </dd>
            {selected.impersonatorId && (
              <>
                <dt className="text-fg-muted">Impersonator</dt>
                <dd className="inline-flex items-center gap-2">
                  <CopyableId value={selected.impersonatorId} size="sm" />
                  <button type="button" className="action-link text-xs" onClick={() => { narrow(setImpersonatorId, selected.impersonatorId!); setSelected(null); }}>
                    All their impersonated actions
                  </button>
                </dd>
              </>
            )}
            {selected.orgId && (<><dt className="text-fg-muted">Org</dt><dd>{renderOrgRef(selected.orgId)}</dd></>)}
            {selected.affectedOrgId && (<><dt className="text-fg-muted">Affected org</dt><dd>{renderOrgRef(selected.affectedOrgId)}</dd></>)}
            {selected.targetType && (
              <>
                <dt className="text-fg-muted">Target</dt>
                <dd className="inline-flex items-center gap-1"><code className="text-xs">{selected.targetType}</code>{selected.targetId && <><span>:</span><CopyableId value={selected.targetId} size="sm" /></>}</dd>
              </>
            )}
            {selected.groupId && (
              <>
                <dt className="text-fg-muted">Group</dt>
                <dd className="inline-flex items-center gap-2">
                  <CopyableId value={selected.groupId} size="sm" />
                  <button type="button" className="action-link text-xs" onClick={() => { narrow(setGroupId, selected.groupId!); setSelected(null); }}>
                    Whole operation
                  </button>
                </dd>
              </>
            )}
            {selected.ip && (<><dt className="text-fg-muted">IP</dt><dd><code className="text-xs">{selected.ip}</code></dd></>)}
            {selected.userAgent && (<><dt className="text-fg-muted">User agent</dt><dd className="text-xs text-fg break-all">{selected.userAgent}</dd></>)}
            {selected.requestId && (<><dt className="text-fg-muted">Request id</dt><dd><CopyableId value={selected.requestId} size="sm" /></dd></>)}
            {selected.traceId && (<><dt className="text-fg-muted">Trace id</dt><dd><CopyableId value={selected.traceId} size="sm" /></dd></>)}
          </dl>
          {selected.details && Object.keys(selected.details).length > 0 && (
            <div className="mt-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted mb-2">Details</p>
              <pre className="text-xs font-mono bg-surface-muted border border-default rounded p-3 whitespace-pre-wrap break-all max-h-96 overflow-y-auto">{JSON.stringify(redactDetails(selected.details), null, 2)}</pre>
            </div>
          )}
        </SideDrawer>
      )}
    </DashboardLayout>
  );
}
