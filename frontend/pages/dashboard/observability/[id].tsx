// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { Edit2, Copy, Trash2 } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useFetch } from '@/hooks/useFetch';
import { useToast } from '@/components/ui/Toast';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { LinePanel } from '@/components/observability/LinePanel';
import { StackedBarPanel } from '@/components/observability/StackedBarPanel';
import { StatPanel } from '@/components/observability/StatPanel';
import { TablePanel } from '@/components/observability/TablePanel';
import { RangePicker } from '@/components/observability/RangePicker';
import type { RangeKey } from '@/hooks/useObservabilityQuery';
import type { DashboardWithPanels, DashboardPanel } from '@/types/observability';
import { api, ApiError } from '@/lib/api';

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

/** URL-param filters that log-mode TablePanels forward to the Loki query.
 * These are read from the page's router query so a deep-link from
 * the registry-audit helper preserves its filter context across the
 * redirect from /audit-activity to /<dashboard-id>. */
interface LogUrlFilters { event?: string; actor?: string; digest?: string }

/** Render a single panel by its `vizKind`. Unknown kinds fall through to
 * LinePanel — keeps a misconfigured dashboard partially-functional instead
 * of blank. */
function PanelRenderer({ panel, range, urlFilters }: { panel: DashboardPanel; range: RangeKey; urlFilters: LogUrlFilters }) {
  const span = asSpan(panel.span);
  const format = panel.format ? FORMATTERS[panel.format]: undefined;
  const groupBy = panel.groupBy ?? undefined;

  // Catalog `vars` (e.g. plugin name) are bound at the panel level — the
  // backend's substituteVars consumes them server-side after sanitization.
  const vars = Object.keys(panel.vars).length > 0
    ? { plugin: panel.vars.plugin }
    : undefined;

  switch (panel.vizKind) {
    case 'stat':
      return <StatPanel title={panel.title} queryKey={panel.queryKey} range={range} span={span} format={format} vars={vars} />;
    case 'table':
      // Heuristic to pick logs vs topk for the table panel without a
      // dedicated DB field: catalog keys ending in `_recent_*` are logs;
      // everything else is treated as a topk aggregate.
      {
        const isLogsMode = /recent_/i.test(panel.queryKey);
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
            // a recent-events log query to a single event / actor / digest.
            logOpts={isLogsMode && (urlFilters.event || urlFilters.actor || urlFilters.digest)
              ? { ...urlFilters, limit: 50 }
              : undefined}
          />
        );
      }
    case 'stacked-bar':
      return <StackedBarPanel title={panel.title} queryKey={panel.queryKey} range={range} span={span} groupBy={groupBy} />;
    case 'line':
    default:
      return <LinePanel title={panel.title} queryKey={panel.queryKey} range={range} span={span} groupBy={groupBy} format={format} vars={vars} />;
  }
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
  const { isReady, isAuthenticated, user } = useAuthGuard();
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
    digest: typeof router.query.digest === 'string' ? router.query.digest : undefined,
  };
  const hasFilter = !!(urlFilters.event || urlFilters.actor || urlFilters.digest);

  const ready = isReady && isAuthenticated && !!id;
  // Measure container width for the grid driver. ResizeObserver follows
  // viewport + sidebar toggles without polling.
  const gridContainerRef = useRef<HTMLDivElement | null>(null);
  const [gridWidth, setGridWidth] = useState(960);

  const { data: dashboard, loading, error } = useFetch<DashboardWithPanels | null>(
    async () => (ready ? (await api.getDashboard(id)).data?.dashboard ?? null : null),
    [ready, id],
  );

  const setRange = useCallback((next: RangeKey) => {
    void router.replace({ pathname: router.pathname, query: {...router.query, range: next } }, undefined, { shallow: true });
  }, [router]);

  useEffect(() => {
    if (!gridContainerRef.current) return;
    const el = gridContainerRef.current;
    const measure = () => setGridWidth(Math.max(320, el.clientWidth));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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
      toast.error(err instanceof ApiError ? err.message: (err as Error).message);
    }
  };

  const onDelete = async () => {
    if (!dashboard) return;
    if (!confirm(`Delete "${dashboard.name}"? This cannot be undone.`)) return;
    try {
      await api.deleteDashboard(dashboard.id);
      toast.success('Dashboard deleted');
      void router.push('/dashboard/observability');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message: (err as Error).message);
    }
  };

  if (!isReady || !isAuthenticated) return <LoadingPage />;
  if (loading) return <LoadingPage />;
  if (error) {
    return (
      <DashboardLayout title="Dashboard" subtitle="">
        <div className="rounded border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-800 dark:text-red-200">
          {error.message}
        </div>
        <Link href="/dashboard/observability" className="mt-4 inline-block text-blue-600 hover:underline text-sm">← Back to all dashboards</Link>
      </DashboardLayout>
    );
  }
  if (!dashboard) {
    return (
      <DashboardLayout title="Dashboard not found" subtitle="">
        <Link href="/dashboard/observability" className="text-blue-600 hover:underline text-sm">← Back to all dashboards</Link>
      </DashboardLayout>
    );
  }

  // Show Edit only when the caller might have write access. Doesn't enforce
  // anything — server rejects writes the caller isn't allowed to make — but
  // hides the button from members who can't touch it to reduce noise.
  const mightEdit = !!user
    && (dashboard.visibility !== 'public' || user.organizationName === 'system')
    && (dashboard.createdBy === user.id || user.role === 'admin');

  return (
    <DashboardLayout
      title={dashboard.name}
      subtitle={dashboard.description ?? ''}
      actions={
        <div className="flex items-center gap-2">
          <RangePicker value={range} onChange={setRange} />
          {mightEdit && (
            <Link
              href={`/dashboard/observability/${dashboard.id}/edit`}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-50 dark:hover:bg-gray-800"
            >
              <Edit2 className="w-3.5 h-3.5" /> Edit
            </Link>
          )}
          <button
            onClick={() => void onClone()}
            className="inline-flex items-center gap-1 px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-50 dark:hover:bg-gray-800"
          >
            <Copy className="w-3.5 h-3.5" /> Clone
          </button>
          {mightEdit && (
            <button
              onClick={() => void onDelete()}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs border border-red-300 dark:border-red-700 text-red-700 dark:text-red-300 rounded hover:bg-red-50 dark:hover:bg-red-900/20"
            >
              <Trash2 className="w-3.5 h-3.5" /> Delete
            </button>
          )}
        </div>
      }
    >
      {/* deep-link filter banner. Lets the user see and clear the
          URL-param filters that arrived from registry-audit-link.ts (or any
          other deep-link helper) so they aren't confused by a partially-
          populated log panel. */}
      {hasFilter && (
        <div className="mb-4 flex items-center gap-2 px-3 py-2 rounded border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 text-xs">
          <span className="text-blue-700 dark:text-blue-300 font-medium">Filtered by:</span>
          {urlFilters.event && <span className="font-mono text-blue-700 dark:text-blue-300">event={urlFilters.event}</span>}
          {urlFilters.actor && <span className="font-mono text-blue-700 dark:text-blue-300">actor={urlFilters.actor}</span>}
          {urlFilters.digest && <span className="font-mono text-blue-700 dark:text-blue-300 break-all">digest={urlFilters.digest.slice(0, 19)}…</span>}
          <button
            onClick={() => void router.replace({ pathname: router.pathname, query: { id: router.query.id, range } }, undefined, { shallow: true })}
            className="ml-auto text-blue-700 dark:text-blue-300 underline hover:no-underline"
          >
            Clear
          </button>
        </div>
      )}
      {dashboard.panels.length === 0 ? (
        <div className="rounded border border-gray-200 dark:border-gray-700 p-6 text-center text-sm text-gray-500 dark:text-gray-400">
          No panels in this dashboard yet. {mightEdit && <Link href={`/dashboard/observability/${dashboard.id}/edit`} className="text-blue-600 hover:underline">Add some.</Link>}
        </div>
      ) : (
        // Read-side: panel positions come from saved layoutJson when
        // present; dashboards without saved coords fall back to
        // span-derived defaults inside DashboardLayoutGrid.buildLayout.
        // Drag/resize disabled here -- edits happen on /edit. Lazy-loaded grid lib.
        <div ref={gridContainerRef}>
          <DashboardLayoutGrid
            panels={dashboard.panels.map((p) => ({ id: `p-${p.position}`, title: p.title, span: p.span }))}
            layoutJson={dashboard.layoutJson}
            renderPanel={(_panel, i) => <PanelRenderer panel={dashboard.panels[i]} range={range} urlFilters={urlFilters} />}
            width={gridWidth}
            readOnly
          />
        </div>
      )}
    </DashboardLayout>
  );
}
