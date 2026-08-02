// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Activity, BarChart3, Bell, LayoutDashboard, ListChecks, Boxes, Plus, Lock, Building2, Globe, ScrollText, Search } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useFetch } from '@/hooks/useFetch';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { api } from '@/lib/api';
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
  const { isReady, isAuthenticated, can } = useAuthGuard();
  const canCreateDashboard = can('dashboards:write');
  const ready = isReady && isAuthenticated;
  const { data, loading, error } = useFetch(
    async () => (ready ? (await api.listDashboards()).data?.dashboards ?? [] : []),
    [ready],
  );
  const dashboards: Dashboard[] = data ?? [];

  // Client-side grid filters over the already-fetched dashboards (no backend
  // call): free-text over the name + a visibility quick-filter.
  const [search, setSearch] = useState('');
  const [visibility, setVisibility] = useState<'all' | Dashboard['visibility']>('all');
  const filteredDashboards = useMemo(() => {
    const q = search.trim().toLowerCase();
    return dashboards.filter((d) => {
      if (visibility !== 'all' && d.visibility !== visibility) return false;
      if (q && !d.name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [dashboards, search, visibility]);

  const VISIBILITY_CHIPS: { id: 'all' | Dashboard['visibility']; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'public', label: 'Public' },
    { id: 'org', label: 'Org' },
    { id: 'private', label: 'Private' },
  ];

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
        // Only surface the create entry point to users who can actually create a
        // dashboard (the destination already disables its Create button, but a
        // read-only/no-write user shouldn't be led to a dead end). Mirrors the
        // Pipelines page hiding "Create Pipeline" when !canWrite.
        canCreateDashboard ? (
          <Link
            href="/dashboard/observability/new"
            className="inline-flex items-center gap-1 px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-50 dark:hover:bg-gray-800"
          >
            <Plus className="w-3.5 h-3.5" /> New dashboard
          </Link>
        ) : undefined
      }
    >
      {error && (
        <div className="mb-4 rounded border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-800 dark:text-red-200">
          {error.message}
        </div>
      )}

      {/* Client-side filters over the dashboard tiles below (the fixed
          Alerts/Rules/Logs links are always shown). */}
      <div className="mb-4 flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-gray-500" />
          <input
            type="text"
            placeholder="Search dashboards..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="filter-input"
          />
        </div>
        <div className="flex items-center gap-1">
          {VISIBILITY_CHIPS.map((c) => {
            const active = visibility === c.id;
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => setVisibility(c.id)}
                aria-pressed={active}
                className={`px-2.5 py-1 text-xs font-medium rounded-full border transition-colors ${
                  active
                    ? 'border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
                    : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'
                }`}
              >
                {c.label}
              </button>
            );
          })}
        </div>
      </div>

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

        {/* Per-org alert rules — the PromQL conditions that fire alerts. */}
        <Link
          href="/dashboard/observability/alert-rules"
          className="block rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4 hover:border-blue-500 hover:shadow-sm transition-colors"
        >
          <div className="flex items-center gap-3 mb-2">
            <Activity className="w-5 h-5 text-blue-600 dark:text-blue-400" />
            <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Alert rules</h2>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Author PromQL conditions that fire alerts — auto-scoped to your org&apos;s metrics.
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

        {/* Service / pipeline logs (Loki). Also in the top-nav, surfaced here so
            the observability area cross-links the full log search. */}
        <Link
          href="/dashboard/logs"
          className="block rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4 hover:border-blue-500 hover:shadow-sm transition-colors"
        >
          <div className="flex items-center gap-3 mb-2">
            <ScrollText className="w-5 h-5 text-blue-600 dark:text-blue-400" />
            <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Logs</h2>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Search service and pipeline logs (Loki) with structured filters.
          </p>
        </Link>

        {/* Loading placeholder — skeleton cards mirroring the dashboard tiles below. */}
        {loading && Array.from({ length: 4 }).map((_, i) => (
          <div key={`sk-${i}`} className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4">
            <div className="h-4 skeleton w-1/2 mb-2" />
            <div className="h-3 skeleton w-3/4" />
          </div>
        ))}

        {/* DB-stored dashboards (seeded defaults + org-created), after client filters. */}
        {filteredDashboards.map((d) => {
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

        {/* No-match state — dashboards exist but the active filters hide them all. */}
        {!loading && dashboards.length > 0 && filteredDashboards.length === 0 && (
          <div className="col-span-full rounded border border-gray-200 dark:border-gray-700 p-6 text-center text-sm text-gray-500 dark:text-gray-400">
            No dashboards match your filters.
          </div>
        )}

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
