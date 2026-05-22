// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Activity, BarChart3, Bell, LayoutDashboard, ListChecks, Boxes, Plus, Lock, Building2, Globe } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { api, ApiError } from '@/lib/api';
import type { Dashboard } from '@/types/observability';

/**
 * Observability landing page. Lists every dashboard the caller can see:
 *  - DB-stored dashboards (visible per the server-side visibility ladder)
 *  - The "Alerts" page (not a Prom dashboard — gets its own well-known link)
 *
 * The 5 historical static dashboards (Platform Overview, Plugin Builds,
 * Queue Health, Registry Activity, Audit Activity) now live in the DB as
 * `visibility=public, org_id='system'` rows seeded by the platform service
 * at cold start, so they show up here automatically.
 */
export default function ObservabilityIndexPage() {
  const { isReady, isAuthenticated } = useAuthGuard();
  const [dashboards, setDashboards] = useState<Dashboard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isReady || !isAuthenticated) return;
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        setError(null);
        const res = await api.listDashboards();
        if (!cancelled) setDashboards(res.data?.dashboards ?? []);
      } catch (err) {
        if (!cancelled) setError(err instanceof ApiError ? err.message : (err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [isReady, isAuthenticated]);

  if (!isReady || !isAuthenticated) return <LoadingPage />;

  // Best-effort icon for the seeded defaults; everything else falls back
  // to a generic LayoutDashboard.
  const ICON_BY_NAME: Record<string, LucideIcon> = {
    'Platform Overview': LayoutDashboard,
    'Plugin Builds': BarChart3,
    'Queue Health': ListChecks,
    'Registry Activity': Boxes,
    'Audit Activity': Activity,
  };

  const visibilityIcon = (v: Dashboard['visibility']): LucideIcon => {
    if (v === 'public') return Globe;
    if (v === 'org') return Building2;
    return Lock;
  };

  return (
    <DashboardLayout
      title="Observability"
      subtitle="Native operator dashboards over Prometheus + Loki"
      actions={
        <Link
          href="/dashboard/observability/new"
          className="inline-flex items-center gap-1 px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-50 dark:hover:bg-gray-800"
        >
          <Plus className="w-3.5 h-3.5" /> New dashboard
        </Link>
      }
    >
      {error && (
        <div className="mb-4 rounded border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-800 dark:text-red-200">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Alerts page — not a Prom dashboard but lives in the same section. */}
        <Link
          href="/dashboard/observability/alerts"
          className="block rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4 hover:border-blue-500 hover:shadow-sm transition-colors"
        >
          <div className="flex items-center gap-3 mb-2">
            <Bell className="w-5 h-5 text-blue-600 dark:text-blue-400" />
            <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Alerts</h2>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Firing + suppressed alerts from Alertmanager, with per-org silence controls.
          </p>
        </Link>

        {/* Per-org notification destinations — where this org's alerts go. */}
        <Link
          href="/dashboard/observability/alert-destinations"
          className="block rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4 hover:border-blue-500 hover:shadow-sm transition-colors"
        >
          <div className="flex items-center gap-3 mb-2">
            <Bell className="w-5 h-5 text-blue-600 dark:text-blue-400" />
            <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Alert destinations</h2>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Slack, webhook, in-app — where this org's alerts get delivered.
          </p>
        </Link>

        {/* Loading placeholder */}
        {loading && (
          <div className="col-span-full text-sm text-gray-500 dark:text-gray-400">Loading dashboards…</div>
        )}

        {/* DB-stored dashboards (seeded defaults + org-created). */}
        {dashboards.map((d) => {
          const Icon = ICON_BY_NAME[d.name] ?? LayoutDashboard;
          const VisIcon = visibilityIcon(d.visibility);
          return (
            <Link
              key={d.id}
              href={`/dashboard/observability/${d.id}`}
              className="block rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4 hover:border-blue-500 hover:shadow-sm transition-colors"
            >
              <div className="flex items-center gap-3 mb-2">
                <Icon className="w-5 h-5 text-blue-600 dark:text-blue-400" />
                <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 flex-1">{d.name}</h2>
                <VisIcon className="w-3.5 h-3.5 text-gray-400" aria-label={`visibility: ${d.visibility}`} />
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {d.description || 'No description.'}
              </p>
            </Link>
          );
        })}

        {/* Empty state */}
        {!loading && dashboards.length === 0 && !error && (
          <div className="col-span-full rounded border border-gray-200 dark:border-gray-700 p-6 text-center text-sm text-gray-500 dark:text-gray-400">
            No dashboards yet. The platform service seeds 5 default dashboards at cold start — if you don't see them, check Postgres connectivity.
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
