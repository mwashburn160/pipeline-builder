// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback } from 'react';
import { useRouter } from 'next/router';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { LinePanel } from '@/components/observability/LinePanel';
import { StatPanel } from '@/components/observability/StatPanel';
import { TablePanel } from '@/components/observability/TablePanel';
import { RangePicker } from '@/components/observability/RangePicker';
import type { RangeKey } from '@/hooks/useObservabilityQuery';
import { PLUGIN_BUILDS_DASHBOARD } from '@/lib/dashboards/plugin-builds';

const FORMATTERS = {
  percent: (v: number) => `${(v * 100).toFixed(1)}%`,
  seconds: (v: number) => v < 60 ? `${v.toFixed(1)}s` : `${(v / 60).toFixed(1)}m`,
};

function parseRange(raw: unknown): RangeKey {
  if (raw === '1h' || raw === '6h' || raw === '24h') return raw;
  return '1h';
}

/** Sanitize a plugin name from the URL — backend has its own validator,
 *  but rejecting bogus input client-side avoids a roundtrip + 400. */
function parsePlugin(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  if (!raw || raw.length > 128) return undefined;
  if (!/^[a-zA-Z0-9._-]+$/.test(raw)) return undefined;
  return raw;
}

export default function PluginBuildsDashboardPage() {
  const { isReady, isAuthenticated } = useAuthGuard();
  const router = useRouter();

  const range = parseRange(router.query.range);
  const plugin = parsePlugin(router.query.plugin);

  const setRange = useCallback((next: RangeKey) => {
    void router.replace({ pathname: router.pathname, query: { ...router.query, range: next } }, undefined, { shallow: true });
  }, [router]);

  const clearPlugin = useCallback(() => {
    const { plugin: _drop, ...rest } = router.query;
    void router.replace({ pathname: router.pathname, query: rest }, undefined, { shallow: true });
  }, [router]);

  if (!isReady || !isAuthenticated) return <LoadingPage />;

  return (
    <DashboardLayout
      title={PLUGIN_BUILDS_DASHBOARD.title}
      subtitle="Plugin-service Prometheus metrics"
      actions={<RangePicker value={range} onChange={setRange} />}
    >
      {plugin && (
        <div className="mb-4 flex items-center gap-2 text-sm rounded border border-blue-300 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 px-3 py-2 text-blue-900 dark:text-blue-200">
          <span>Filtering to plugin <code className="font-mono font-semibold">{plugin}</code></span>
          <button
            onClick={clearPlugin}
            className="ml-auto px-2 py-0.5 text-xs border border-blue-400 dark:border-blue-700 rounded hover:bg-white dark:hover:bg-gray-800"
          >
            Clear
          </button>
        </div>
      )}

      <div className="grid grid-cols-12 gap-4">
        {plugin ? (
          // Per-plugin drill-down panels — sourced from the
          // plugin_builds_*_for_plugin catalog entries. Counter-only;
          // duration / recent-builds come from PR-D2's Loki path.
          <>
            <StatPanel
              title="Total builds (24h)"
              queryKey="plugin_builds_total_24h_for_plugin"
              range={range}
              span={3}
              vars={{ plugin }}
            />
            <LinePanel
              title="Builds per minute"
              queryKey="plugin_builds_for_plugin"
              range={range}
              span={9}
              groupBy="status"
              vars={{ plugin }}
            />
            <LinePanel
              title="Success rate (5m)"
              queryKey="plugin_builds_success_rate_for_plugin"
              range={range}
              span={12}
              format={FORMATTERS.percent}
              vars={{ plugin }}
            />
            {/* Loki-backed recent builds — sourced from structured log lines
                emitted by api/plugin/src/queue/plugin-build-queue.ts. The query
                filters by the `pluginName` label promtail promotes from the
                JSON log fields; the `plugin` template variable is sanitized
                server-side via the catalog's allowedVars list. */}
            <TablePanel
              title="Recent builds"
              queryKey="plugin_recent_builds"
              range={range}
              span={12}
              mode="logs"
              logOpts={{ plugin, limit: 100 }}
            />
          </>
        ) : (
          PLUGIN_BUILDS_DASHBOARD.panels.map((p) => {
            if (p.kind === 'stat') {
              return (
                <StatPanel
                  key={p.id}
                  title={p.title}
                  queryKey={p.queryKey}
                  range={range}
                  span={p.span}
                />
              );
            }
            return (
              <LinePanel
                key={p.id}
                title={p.title}
                queryKey={p.queryKey}
                range={range}
                span={p.span}
                groupBy={p.groupBy}
                format={p.format ? FORMATTERS[p.format] : undefined}
              />
            );
          })
        )}
      </div>
    </DashboardLayout>
  );
}
