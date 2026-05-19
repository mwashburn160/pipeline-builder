// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback } from 'react';
import { useRouter } from 'next/router';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { LinePanel } from '@/components/observability/LinePanel';
import { StatPanel } from '@/components/observability/StatPanel';
import { RangePicker } from '@/components/observability/RangePicker';
import type { RangeKey } from '@/hooks/useObservabilityQuery';
import { REGISTRY_ACTIVITY_DASHBOARD } from '@/lib/dashboards/registry-activity';

function parseRange(raw: unknown): RangeKey {
  if (raw === '1h' || raw === '6h' || raw === '24h') return raw;
  return '1h';
}

export default function RegistryActivityDashboardPage() {
  const { isReady, isAuthenticated } = useAuthGuard();
  const router = useRouter();
  const range = parseRange(router.query.range);

  const setRange = useCallback((next: RangeKey) => {
    void router.replace({ pathname: router.pathname, query: { ...router.query, range: next } }, undefined, { shallow: true });
  }, [router]);

  if (!isReady || !isAuthenticated) return <LoadingPage />;

  return (
    <DashboardLayout
      title={REGISTRY_ACTIVITY_DASHBOARD.title}
      subtitle="In-cluster Docker registry — copy / delete / promote activity"
      actions={<RangePicker value={range} onChange={setRange} />}
    >
      <div className="grid grid-cols-12 gap-4">
        {REGISTRY_ACTIVITY_DASHBOARD.panels.map((p) => {
          if (p.kind === 'stat') {
            return <StatPanel key={p.id} title={p.title} queryKey={p.queryKey} range={range} span={p.span} />;
          }
          return (
            <LinePanel
              key={p.id}
              title={p.title}
              queryKey={p.queryKey}
              range={range}
              span={p.span}
              groupBy={p.groupBy}
            />
          );
        })}
      </div>
    </DashboardLayout>
  );
}
