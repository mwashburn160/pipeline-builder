// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState, useCallback, useMemo } from 'react';
import Link from 'next/link';
import { Layers, GitBranch, Puzzle, RefreshCw } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useListPage } from '@/hooks/useListPage';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { IconButton } from '@/components/ui/IconButton';
import { FilterSelect } from '@/components/ui/FilterSelect';
import { LinkButton } from '@/components/ui/LinkButton';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { ResourceList } from '@/components/ui/ResourceList';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { TabBar, type TabBarItem } from '@/components/ui/TabBar';
import { LifecycleBadge } from '@/components/ui/LifecycleBadge';
import api from '@/lib/api';
import type { Pipeline, Plugin, Lifecycle } from '@/types';

const LIFECYCLE_FILTERS: Array<{ label: string; value: '' | Lifecycle }> = [
  { label: 'All', value: '' },
  { label: 'Production', value: 'production' },
  { label: 'Experimental', value: 'experimental' },
  { label: 'Deprecated', value: 'deprecated' },
];

// Column-id → server sort field. Only columns the list endpoints actually sort
// on (PipelineService/PluginService `getSortColumn`) appear here; the matching
// DataTable columns carry a `sortValue` so their header is clickable. Columns
// NOT sortable server-side (lifecycle, criticality, category) deliberately omit
// `sortValue` so their header stays inert rather than firing a no-op reorder.
const PIPELINE_SORT_FIELD: Record<string, string> = {
  name: 'pipelineName',
  project: 'project',
  updated: 'updatedAt',
};
const PLUGIN_SORT_FIELD: Record<string, string> = {
  name: 'name',
  version: 'version',
  updated: 'updatedAt',
};

/**
 * "My Services" — the developer-portal personal catalog view. Lists the
 * pipelines and plugins the current user OWNS (ownerId = their user id), across
 * the org's catalog, so a developer can find "their stuff" without hunting each
 * feature page. Ownership is the catalog metadata every pipeline/plugin now
 * carries (defaulted to the creator at creation time).
 *
 * Both lists are server-paginated + server-sorted via `useListPage` (the same
 * pattern as the full Plugins catalog page), so there is no client-side row cap:
 * pagination, sorting, and the lifecycle filter all resolve across the ENTIRE
 * owned set, not just a fetched page.
 */
export default function MyServicesPage() {
  const { user, isReady } = useAuthGuard();
  const ownerId = user?.id;
  const enabled = isReady && !!ownerId;

  // Which resource panel is shown. Pipelines and plugins live in the same
  // tabbed panel rather than stacked, so the page stays compact.
  const [tab, setTab] = useState<'pipelines' | 'plugins'>('pipelines');

  // ── Owner-scoped, server-paginated lists (one per tab) ──
  // Both fetch on mount so each tab label can show its true total. `ownerId` and
  // `includeTotal` are baked into the fetcher; `lifecycle` is a server filter so
  // it composes with pagination. urlSync is off: two hooks on one page would
  // otherwise both write offset/sortBy to the URL and clobber each other.
  const pipelinesList = useListPage<Pipeline>({
    fields: [{ key: 'lifecycle', type: 'select', defaultValue: '' }],
    initialSort: { sortBy: 'updatedAt', sortOrder: 'desc' },
    fetcher: async (params) => {
      const p: Record<string, string> = {
        ownerId: ownerId as string,
        limit: params.limit,
        offset: params.offset,
        includeTotal: 'true',
      };
      if (params.sortBy) p.sortBy = params.sortBy;
      if (params.sortOrder) p.sortOrder = params.sortOrder;
      if (params.lifecycle) p.lifecycle = params.lifecycle;
      const res = await api.listPipelines(p);
      return { items: res.data?.pipelines || [], pagination: res.data?.pagination };
    },
    enabled,
  });

  const pluginsList = useListPage<Plugin>({
    fields: [{ key: 'lifecycle', type: 'select', defaultValue: '' }],
    initialSort: { sortBy: 'updatedAt', sortOrder: 'desc' },
    fetcher: async (params) => {
      const p: Record<string, string> = {
        ownerId: ownerId as string,
        limit: params.limit,
        offset: params.offset,
        includeTotal: 'true',
      };
      if (params.sortBy) p.sortBy = params.sortBy;
      if (params.sortOrder) p.sortOrder = params.sortOrder;
      if (params.lifecycle) p.lifecycle = params.lifecycle;
      const res = await api.listPlugins(p);
      return { items: res.data?.plugins || [], pagination: res.data?.pagination };
    },
    enabled,
  });

  // ── Shared lifecycle filter — one control drives both lists ──
  const { updateFilter: updatePipelineFilter } = pipelinesList;
  const { updateFilter: updatePluginFilter } = pluginsList;
  const lifecycle = (pipelinesList.filters.lifecycle ?? '') as '' | Lifecycle;
  const setLifecycle = useCallback((value: string) => {
    updatePipelineFilter('lifecycle', value);
    updatePluginFilter('lifecycle', value);
  }, [updatePipelineFilter, updatePluginFilter]);

  const { refresh: refreshPipelines } = pipelinesList;
  const { refresh: refreshPlugins } = pluginsList;
  const refreshAll = useCallback(() => {
    refreshPipelines();
    refreshPlugins();
  }, [refreshPipelines, refreshPlugins]);
  const loading = pipelinesList.isLoading || pluginsList.isLoading;

  // ── Server-side sort: a header click → sortBy/sortOrder for that list ──
  const { setSort: setPipelineSort } = pipelinesList;
  const { setSort: setPluginSort } = pluginsList;
  const handlePipelineSort = useCallback((columnId: string, direction: 'asc' | 'desc') => {
    setPipelineSort(PIPELINE_SORT_FIELD[columnId] ?? columnId, direction);
  }, [setPipelineSort]);
  const handlePluginSort = useCallback((columnId: string, direction: 'asc' | 'desc') => {
    setPluginSort(PLUGIN_SORT_FIELD[columnId] ?? columnId, direction);
  }, [setPluginSort]);

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
    { id: 'lifecycle', header: 'Lifecycle', render: (p) => <LifecycleBadge value={p.lifecycle} /> },
    { id: 'criticality', header: 'Criticality', render: (p) => <>{p.criticality || '—'}</> },
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
    { id: 'category', header: 'Category', render: (p) => <>{p.category || '—'}</> },
    { id: 'lifecycle', header: 'Lifecycle', render: (p) => <LifecycleBadge value={p.lifecycle} /> },
    { id: 'updated', header: 'Updated', render: (p) => <RelativeTime value={p.updatedAt} />, sortValue: (p) => p.updatedAt },
  ], []);

  const tabItems: TabBarItem[] = [
    {
      id: 'pipelines',
      label: (
        <span className="inline-flex items-center gap-1.5">
          <GitBranch className="w-4 h-4" /> Pipelines
          <span className="text-gray-400 font-normal">({pipelinesList.pagination.total})</span>
        </span>
      ),
    },
    {
      id: 'plugins',
      label: (
        <span className="inline-flex items-center gap-1.5">
          <Puzzle className="w-4 h-4" /> Plugins
          <span className="text-gray-400 font-normal">({pluginsList.pagination.total})</span>
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
          <FilterSelect
            value={lifecycle}
            onChange={(e) => setLifecycle(e.target.value)}
            aria-label="Filter by lifecycle"
          >
            {LIFECYCLE_FILTERS.map((f) => (
              <option key={f.value} value={f.value}>{f.label}</option>
            ))}
          </FilterSelect>
          <IconButton onClick={refreshAll} title="Refresh" aria-label="Refresh" disabled={loading}>
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </IconButton>
        </div>
      }
    >
      <div className="page-section">
        <TabBar items={tabItems} activeId={tab} onSelect={(id) => setTab(id as 'pipelines' | 'plugins')} />

        {tab === 'pipelines' ? (
          <ResourceList<Pipeline>
            loading={pipelinesList.isLoading}
            error={pipelinesList.error}
            onRefresh={refreshPipelines}
            isEmpty={pipelinesList.data.length === 0}
            pagination={pipelinesList.pagination}
            onPageChange={pipelinesList.handlePageChange}
            onPageSizeChange={pipelinesList.handlePageSizeChange}
            errorTitle="Failed to load your pipelines"
            emptyState={{
              icon: Layers,
              title: 'No pipelines owned by you',
              description: 'Pipelines you create are assigned to you and appear here.',
              action: (
                <LinkButton href="/dashboard/pipelines">
                  Go to Pipelines
                </LinkButton>
              ),
            }}
          >
            <DataTable
              data={pipelinesList.data}
              columns={pipelineColumns}
              isLoading={pipelinesList.isLoading}
              getRowKey={(p) => p.id}
              defaultSortColumn="updated"
              defaultSortDirection="desc"
              serverSort
              onSortChange={handlePipelineSort}
              emptyState={{ icon: Layers, title: 'No pipelines owned by you', description: 'Pipelines you create are assigned to you and appear here.' }}
            />
          </ResourceList>
        ) : (
          <ResourceList<Plugin>
            loading={pluginsList.isLoading}
            error={pluginsList.error}
            onRefresh={refreshPlugins}
            isEmpty={pluginsList.data.length === 0}
            pagination={pluginsList.pagination}
            onPageChange={pluginsList.handlePageChange}
            onPageSizeChange={pluginsList.handlePageSizeChange}
            errorTitle="Failed to load your plugins"
            emptyState={{
              icon: Layers,
              title: 'No plugins owned by you',
              description: 'Plugins you upload or generate are assigned to you and appear here.',
            }}
          >
            <DataTable
              data={pluginsList.data}
              columns={pluginColumns}
              isLoading={pluginsList.isLoading}
              getRowKey={(p) => p.id}
              defaultSortColumn="updated"
              defaultSortDirection="desc"
              serverSort
              onSortChange={handlePluginSort}
              emptyState={{ icon: Layers, title: 'No plugins owned by you', description: 'Plugins you upload or generate are assigned to you and appear here.' }}
            />
          </ResourceList>
        )}
      </div>
    </DashboardLayout>
  );
}
