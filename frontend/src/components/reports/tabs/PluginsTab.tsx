// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react';
import { TabBar } from '@/components/ui/TabBar';
import { PluginOverview } from '../PluginOverview';
import { PluginBuilds } from '../PluginBuilds';
import { PluginVersions } from '../PluginVersions';
import {
  usePluginsData, type PluginSubTab, type SharedFilters, type TabDataStatus,
} from '../useReportData';

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
  const [subTab, setSubTab] = useState<PluginSubTab>('overview');
  const data = usePluginsData(subTab, filters);
  const { loading, error, refetch } = data;

  useEffect(() => { onStatus({ loading, error, refetch }); }, [loading, error, refetch, onStatus]);

  return (
    <>
      <TabBar items={PLUGIN_TABS} activeId={subTab} onSelect={(id) => setSubTab(id as PluginSubTab)} />

      {subTab === 'overview' && (
        <PluginOverview loading={loading} pluginSummary={data.pluginSummary} distribution={data.distribution} />
      )}
      {subTab === 'builds' && (
        <PluginBuilds loading={loading} buildTimeline={data.buildTimeline} buildDurations={data.buildDurations} buildFailures={data.buildFailures} />
      )}
      {subTab === 'versions' && (
        <PluginVersions loading={loading} pluginVersions={data.pluginVersions} />
      )}
    </>
  );
}
