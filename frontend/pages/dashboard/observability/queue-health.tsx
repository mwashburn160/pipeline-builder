// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback } from 'react';
import { useRouter } from 'next/router';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { LinePanel } from '@/components/observability/LinePanel';
import { RangePicker } from '@/components/observability/RangePicker';
import type { RangeKey } from '@/hooks/useObservabilityQuery';
import { QUEUE_HEALTH_DASHBOARD } from '@/lib/dashboards/queue-health';

const FORMATTERS = {
  percent: (v: number) => `${(v * 100).toFixed(1)}%`,
  seconds: (v: number) => v < 60 ? `${v.toFixed(1)}s` : `${(v / 60).toFixed(1)}m`,
};

function parseRange(raw: unknown): RangeKey {
  if (raw === '1h' || raw === '6h' || raw === '24h') return raw;
  return '1h';
}

export default function QueueHealthDashboardPage() {
  const { isReady, isAuthenticated } = useAuthGuard();
  const router = useRouter();
  const range = parseRange(router.query.range);

  const setRange = useCallback((next: RangeKey) => {
    void router.replace({ pathname: router.pathname, query: { ...router.query, range: next } }, undefined, { shallow: true });
  }, [router]);

  if (!isReady || !isAuthenticated) return <LoadingPage />;

  return (
    <DashboardLayout
      title={QUEUE_HEALTH_DASHBOARD.title}
      subtitle="BullMQ + DLQ deep-dive"
      actions={<RangePicker value={range} onChange={setRange} />}
    >
      <div className="grid grid-cols-12 gap-4">
        {QUEUE_HEALTH_DASHBOARD.panels.map((p) => (
          <LinePanel
            key={p.id}
            title={p.title}
            queryKey={p.queryKey}
            range={range}
            span={p.span}
            groupBy={p.groupBy}
            format={p.format ? FORMATTERS[p.format] : undefined}
          />
        ))}
      </div>
    </DashboardLayout>
  );
}
