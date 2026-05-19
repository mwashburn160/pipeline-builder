// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { Edit2, Copy, Trash2 } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useToast } from '@/components/ui/Toast';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { LinePanel } from '@/components/observability/LinePanel';
import { StatPanel } from '@/components/observability/StatPanel';
import { TablePanel } from '@/components/observability/TablePanel';
import { RangePicker } from '@/components/observability/RangePicker';
import type { RangeKey } from '@/hooks/useObservabilityQuery';
import type { DashboardWithPanels, DashboardPanel } from '@/types/observability';
import { api, ApiError } from '@/lib/api';

const FORMATTERS: Record<string, (v: number) => string> = {
  percent: (v) => `${(v * 100).toFixed(1)}%`,
  seconds: (v) => v < 60 ? `${v.toFixed(1)}s` : `${(v / 60).toFixed(1)}m`,
};

function parseRange(raw: unknown): RangeKey {
  if (raw === '1h' || raw === '6h' || raw === '24h') return raw;
  return '1h';
}

/** Type-narrow the catalog `span` field — DB stores it as integer (1..12),
 *  but the panel components only accept the renderable subset. */
function asSpan(n: number): 3 | 4 | 6 | 8 | 9 | 12 {
  const valid = [3, 4, 6, 8, 9, 12] as const;
  return (valid.find(v => v === n) ?? 6) as 3 | 4 | 6 | 8 | 9 | 12;
}

/** Render a single panel by its `vizKind`. Unknown kinds fall through to
 *  LinePanel — keeps a misconfigured dashboard partially-functional instead
 *  of blank. */
function PanelRenderer({ panel, range }: { panel: DashboardPanel; range: RangeKey }) {
  const span = asSpan(panel.span);
  const format = panel.format ? FORMATTERS[panel.format] : undefined;
  const groupBy = panel.groupBy ?? undefined;

  // Catalog `vars` (e.g. plugin name) are bound at the panel level — the
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
      return (
        <TablePanel
          title={panel.title}
          queryKey={panel.queryKey}
          range={range}
          span={span}
          mode={/recent_/i.test(panel.queryKey) ? 'logs' : 'topk'}
          topkLabel={groupBy}
        />
      );
    case 'line':
    case 'stacked-bar':
    default:
      return <LinePanel title={panel.title} queryKey={panel.queryKey} range={range} span={span} groupBy={groupBy} format={format} vars={vars} />;
  }
}

/**
 * Dynamic dashboard page. Fetches a DB-stored dashboard by id, renders its
 * panels in `position` order, and exposes Edit / Clone / Delete affordances
 * (write paths gated server-side; the UI shows them all and surfaces 403s as
 * toasts rather than hiding the buttons — keeps the role gating in one place).
 *
 * The 5 default dashboards seeded under `org_id='system'` (Platform Overview,
 * Plugin Builds, Queue Health, Registry Activity, Audit Activity) render
 * through this page too — the legacy static pages remain as back-compat
 * redirects (handled by the index page's sidebar list, which now points at
 * `/dashboard/observability/[id]`).
 */
export default function DashboardPage() {
  const { isReady, isAuthenticated, user } = useAuthGuard();
  const router = useRouter();
  const toast = useToast();
  const id = typeof router.query.id === 'string' ? router.query.id : '';
  const range = parseRange(router.query.range);

  const [dashboard, setDashboard] = useState<DashboardWithPanels | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isReady || !isAuthenticated || !id) return;
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        setError(null);
        const res = await api.getDashboard(id);
        if (!cancelled) setDashboard(res.data?.dashboard ?? null);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : (err as Error).message);
          setDashboard(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [isReady, isAuthenticated, id]);

  const setRange = useCallback((next: RangeKey) => {
    void router.replace({ pathname: router.pathname, query: { ...router.query, range: next } }, undefined, { shallow: true });
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
      toast.error(err instanceof ApiError ? err.message : (err as Error).message);
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
      toast.error(err instanceof ApiError ? err.message : (err as Error).message);
    }
  };

  if (!isReady || !isAuthenticated) return <LoadingPage />;
  if (loading) return <LoadingPage />;
  if (error) {
    return (
      <DashboardLayout title="Dashboard" subtitle="">
        <div className="rounded border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-800 dark:text-red-200">
          {error}
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
  // anything — server rejects writes the caller isn't allowed to make — but
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
      <div className="grid grid-cols-12 gap-4">
        {dashboard.panels.length === 0 ? (
          <div className="col-span-12 rounded border border-gray-200 dark:border-gray-700 p-6 text-center text-sm text-gray-500 dark:text-gray-400">
            No panels in this dashboard yet. {mightEdit && <Link href={`/dashboard/observability/${dashboard.id}/edit`} className="text-blue-600 hover:underline">Add some.</Link>}
          </div>
        ) : (
          dashboard.panels.map(p => <PanelRenderer key={p.id} panel={p} range={range} />)
        )}
      </div>
    </DashboardLayout>
  );
}
