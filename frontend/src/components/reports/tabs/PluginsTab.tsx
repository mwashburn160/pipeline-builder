// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect } from 'react';
import { TabBar } from '@/components/ui/TabBar';
import { PluginOverview } from '../PluginOverview';
import { PluginBuilds } from '../PluginBuilds';
import { PluginVersions } from '../PluginVersions';
import {
  usePluginsData, type PluginSubTab, type SharedFilters, type TabDataStatus,
} from '../useReportData';
import { useUrlTab } from '@/hooks/useUrlTab';

const PLUGIN_TABS: { id: PluginSubTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'builds', label: 'Builds' },
  { id: 'versions', label: 'Versions' },
];

interface PluginsTabProps {
  filters: SharedFilters;
  /** Report loading/error/refetch up to the shell (for the shared banner + refresh). */
  onStatus: (status: TabDataStatus) => void;
}

/**
 * Plugins top-tab: owns the overview/builds/versions sub-tab state, fetches its
 * slices via {@link usePluginsData}, and renders the matching panel. Each panel
 * carries its own consolidated empty state with a next-step hint.
 */
export function PluginsTab({ filters, onStatus }: PluginsTabProps) {
  // Sub-tab in the URL too, so `?tab=pipelines&sub=performance` reopens the
  // exact view (the top-level tab was already linkable; this half wasn't).
  const [subTab, setSubTab] = useUrlTab<PluginSubTab>('sub', PLUGIN_TABS.map((t) => t.id), 'overview');
  const data = usePluginsData(subTab, filters);
  const { loading, error, refetch } = data;

  useEffect(() => { onStatus({ loading, error, refetch }); }, [loading, error, refetch, onStatus]);

  return (
    <>
      <TabBar items={PLUGIN_TABS} activeId={subTab} onSelect={(id) => setSubTab(id as PluginSubTab)} />

      {/* The team rollup reaches the build reports; the plugin INVENTORY is
          per-organization by design, so say so rather than imply it rolled up. */}
      {filters.includeDescendants && subTab !== 'builds' && (
        <p className="text-xs text-fg-muted" role="note">
          Plugin inventory is per-organization — the team rollup applies to the Builds reports.
        </p>
      )}

      {subTab === 'overview' && (
        <PluginOverview loading={loading} pluginSummary={data.pluginSummary} distribution={data.distribution} />
      )}
      {subTab === 'builds' && (
        <PluginBuilds loading={loading} buildTimeline={data.buildTimeline} buildDurations={data.buildDurations} buildFailures={data.buildFailures} showFailures={!!filters.systemAdmin} />
      )}
      {subTab === 'versions' && (
        <PluginVersions loading={loading} pluginVersions={data.pluginVersions} />
      )}
    </>
  );
}
