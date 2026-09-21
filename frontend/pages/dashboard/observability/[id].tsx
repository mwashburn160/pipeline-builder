// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/router';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { Edit2, Copy, Trash2, LayoutDashboard } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { useFetch } from '@/hooks/useFetch';
import { useToast } from '@/components/ui/Toast';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { Button } from '@/components/ui/Button';
import { LinkButton } from '@/components/ui/LinkButton';
import { Input } from '@/components/ui/Input';
import { READ_ONLY_REASON } from '@/components/ui/ReadOnlyNotice';
import { RetryError } from '@/components/ui/RetryError';
import { EmptyState } from '@/components/ui/EmptyState';
import { WarningAlert } from '@/components/ui/WarningAlert';
import { DeleteConfirmModal } from '@/components/ui/DeleteConfirmModal';
import { ObservabilityHealthProvider, useObservabilityHealth } from '@/hooks/useObservabilityHealth';
import { LinePanel } from '@/components/observability/LinePanel';
import { StackedBarPanel } from '@/components/observability/StackedBarPanel';
import { StatPanel } from '@/components/observability/StatPanel';
import { TablePanel } from '@/components/observability/TablePanel';
import { RangePicker } from '@/components/observability/RangePicker';
import type { RangeKey } from '@/types/observability';
import type { DashboardWithPanels, DashboardPanel } from '@/types/observability';
import { api } from '@/lib/api';
import { isSystemAdmin } from '@/lib/auth-helpers';
import { formatError } from '@/lib/constants';
import { useElementWidth } from '@/hooks/useElementWidth';

// Read-side: lazy-load the grid driver so the ~120 KB bundle only ships
// when a dashboard is actually viewed. Dashboards without saved coords
// fall back to span-derived defaults inside DashboardLayoutGrid.buildLayout.
const DashboardLayoutGrid = dynamic(() => import('@/components/observability/DashboardLayoutGrid'), { ssr: false });

const FORMATTERS: Record<string, (v: number) => string> = {
  percent: (v) => `${(v * 100).toFixed(1)}%`,
  seconds: (v) => (v < 60 ? `${v.toFixed(1)}s` : `${(v / 60).toFixed(1)}m`),
};

function parseRange(raw: unknown): RangeKey {
  if (raw === '1h' || raw === '6h' || raw === '24h') return raw;
  return '1h';
}

/** Type-narrow the catalog `span` field — DB stores it as integer (1..12), but the panel components only accept the renderable subset. */
function asSpan(n: number): 3 | 4 | 6 | 8 | 9 | 12 {
  const valid = [3, 4, 6, 8, 9, 12] as const;
  return (valid.find(v => v === n) ?? 6) as 3 | 4 | 6 | 8 | 9 | 12;
}

/** URL-param filters that log-mode TablePanels forward to the audit-trail query.
 * These are read from the page's router query so a deep-link from
 * the registry-audit helper preserves its filter context across the
 * redirect from /audit-activity to /<dashboard-id>. `requestId` pulls every
 * audited action one HTTP request made (the catalog allows all three). */
interface LogUrlFilters { event?: string; actor?: string; requestId?: string }

const LOG_FILTER_KEYS = ['event', 'actor', 'requestId'] as const;

/** Log-mode table panels are the `*_recent_*` catalog keys (see PanelRenderer). */
function isLogsPanel(panel: DashboardPanel): boolean {
  return panel.vizKind === 'table' && /recent_/i.test(panel.queryKey);
}

/**
 * Filter form for dashboards with an audit recent-events panel. Writes the
 * values into the URL (shallow), which is what the panels read — so a filtered
 * view is shareable and survives reload, exactly like a deep link.
 */
function LogFilterForm({ value, onApply }: { value: LogUrlFilters; onApply: (next: LogUrlFilters) => void }) {
  const [draft, setDraft] = useState<LogUrlFilters>(value);
  // Follow the URL when it changes underneath (Clear, back/forward).
  const valueKey = JSON.stringify(value);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `value` is tracked by its JSON key; its identity would re-seed the draft every render
  useEffect(() => { setDraft(value); }, [valueKey]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const next: LogUrlFilters = {};
    for (const k of LOG_FILTER_KEYS) {
      const v = draft[k]?.trim();
      if (v) next[k] = v;
    }
    onApply(next);
  };

  const field = (key: (typeof LOG_FILTER_KEYS)[number], label: string, placeholder: string) => (
    <Input
      aria-label={label}
      placeholder={placeholder}
      value={draft[key] ?? ''}
      onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
      className="font-mono text-xs w-48"
    />
  );

  return (
    <form onSubmit={submit} className="mb-4 flex flex-wrap items-center gap-2" aria-label="Filter audit events">
      {field('event', 'Event', 'event (e.g. pipeline.delete)')}
      {field('actor', 'Actor', 'actor id or email')}
      {field('requestId', 'Request ID', 'request id')}
      <Button type="submit" variant="secondary" size="xs">Apply filters</Button>
    </form>
  );
}

/** Render a single panel by its `vizKind`. Unknown kinds fall through to
 * LinePanel — keeps a misconfigured dashboard partially-functional instead
 * of blank. */
function PanelRenderer({ panel, range, urlFilters }: { panel: DashboardPanel; range: RangeKey; urlFilters: LogUrlFilters }) {
  const span = asSpan(panel.span);
  const format = panel.format ? FORMATTERS[panel.format]: undefined;
  const groupBy = panel.groupBy ?? undefined;

  switch (panel.vizKind) {
    case 'stat':
      return <StatPanel title={panel.title} queryKey={panel.queryKey} range={range} span={span} format={format} />;
    case 'table':
      // Heuristic to pick logs vs topk for the table panel without a
      // dedicated DB field: catalog keys ending in `_recent_*` are logs;
      // everything else is treated as a topk aggregate.
      {
        const isLogsMode = isLogsPanel(panel);
        return (
          <TablePanel
            title={panel.title}
            queryKey={panel.queryKey}
            range={range}
            span={span}
            mode={isLogsMode ? 'logs' : 'topk'}
            topkLabel={groupBy}
            // forward URL filters to log-mode panels only.
            // The audit-activity deep-link helper uses these to pre-filter
            // a recent-events log query to a single event / actor.
            logOpts={isLogsMode && (urlFilters.event || urlFilters.actor || urlFilters.requestId)
              ? { ...urlFilters, limit: 50 }
              : undefined}
          />
        );
      }
    case 'stacked-bar':
      return <StackedBarPanel title={panel.title} queryKey={panel.queryKey} range={range} span={span} groupBy={groupBy} />;
    case 'line':
    default:
      return <LinePanel title={panel.title} queryKey={panel.queryKey} range={range} span={span} groupBy={groupBy} format={format} />;
  }
}

/** Page-level "monitoring backend unavailable" banner, driven by the aggregate
 * degraded signal the panels report through ObservabilityHealthProvider. Must be
 * rendered inside that provider. Invisible unless at least one panel is degraded. */
function ObservabilityDegradedBanner() {
  const degraded = useObservabilityHealth();
  return (
    <WarningAlert
      className="mb-4"
      message={degraded
        ? 'Monitoring backend unavailable — Prometheus is not reachable (this deployment may be running in LEAN mode, which omits it). Metric panels below show no data.'
        : undefined}
    />
  );
}

/**
 * Dynamic dashboard page. Fetches a DB-stored dashboard by id, renders its
 * panels in `position` order, and exposes Edit / Clone / Delete affordances
 * (write paths gated server-side; the UI shows them all and surfaces 403s as
 * toasts rather than hiding the buttons — keeps the role gating in one place).
 *
 * The 5 default dashboards seeded under `org_id='system'` (Platform Overview,
 * Plugin Builds, Queue Health, Registry Activity, Audit Activity) render
 * through this page too — the legacy static pages remain as back-compat
 * redirects (handled by the index page's sidebar list, which now points at
 * `/dashboard/observability/[id]`).
 */
export default function DashboardPage() {
  const { accessDenied, isReady, isAuthenticated, user, can, isReadOnly } = useAuthGuard();
  const router = useRouter();
  const toast = useToast();
  const id = typeof router.query.id === 'string' ? router.query.id : '';
  const range = parseRange(router.query.range);
  // URL-param filters forwarded to log-mode panels. Set by deep-link
  // helpers (e.g. `buildAuditLogLink` in registry-audit-link.ts) so a
  // click on an audit-event row lands on the dashboard pre-filtered.
  const urlFilters: LogUrlFilters = {
    event: typeof router.query.event === 'string' ? router.query.event : undefined,
    actor: typeof router.query.actor === 'string' ? router.query.actor : undefined,
    requestId: typeof router.query.requestId === 'string' ? router.query.requestId : undefined,
  };
  const hasFilter = !!(urlFilters.event || urlFilters.actor || urlFilters.requestId);

  /** Replace the log filters in the URL (shallow), keeping id + range. */
  const applyLogFilters = useCallback((next: LogUrlFilters) => {
    void router.replace({ pathname: router.pathname, query: { id: router.query.id, range, ...next } }, undefined, { shallow: true });
  }, [router, range]);

  const ready = isReady && isAuthenticated && !!id;
  // Measure container width for the grid driver (ResizeObserver via a callback
  // ref — see useElementWidth for why a mount-only effect stuck it at 960px).
  const [gridContainerRef, gridWidth] = useElementWidth(960);
  // Delete confirmation (in-app modal, replacing the native confirm()).
  const [pendingDelete, setPendingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const { data: dashboard, loading, error, refetch } = useFetch<DashboardWithPanels | null>(
    async (signal) => (ready ? (await api.getDashboard(id, signal)).data?.dashboard ?? null : null),
    [ready, id],
  );

  const setRange = useCallback((next: RangeKey) => {
    void router.replace({ pathname: router.pathname, query: {...router.query, range: next } }, undefined, { shallow: true });
  }, [router]);

  const onClone = async () => {
    if (!dashboard) return;
    try {
      const res = await api.cloneDashboard(dashboard.id);
      const newId = res.data?.dashboard.id;
      if (newId) {
        toast.success(`Cloned to "${res.data?.dashboard.name}"`);
        void router.push(`/dashboard/observability/${newId}`);
      }
    } catch (err) {
      toast.error(formatError(err));
    }
  };

  const executeDelete = async () => {
    if (!dashboard) return;
    setDeleting(true);
    try {
      await api.deleteDashboard(dashboard.id);
      toast.success('Dashboard deleted');
      void router.push('/dashboard/observability');
    } catch (err) {
      toast.error(formatError(err));
      setDeleting(false);
      setPendingDelete(false);
    }
  };

  // `!id` keeps the "Dashboard not found" branch from flashing on first client
  // render, before `router.query.id` has hydrated (the fetcher no-ops to null
  // while `ready` is false, flipping `loading` false).
  if (accessDenied) return <AccessDenied denial={accessDenied} />;
  if (!isReady || !isAuthenticated || !id) return <LoadingPage />;
  if (loading) return <LoadingPage />;
  if (error) {
    return (
      <DashboardLayout title="Dashboard" subtitle="">
        <RetryError message={formatError(error, 'Failed to load the dashboard')} onRetry={refetch} />
        <Link href="/dashboard/observability" className="mt-4 inline-block text-brand hover:underline text-sm">← Back to all dashboards</Link>
      </DashboardLayout>
    );
  }
  if (!dashboard) {
    return (
      <DashboardLayout title="Dashboard not found" subtitle="">
        <EmptyState icon={LayoutDashboard} title="Dashboard not found" description="It may have been deleted, or you no longer have access to it." />
        <Link href="/dashboard/observability" className="mt-4 inline-block text-brand hover:underline text-sm">← Back to all dashboards</Link>
      </DashboardLayout>
    );
  }

  // Show Edit only when the caller might have write access. Doesn't enforce
  // anything — server rejects writes the caller isn't allowed to make — but
  // hides the button from members who can't touch it to reduce noise.
  // `!isReadOnly`: the author branch (`createdBy === user.id`) isn't read-only-
  // aware (only `can()` is), so without it a read-only impersonation of the
  // author would still get Edit/Delete — writes the backend rejects.
  const mightEdit = !!user && !isReadOnly
    && (dashboard.visibility !== 'public' || isSystemAdmin(user))
    && (dashboard.createdBy === user.id || can('dashboards:write'));

  const canClone = can('dashboards:write');

  return (
    <DashboardLayout
      title={dashboard.name}
      subtitle={dashboard.description ?? ''}
      breadcrumbs={[
        { label: 'Observability', href: '/dashboard/observability' },
        { label: dashboard.name },
      ]}
      actions={
        <div className="flex items-center gap-2">
          <RangePicker value={range} onChange={setRange} />
          {mightEdit && (
            <LinkButton
              href={`/dashboard/observability/${dashboard.id}/edit`}
              variant="secondary"
              size="xs"
              className="gap-1"
            >
              <Edit2 className="w-3.5 h-3.5" /> Edit
            </LinkButton>
          )}
          <Button
            variant="secondary"
            size="xs"
            onClick={() => void onClone()}
            // Clone is a create (POST, `dashboards:write` at the route); `can()`
            // also reports false under read-only impersonation.
            disabled={!canClone}
            title={canClone ? undefined : (isReadOnly ? READ_ONLY_REASON : 'Requires dashboards:write')}
            className="gap-1"
          >
            <Copy className="w-3.5 h-3.5" /> Clone
          </Button>
          {mightEdit && (
            <Button
              variant="danger-outline"
              size="xs"
              onClick={() => setPendingDelete(true)}
              className="gap-1"
            >
              <Trash2 className="w-3.5 h-3.5" /> Delete
            </Button>
          )}
        </div>
      }
    >
      {/* deep-link filter banner. Lets the user see and clear the
          URL-param filters that arrived from registry-audit-link.ts (or any
          other deep-link helper) so they aren't confused by a partially-
          populated log panel. */}
      {hasFilter && (
        <div className="mb-4 flex items-center gap-2 px-3 py-2 rounded border border-info-border bg-info-bg text-xs">
          <span className="text-info-strong font-medium">Filtered by:</span>
          {urlFilters.event && <span className="font-mono text-info-strong">event={urlFilters.event}</span>}
          {urlFilters.actor && <span className="font-mono text-info-strong">actor={urlFilters.actor}</span>}
          {urlFilters.requestId && <span className="font-mono text-info-strong">requestId={urlFilters.requestId}</span>}
          <Button
            variant="link"
            onClick={() => applyLogFilters({})}
            className="ml-auto text-info-strong"
          >
            Clear
          </Button>
        </div>
      )}
      {dashboard.panels.some(isLogsPanel) && (
        <LogFilterForm value={urlFilters} onApply={applyLogFilters} />
      )}
      {dashboard.panels.length === 0 ? (
        <EmptyState
          icon={LayoutDashboard}
          title="No panels yet"
          description="This dashboard has no panels."
          action={mightEdit ? <LinkButton href={`/dashboard/observability/${dashboard.id}/edit`} variant="secondary" size="sm">Add panels</LinkButton> : undefined}
        />
      ) : (
        // Read-side: panel positions come from saved layoutJson when
        // present; dashboards without saved coords fall back to
        // span-derived defaults inside DashboardLayoutGrid.buildLayout.
        // Drag/resize disabled here -- edits happen on /edit. Lazy-loaded grid lib.
        <ObservabilityHealthProvider>
          <ObservabilityDegradedBanner />
          <div ref={gridContainerRef}>
            <DashboardLayoutGrid
              panels={dashboard.panels.map((p) => ({ id: `p-${p.position}`, title: p.title, span: p.span }))}
              layoutJson={dashboard.layoutJson}
              renderPanel={(_panel, i) => <PanelRenderer panel={dashboard.panels[i]} range={range} urlFilters={urlFilters} />}
              width={gridWidth}
              readOnly
            />
          </div>
        </ObservabilityHealthProvider>
      )}

      {pendingDelete && (
        <DeleteConfirmModal
          title="Delete dashboard"
          itemName={dashboard.name}
          loading={deleting}
          onConfirm={() => void executeDelete()}
          onCancel={() => setPendingDelete(false)}
        />
      )}
    </DashboardLayout>
  );
}
