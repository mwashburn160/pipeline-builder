// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Sysadmin cross-tenant alert destinations viewer.
 *
 * Surfaces every alert destination across every org in one place so the
 * platform team can answer questions like "is org X actually wired up to
 * Slack" or "which orgs have no notification destinations" without
 * impersonating each org. Read-only — destinations remain owned by the
 * org admins; sysadmins editing tenant notification surfaces would be a
 * trust violation.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Bell, ArrowLeft, Search } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useFetch } from '@/hooks/useFetch';
import { LoadingPage, LoadingSpinner } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { Badge } from '@/components/ui/Badge';
import { CopyableId } from '@/components/ui/CopyableId';
import api from '@/lib/api';
import type { AlertDestination } from '@/types/observability';

export default function AdminAlertDestinationsPage() {
  const { isReady, user } = useAuthGuard({ requireSystemAdmin: true });

  const [search, setSearch] = useState('');
  const [channelFilter, setChannelFilter] = useState<'all' | 'slack' | 'webhook' | 'in-app'>('all');

  const { data, loading, error } = useFetch(
    async () => {
      if (!isReady) return [] as AlertDestination[];
      const res = await api.listAlertDestinations({ all: true });
      if (res.success && res.data) return res.data.destinations;
      throw new Error(res.message || 'Failed to load destinations');
    },
    [isReady],
  );
  const destinations: AlertDestination[] = data ?? [];
  const [dismissedError, setDismissedError] = useState(false);
  // Reset dismissal when a fresh error arrives so a new failure isn't hidden.
  useEffect(() => { if (error) setDismissedError(false); }, [error]);

  // Group by org for the visual layout — operators reason about
  // "what does org X have" more naturally than a flat list.
  const grouped = useMemo(() => {
    const term = search.trim().toLowerCase();
    const filtered = destinations.filter((d) => {
      if (channelFilter !== 'all' && d.channel !== channelFilter) return false;
      if (!term) return true;
      return d.orgId.toLowerCase().includes(term)
        || d.label.toLowerCase().includes(term);
    });
    const map = new Map<string, AlertDestination[]>();
    for (const d of filtered) {
      const list = map.get(d.orgId) ?? [];
      list.push(d);
      map.set(d.orgId, list);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [destinations, search, channelFilter]);

  const stats = useMemo(() => ({
    orgs: new Set(destinations.map((d) => d.orgId)).size,
    total: destinations.length,
    enabled: destinations.filter((d) => d.enabled).length,
    slack: destinations.filter((d) => d.channel === 'slack').length,
    webhook: destinations.filter((d) => d.channel === 'webhook').length,
    inApp: destinations.filter((d) => d.channel === 'in-app').length,
  }), [destinations]);

  if (!isReady || !user) return <LoadingPage />;

  return (
    <DashboardLayout
      title="Alert destinations (all orgs)"
      subtitle="Cross-tenant view — read-only"
      titleExtra={<Badge color="red">System Admin</Badge>}
    >
      <div className="mb-4">
        <Link href="/dashboard" className="action-link inline-flex items-center gap-1 text-sm">
          <ArrowLeft className="w-4 h-4" /> Back to admin home
        </Link>
      </div>

      {error && !dismissedError && (
        <div className="alert-error mb-4">
          <p>{error.message}</p>
          <button onClick={() => setDismissedError(true)} className="action-link-danger mt-2 underline">Dismiss</button>
        </div>
      )}

      {/* Stat row */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-2 mb-4">
        {[
          { label: 'Orgs with destinations', value: stats.orgs },
          { label: 'Destinations total', value: stats.total },
          { label: 'Enabled', value: stats.enabled },
          { label: 'Slack', value: stats.slack },
          { label: 'Webhook', value: stats.webhook },
          { label: 'In-app', value: stats.inApp },
        ].map((s) => (
          <div key={s.label} className="card text-center">
            <div className="text-xs text-gray-500 dark:text-gray-400">{s.label}</div>
            <div className="text-xl font-semibold text-gray-900 dark:text-gray-100">{s.value}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="filter-bar flex flex-wrap items-center gap-2 mb-4">
        <div className="relative flex-1 min-w-[16rem]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-gray-500" />
          <input
            type="text"
            placeholder="Filter by org id or label..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="filter-input"
          />
        </div>
        <select
          value={channelFilter}
          onChange={(e) => setChannelFilter(e.target.value as typeof channelFilter)}
          className="filter-select"
          aria-label="Filter by channel"
        >
          <option value="all">All channels</option>
          <option value="slack">Slack</option>
          <option value="webhook">Webhook</option>
          <option value="in-app">In-app</option>
        </select>
      </div>

      {loading && <LoadingSpinner />}

      {!loading && grouped.length === 0 && (
        <div className="card py-10 text-center text-sm text-gray-500 dark:text-gray-400">
          <Bell className="w-8 h-8 mx-auto mb-2 opacity-50" />
          No destinations match the current filters.
        </div>
      )}

      <div className="space-y-3">
        {grouped.map(([orgId, items]) => (
          <div key={orgId} className="card">
            <div className="flex items-center justify-between mb-3 pb-2 border-b border-gray-200 dark:border-gray-700">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Org:</span>
                <CopyableId value={orgId} small />
              </div>
              <Link
                href={`/dashboard/admin/orgs/${orgId}`}
                className="action-link text-xs"
              >
                Open org detail
              </Link>
            </div>
            <ul className="divide-y divide-gray-100 dark:divide-gray-800">
              {items.map((d) => (
                <li key={d.id} className="py-2 flex flex-wrap items-baseline gap-2 text-sm">
                  <Badge color={d.channel === 'slack' ? 'purple' : d.channel === 'webhook' ? 'blue' : 'gray'}>
                    {d.channel}
                  </Badge>
                  <span className="font-medium text-gray-900 dark:text-gray-100">{d.label}</span>
                  <Badge color={d.minSeverity === 'critical' ? 'red' : 'yellow'}>{d.minSeverity}</Badge>
                  {!d.enabled && <Badge color="gray">disabled</Badge>}
                  {d.hasTarget && (
                    <code className="text-xs text-gray-500 dark:text-gray-400 ml-auto">{d.target}</code>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="mt-6 text-xs text-gray-500 dark:text-gray-400">
        Read-only — destinations are owned by org admins. To edit, impersonate
        the org or ask the org owner. Targets are masked here even for sysadmins;
        the full secret URL is only sent back on the org-scoped GET to the org&apos;s own admins.
      </div>
    </DashboardLayout>
  );
}
