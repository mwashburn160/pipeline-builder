// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState, useEffect, useCallback, useMemo } from 'react';
import Link from 'next/link';
import { Layers, GitBranch, Puzzle, RefreshCw } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { formatError } from '@/lib/constants';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { IconButton } from '@/components/ui/IconButton';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { ResourceList } from '@/components/ui/ResourceList';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { TabBar, type TabBarItem } from '@/components/ui/TabBar';
import api from '@/lib/api';
import type { Pipeline, Plugin, Lifecycle } from '@/types';

/** Lifecycle → badge styling. Unset (legacy rows) render as "production". */
const LIFECYCLE_STYLES: Record<Lifecycle, string> = {
  experimental: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
  production: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  deprecated: 'bg-gray-200 text-gray-700 dark:bg-gray-700/40 dark:text-gray-300',
};

function LifecycleBadge({ value }: { value?: Lifecycle | null }) {
  const lc: Lifecycle = value ?? 'production';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium ${LIFECYCLE_STYLES[lc]}`}>
      {lc}
    </span>
  );
}

const LIFECYCLE_FILTERS: Array<{ label: string; value: '' | Lifecycle }> = [
  { label: 'All', value: '' },
  { label: 'Production', value: 'production' },
  { label: 'Experimental', value: 'experimental' },
  { label: 'Deprecated', value: 'deprecated' },
];

/**
 * "My Services" — the developer-portal personal catalog view. Lists the
 * pipelines and plugins the current user OWNS (ownerId = their user id), across
 * the org's catalog, so a developer can find "their stuff" without hunting each
 * feature page. Ownership is the catalog metadata every pipeline/plugin now
 * carries (defaulted to the creator at creation time).
 */
export default function MyServicesPage() {
  const { user, isReady } = useAuthGuard();

  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [loading, setLoading] = useState(false);
  // Per-section errors, so a failure in one list doesn't blank the section that
  // DID load (a single shared error is passed to both ResourceLists, which each
  // render error-XOR-body — so one failure would hide both).
  const [pipelinesError, setPipelinesError] = useState<string | null>(null);
  const [pluginsError, setPluginsError] = useState<string | null>(null);
  const [lifecycle, setLifecycle] = useState<'' | Lifecycle>('');
  // Which resource panel is shown. Pipelines and plugins live in the same
  // tabbed panel rather than stacked, so the page stays compact.
  const [tab, setTab] = useState<'pipelines' | 'plugins'>('pipelines');

  const ownerId = user?.id;

  const fetchAll = useCallback(async () => {
    if (!ownerId) return;
    setLoading(true);
    setPipelinesError(null);
    setPluginsError(null);
    try {
      // Owner-scoped catalog reads run in parallel. `ownerId` is applied
      // server-side by the shared access-control query builder.
      const [pRes, plRes] = await Promise.all([
        api.listPipelines({ ownerId, limit: '200', includeTotal: 'false' }),
        api.listPlugins({ ownerId, limit: '200' }),
      ]);
      if (pRes.success && pRes.data) setPipelines(pRes.data.pipelines || []);
      else setPipelinesError('Failed to load your pipelines. Please retry.');
      if (plRes.success && plRes.data) setPlugins(plRes.data.plugins || []);
      else setPluginsError('Failed to load your plugins. Please retry.');
    } catch (err) {
      const msg = formatError(err, 'Failed to load your services');
      setPipelinesError(msg);
      setPluginsError(msg);
    } finally {
      setLoading(false);
    }
  }, [ownerId]);

  useEffect(() => {
    if (isReady) void fetchAll();
  }, [isReady, fetchAll]);

  const shownPipelines = useMemo(
    () => (lifecycle ? pipelines.filter((p) => (p.lifecycle ?? 'production') === lifecycle) : pipelines),
    [pipelines, lifecycle],
  );
  const shownPlugins = useMemo(
    () => (lifecycle ? plugins.filter((p) => (p.lifecycle ?? 'production') === lifecycle) : plugins),
    [plugins, lifecycle],
  );

  const pipelineColumns: Column<Pipeline>[] = useMemo(() => [
    {
      id: 'name',
      header: 'Pipeline',
      render: (p) => (
        <Link href={`/dashboard/pipelines/${p.id}`} className="text-blue-600 dark:text-blue-400 hover:underline font-medium">
          {p.pipelineName || p.project}
        </Link>
      ),
      sortValue: (p) => p.pipelineName || p.project,
    },
    { id: 'project', header: 'Project', render: (p) => <>{p.project}</>, sortValue: (p) => p.project },
    { id: 'lifecycle', header: 'Lifecycle', render: (p) => <LifecycleBadge value={p.lifecycle} />, sortValue: (p) => p.lifecycle ?? 'production' },
    { id: 'criticality', header: 'Criticality', render: (p) => <>{p.criticality || '—'}</>, sortValue: (p) => p.criticality ?? '' },
    { id: 'updated', header: 'Updated', render: (p) => <RelativeTime value={p.updatedAt} />, sortValue: (p) => p.updatedAt },
  ], []);

  const pluginColumns: Column<Plugin>[] = useMemo(() => [
    {
      id: 'name',
      header: 'Plugin',
      render: (p) => (
        <Link href={`/dashboard/plugins?q=${encodeURIComponent(p.name)}`} className="text-blue-600 dark:text-blue-400 hover:underline font-medium">
          {p.name}
        </Link>
      ),
      sortValue: (p) => p.name,
    },
    { id: 'version', header: 'Version', render: (p) => <>{p.version}</>, sortValue: (p) => p.version },
    { id: 'category', header: 'Category', render: (p) => <>{p.category || '—'}</>, sortValue: (p) => p.category ?? '' },
    { id: 'lifecycle', header: 'Lifecycle', render: (p) => <LifecycleBadge value={p.lifecycle} />, sortValue: (p) => p.lifecycle ?? 'production' },
    { id: 'updated', header: 'Updated', render: (p) => <RelativeTime value={p.updatedAt} />, sortValue: (p) => p.updatedAt },
  ], []);

  const tabItems: TabBarItem[] = [
    {
      id: 'pipelines',
      label: (
        <span className="inline-flex items-center gap-1.5">
          <GitBranch className="w-4 h-4" /> Pipelines
          <span className="text-gray-400 font-normal">({shownPipelines.length})</span>
        </span>
      ),
    },
    {
      id: 'plugins',
      label: (
        <span className="inline-flex items-center gap-1.5">
          <Puzzle className="w-4 h-4" /> Plugins
          <span className="text-gray-400 font-normal">({shownPlugins.length})</span>
        </span>
      ),
    },
  ];

  if (!isReady || !user) return <LoadingPage />;

  return (
    <DashboardLayout
      title="My Services"
      subtitle="Pipelines and plugins you own across the catalog"
      actions={
        <div className="flex items-center gap-2">
          <select
            value={lifecycle}
            onChange={(e) => setLifecycle(e.target.value as '' | Lifecycle)}
            className="text-sm rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1.5"
            aria-label="Filter by lifecycle"
          >
            {LIFECYCLE_FILTERS.map((f) => (
              <option key={f.value} value={f.value}>{f.label}</option>
            ))}
          </select>
          <IconButton onClick={fetchAll} title="Refresh" aria-label="Refresh" disabled={loading}>
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </IconButton>
        </div>
      }
    >
      <div className="page-section">
        <TabBar items={tabItems} activeId={tab} onSelect={(id) => setTab(id as 'pipelines' | 'plugins')} />

        {tab === 'pipelines' ? (
          <ResourceList<Pipeline>
            loading={loading}
            error={pipelinesError}
            onRefresh={fetchAll}
            isEmpty={shownPipelines.length === 0}
            errorTitle="Failed to load your pipelines"
            emptyState={{
              icon: Layers,
              title: 'No pipelines owned by you',
              description: 'Pipelines you create are assigned to you and appear here.',
              action: (
                <Link href="/dashboard/pipelines" className="btn btn-primary">
                  Go to Pipelines
                </Link>
              ),
            }}
          >
            <DataTable
              data={shownPipelines}
              columns={pipelineColumns}
              isLoading={loading}
              getRowKey={(p) => p.id}
              emptyState={{ icon: Layers, title: 'No pipelines owned by you', description: 'Pipelines you create are assigned to you and appear here.' }}
            />
          </ResourceList>
        ) : (
          <ResourceList<Plugin>
            loading={loading}
            error={pluginsError}
            onRefresh={fetchAll}
            isEmpty={shownPlugins.length === 0}
            errorTitle="Failed to load your plugins"
            emptyState={{
              icon: Layers,
              title: 'No plugins owned by you',
              description: 'Plugins you upload or generate are assigned to you and appear here.',
            }}
          >
            <DataTable
              data={shownPlugins}
              columns={pluginColumns}
              isLoading={loading}
              getRowKey={(p) => p.id}
              emptyState={{ icon: Layers, title: 'No plugins owned by you', description: 'Plugins you upload or generate are assigned to you and appear here.' }}
            />
          </ResourceList>
        )}
      </div>
    </DashboardLayout>
  );
}
