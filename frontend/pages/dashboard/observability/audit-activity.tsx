// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback } from 'react';
import { useRouter } from 'next/router';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { StackedBarPanel } from '@/components/observability/StackedBarPanel';
import { TablePanel } from '@/components/observability/TablePanel';
import { RangePicker } from '@/components/observability/RangePicker';
import type { RangeKey } from '@/hooks/useObservabilityQuery';
import { AUDIT_ACTIVITY_DASHBOARD } from '@/lib/dashboards/audit-activity';

function parseRange(raw: unknown): RangeKey {
  if (raw === '1h' || raw === '6h' || raw === '24h') return raw;
  return '1h';
}

function getStr(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

/**
 * Native replacement for the Grafana Explore audit-log surface.
 *
 * URL params consumed (set by `buildAuditLogLink` from RecentActionsPanel):
 *   ?event=<event>           — filter recent-events table to one event name
 *   ?actor=<actor>           — filter to one actor (user or service principal)
 *   ?digest=<sha256:...>     — line-filter on digest (accepted but not yet
 *                              wired to a panel — placeholder for v2)
 *   ?range=1h|6h|24h         — time range preset
 *
 * The page is sysadmin-only; org-scoping is deferred (see plan).
 */
export default function AuditActivityDashboardPage() {
  const { isReady, isAuthenticated } = useAuthGuard();
  const router = useRouter();

  const range = parseRange(router.query.range);
  const event = getStr(router.query.event);
  const actor = getStr(router.query.actor);
  const digest = getStr(router.query.digest);

  const setRange = useCallback((next: RangeKey) => {
    void router.replace({ pathname: router.pathname, query: { ...router.query, range: next } }, undefined, { shallow: true });
  }, [router]);

  const clearFilter = useCallback(() => {
    void router.replace({ pathname: router.pathname, query: { range } }, undefined, { shallow: true });
  }, [router, range]);

  if (!isReady || !isAuthenticated) return <LoadingPage />;

  const hasFilter = !!(event || actor || digest);

  return (
    <DashboardLayout
      title={AUDIT_ACTIVITY_DASHBOARD.title}
      subtitle="Audit events from the platform's structured logs (Loki)"
      actions={<RangePicker value={range} onChange={setRange} />}
    >
      {hasFilter && (
        <div className="mb-4 flex items-center gap-2 px-3 py-2 rounded border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 text-xs">
          <span className="text-blue-700 dark:text-blue-300 font-medium">Filtered by:</span>
          {event && <span className="font-mono text-blue-700 dark:text-blue-300">event={event}</span>}
          {actor && <span className="font-mono text-blue-700 dark:text-blue-300">actor={actor}</span>}
          {digest && <span className="font-mono text-blue-700 dark:text-blue-300 break-all">digest={digest.slice(0, 19)}…</span>}
          <button
            onClick={clearFilter}
            className="ml-auto text-blue-700 dark:text-blue-300 underline hover:no-underline"
          >
            Clear
          </button>
        </div>
      )}
      <div className="grid grid-cols-12 gap-4">
        {AUDIT_ACTIVITY_DASHBOARD.panels.map((p) => {
          if (p.kind === 'stackedbar') {
            return (
              <StackedBarPanel
                key={p.id}
                title={p.title}
                queryKey={p.queryKey}
                range={range}
                span={p.span}
                groupBy={p.groupBy}
              />
            );
          }
          if (p.kind === 'table-topk') {
            return (
              <TablePanel
                key={p.id}
                title={p.title}
                queryKey={p.queryKey}
                range={range}
                span={p.span}
                mode="topk"
                topkLabel={p.groupBy ?? 'actor'}
              />
            );
          }
          // table-logs
          return (
            <TablePanel
              key={p.id}
              title={p.title}
              queryKey={p.queryKey}
              range={range}
              span={p.span}
              mode="logs"
              logOpts={p.acceptUrlFilters ? { event, actor, digest, limit: 50 } : undefined}
            />
          );
        })}
      </div>
    </DashboardLayout>
  );
}
