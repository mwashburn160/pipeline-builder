// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import Link from 'next/link';
import { Activity, BarChart3 } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';

/**
 * Observability landing page. Lists the available dashboards. Room to
 * grow as more dashboards land in follow-up PRs.
 */
export default function ObservabilityIndexPage() {
  const { isReady, isSysAdmin } = useAuthGuard({ requireSystemAdmin: true });
  if (!isReady || !isSysAdmin) return <LoadingPage />;

  const dashboards = [
    {
      id: 'plugin-builds',
      title: 'Plugin Builds',
      description: 'Build throughput, success rate, duration, and BullMQ queue depth.',
      icon: BarChart3,
    },
    {
      id: 'audit-activity',
      title: 'Audit Activity',
      description: 'Audit events over time, top actors, and a searchable recent-events table.',
      icon: Activity,
    },
  ];

  return (
    <DashboardLayout title="Observability" subtitle="Native operator dashboards over Prometheus + Loki">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {dashboards.map((d) => {
          const Icon = d.icon;
          return (
            <Link
              key={d.id}
              href={`/dashboard/observability/${d.id}`}
              className="block rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4 hover:border-blue-500 hover:shadow-sm transition-colors"
            >
              <div className="flex items-center gap-3 mb-2">
                <Icon className="w-5 h-5 text-blue-600 dark:text-blue-400" />
                <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{d.title}</h2>
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400">{d.description}</p>
            </Link>
          );
        })}
      </div>
    </DashboardLayout>
  );
}
