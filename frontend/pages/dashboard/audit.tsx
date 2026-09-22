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
 *   - `roleId`        — every event touching one permission role (`org.role.*`)
 *   - `requestId`, `outcome`, `from` / `to`
 *   - sysadmin only: `orgId` ("what org X's people did") and `affectedOrgId`
 *     ("what was done TO org X"). The backend pins an org admin to their own
 *     org, so those two are never offered to one.
 *
 * Filter state, debouncing, offset reset, URL sync and pagination all come from
 * `useListPage` — the same hook every other list page uses. Deep-links from
 * other surfaces (org-detail "View audit log") land with the right scope, and
 * the ids on each row are buttons that narrow the list to that actor /
 * impersonator / target / role.
 */

import { useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Activity, ArrowLeft, Download, Ban, X, Store, ShieldCheck } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useListPage, type FilterField } from '@/hooks/useListPage';
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
import { FilterBar } from '@/components/ui/FilterBar';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { AuditFilterPanel } from '@/components/audit/AuditFilterPanel';
import { ChainVerifyStrip } from '@/components/audit/ChainVerifyStrip';
import { downloadCsv, downloadJsonl, datedFilename } from '@/lib/csv-export';
import { redactDetails } from '@/lib/redact';
import type { AuditLogEvent } from '@/types/audit';
import api from '@/lib/api';
import { useOrgNames } from '@/components/ui/OrgPicker';
import { localDayEndIso, localDayStartIso } from '@/lib/local-day';
import { formatDateTime } from '@/lib/format';
import {
  AUDIT_QUICK_FILTERS,
  auditQuickFilterActions,
  isAuditQuickFilterKey,
  type AuditQuickFilterKey,
} from '@/lib/audit-quick-filters';

const DEFAULT_LIMIT = 50;

/** The action string for a denied-authorization audit event. */
const DENIED_ACTION = 'authz.denied';

/**
 * Every field `GET /audit` accepts, declared unconditionally so the shape of
 * `useListPage`'s filter state never depends on who is looking. The two
 * sysadmin-only scopes are gated where they're READ instead (rendered by
 * `AuditFilterPanel`, counted by `activeFilterCount`, sent by the fetcher),
 * which keeps an org admin's deep-link to `?orgId=…` inert exactly as before.
 *
 * Module-level so the array identity is stable across renders.
 */
const FILTER_FIELDS: FilterField[] = [
  { key: 'action', type: 'text', defaultValue: '', primary: true },
  { key: 'actorId', type: 'text', defaultValue: '' },
  { key: 'requestId', type: 'text', defaultValue: '' },
  // Selects (and the two date inputs) commit immediately; only free text debounces.
  { key: 'outcome', type: 'select', defaultValue: '' },
  { key: 'targetType', type: 'select', defaultValue: '' },
  { key: 'targetId', type: 'text', defaultValue: '' },
  { key: 'impersonatorId', type: 'text', defaultValue: '' },
  { key: 'roleId', type: 'text', defaultValue: '' },
  { key: 'from', type: 'select', defaultValue: '' },
  { key: 'to', type: 'select', defaultValue: '' },
  { key: 'orgId', type: 'text', defaultValue: '' },
  { key: 'affectedOrgId', type: 'text', defaultValue: '' },
  // Grouped quick filter (`ecosystem` | `moderation`) — a client-side union of
  // several `action` queries; see `@/lib/audit-quick-filters`. Mutually
  // exclusive with the free-text action search.
  { key: 'group', type: 'select', defaultValue: '' },
];

const QUICK_FILTER_ICONS: Record<AuditQuickFilterKey, typeof Store> = {
  ecosystem: Store,
  moderation: ShieldCheck,
};

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
  const { accessDenied, isReady, user, isSuperAdmin } = useAuthGuard();
  const [selected, setSelected] = useState<AuditLogEvent | null>(null);
  // The full filter panel is collapsed by default to reclaim vertical space;
  // an active-filter count badge on the toggle signals when filters are on.
  const [filtersOpen, setFiltersOpen] = useState(false);

  const list = useListPage<AuditLogEvent>({
    fields: FILTER_FIELDS,
    enabled: isReady,
    pageSize: DEFAULT_LIMIT,
    urlSync: true,
    fetcher: async (params, signal) => {
      const { limit, offset, outcome, orgId, affectedOrgId, group, action: actionParam, from, to, ...rest } = params;
      const base = {
        ...rest,
        // The date inputs give a bare local DAY. Sent as-is the server read
        // "To 2026-09-21" as midnight UTC and excluded that whole day (and
        // shifted "From" by the viewer's UTC offset); send the local day's
        // real bounds instead.
        ...(from ? { from: localDayStartIso(from) } : {}),
        ...(to ? { to: localDayEndIso(to) } : {}),
        // Org admins are pinned to their own org by the backend; these two are
        // sysadmin-only and never sent for anyone else — even if a deep-link
        // put them in the filter state.
        ...(isSuperAdmin && orgId ? { orgId } : {}),
        ...(isSuperAdmin && affectedOrgId ? { affectedOrgId } : {}),
        ...(outcome ? { outcome: outcome as 'success' | 'failure' } : {}),
      };
      const res = await api.listAuditEvents({
        ...base,
        ...(actionParam ? { action: actionParam } : {}),
        ...(isAuditQuickFilterKey(group) ? { actions: auditQuickFilterActions(group) } : {}),
        limit: Number(limit),
        offset: Number(offset),
      }, { signal });
      if (!res.success || !res.data) throw new Error(res.message || 'Failed to load audit events');
      return { items: res.data.events, pagination: res.data.pagination };
    },
  });
  const { filters, updateFilter, clearFilters } = list;
  const events = list.data;
  const action = filters.action ?? '';
  // Only a sysadmin's copy of these two is ever in effect (see FILTER_FIELDS).
  const affectedOrgId = isSuperAdmin ? (filters.affectedOrgId ?? '') : '';
  const orgIdFilter = isSuperAdmin ? (filters.orgId ?? '') : '';

  // Org id → display name, so org references render as `name (id)` instead of
  // a bare ObjectId. Resolved for exactly the ids this page shows, not a
  // capped page of the fleet. Sysadmin only — the org-list endpoint is sysadmin-scoped;
  // org-admins only ever see their own org's events and degrade to bare ids.
  const shownOrgIds = useMemo(() => {
    const ids = [affectedOrgId, orgIdFilter, user?.organizationId ?? ''];
    for (const e of events) ids.push(e.orgId ?? '', e.affectedOrgId ?? '');
    if (selected) ids.push(selected.orgId ?? '', selected.affectedOrgId ?? '');
    return ids.filter(Boolean);
  }, [events, affectedOrgId, orgIdFilter, user?.organizationId, selected]);
  const orgNames = useOrgNames(shownOrgIds, isReady && isSuperAdmin);

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

  // Hash-chain tamper-verify runs against the org currently in scope — the
  // affected-org filter when set, else the sysadmin's own org.
  const verifyOrgId = affectedOrgId || user?.organizationId || '';

  const group = isAuditQuickFilterKey(filters.group) ? filters.group : '';
  const deniedActive = action === DENIED_ACTION && !group;
  // Quick filters are mutually exclusive: each one clears the others (and the
  // free-text action search, which the group union can't be combined with).
  const toggleDenied = () => {
    if (group) updateFilter('group', '');
    updateFilter('action', deniedActive ? '' : DENIED_ACTION);
  };
  const toggleGroup = (key: AuditQuickFilterKey) => {
    if (action) updateFilter('action', '');
    updateFilter('group', group === key ? '' : key);
  };
  const onActionSearch = (v: string) => {
    if (group && v) updateFilter('group', '');
    updateFilter('action', v);
  };

  // Count of applied filter fields — surfaced as a badge on the (collapsed)
  // filter toggle so users know a scope is in effect without expanding it.
  // Computed here rather than taken from the hook so the two sysadmin-only
  // scopes stay uncounted for an org admin who deep-linked one.
  const activeFilterCount = [
    action, group, filters.actorId, filters.requestId, filters.outcome, filters.targetType,
    filters.targetId, filters.impersonatorId, filters.roleId, filters.from, filters.to,
    affectedOrgId, orgIdFilter,
  ].filter(Boolean).length;
  // FilterBar's badge excludes the primary search (the action field).
  // The group quick filter is surfaced by its own chip, so it's excluded too.
  const advancedFilterCount = activeFilterCount - (action ? 1 : 0) - (group ? 1 : 0);

  if (accessDenied) return <AccessDenied denial={accessDenied} />;
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
            onClick={() => updateFilter('affectedOrgId', '')}
            className="action-link inline-flex items-center gap-1 text-sm"
          >
            <ArrowLeft className="w-4 h-4" /> Clear org scope (showing events affecting org {affectedOrgId})
          </button>
        </div>
      )}

      {/* Hash-chain integrity verify — sysadmin only. Unobtrusive: a button
          plus an inline result badge sitting above the filters. */}
      {isSuperAdmin && <ChainVerifyStrip orgId={verifyOrgId} renderOrgRef={renderOrgRef} />}

      <ErrorAlert message={list.error} className="mb-4" />

      {/* Search + collapsible advanced panel (count badge, clear-all) — the
          shared FilterBar every other list page uses. */}
      <FilterBar
        searchValue={action}
        onSearchChange={onActionSearch}
        searchPlaceholder="Filter by action (substring match)"
        showAdvanced={filtersOpen}
        onToggleAdvanced={() => setFiltersOpen((o) => !o)}
        advancedFilterCount={advancedFilterCount}
        onClearAll={clearFilters}
        advancedContent={
          <AuditFilterPanel filters={filters} onChange={updateFilter} isSuperAdmin={isSuperAdmin} />
        }
      />

      {/* Quick filters that stay visible with the panel collapsed. */}
      <div className="mt-2 mb-2 flex flex-wrap items-center gap-2">
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

        {(Object.values(AUDIT_QUICK_FILTERS)).map((qf) => {
          const active = group === qf.key;
          const Icon = QUICK_FILTER_ICONS[qf.key];
          return (
            <button
              key={qf.key}
              type="button"
              onClick={() => toggleGroup(qf.key)}
              aria-pressed={active}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                active
                  ? 'border-info-border bg-info-bg text-info'
                  : 'border-default bg-surface text-fg-muted hover:bg-surface-muted'
              }`}
              title={qf.title}
            >
              <Icon className="w-3.5 h-3.5" />
              {qf.label}
            </button>
          );
        })}

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

      {list.isLoading && events.length === 0 && (
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
                roleId: e.roleId ?? '',
                ip: e.ip ?? '',
                userAgent: e.userAgent ?? '',
                requestId: e.requestId ?? '',
                traceId: e.traceId ?? '',
                details: e.details ? JSON.stringify(redactDetails(e.details)) : '',
              })),
              ['createdAt', 'action', 'outcome', 'actorId', 'actorEmail', 'actorRole', 'impersonatorId', 'orgId', 'affectedOrgId', 'targetType', 'targetId', 'roleId', 'ip', 'userAgent', 'requestId', 'traceId', 'details'],
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
        {events.length === 0 && !list.isLoading ? (
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
                  <FilterChip label="actor" value={event.actorId} title="Show only this actor's events" onFilter={() => updateFilter('actorId', event.actorId)} />
                  {event.impersonatorId && (
                    <FilterChip label="via" value={event.impersonatorId} title="Show everything done while this operator was impersonating" onFilter={() => updateFilter('impersonatorId', event.impersonatorId!)} />
                  )}
                  {event.orgId && event.orgId !== user.organizationId && (
                    isSuperAdmin
                      ? <FilterChip label="org" value={event.orgId} title="Show only events by this org's members" onFilter={() => updateFilter('orgId', event.orgId!)}>{renderOrgRef(event.orgId)}</FilterChip>
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
                        onFilter={() => { updateFilter('targetType', event.targetType!); updateFilter('targetId', event.targetId!); }}
                      />
                    ) : <code>{event.targetType}</code>
                  )}
                  {event.roleId && (
                    <FilterChip label="role" value={event.roleId} title="Show every event touching this permission role" onFilter={() => updateFilter('roleId', event.roleId!)} />
                  )}
                  {event.requestId && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); updateFilter('requestId', event.requestId!); }}
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

      {list.pagination.total > list.pagination.limit && (
        <div className="mt-3">
          <Pagination
            pagination={list.pagination}
            onPageChange={list.handlePageChange}
            onPageSizeChange={list.handlePageSizeChange}
          />
        </div>
      )}

      <div className="mt-4 text-xs text-fg-muted">
        For richer query-builder views, use the{' '}
        <Link href="/dashboard/observability/audit-activity" className="action-link">Audit activity dashboard</Link>.
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
                  <button type="button" className="action-link text-xs" onClick={() => { updateFilter('impersonatorId', selected.impersonatorId!); setSelected(null); }}>
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
            {selected.roleId && (
              <>
                <dt className="text-fg-muted">Role</dt>
                <dd className="inline-flex items-center gap-2">
                  <CopyableId value={selected.roleId} size="sm" />
                  <button type="button" className="action-link text-xs" onClick={() => { updateFilter('roleId', selected.roleId!); setSelected(null); }}>
                    Every event on this role
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
