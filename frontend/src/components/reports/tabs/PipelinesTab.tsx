// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect } from 'react';
import { TabBar } from '@/components/ui/TabBar';
import { PipelineOverview } from '../PipelineOverview';
import { PipelinePerformance } from '../PipelinePerformance';
import { PipelineFailures } from '../PipelineFailures';
import { ErrorPatterns } from '../ErrorPatterns';
import { FlakyStages } from '../FlakyStages';
import { useFeatures } from '@/hooks/useFeatures';
import {
  usePipelinesData, type PipelineSubTab, type SharedFilters, type TabDataStatus,
} from '../useReportData';
import { useUrlTab } from '@/hooks/useUrlTab';

const PIPELINE_TABS: { id: PipelineSubTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'performance', label: 'Performance' },
  { id: 'failures', label: 'Failures' },
];

interface PipelinesTabProps {
  filters: SharedFilters;
  /** Report loading/error/refetch up to the shell (for the shared banner + refresh). */
  onStatus: (status: TabDataStatus) => void;
}

/**
 * Pipelines top-tab: owns the overview/performance/failures sub-tab state, fetches
 * its slices via {@link usePipelinesData}, and renders the matching panel. When the
 * whole tab has no data it shows ONE consolidated empty state with a next-step
 * hint (the per-panel empties only appear when the tab has some data).
 */
export function PipelinesTab({ filters, onStatus }: PipelinesTabProps) {
  // Sub-tab in the URL too, so `?tab=pipelines&sub=performance` reopens the
  // exact view (the top-level tab was already linkable; this half wasn't).
  const [subTab, setSubTab] = useUrlTab<PipelineSubTab>('sub', PIPELINE_TABS.map((t) => t.id), 'overview');
  // The flake-rate trend is the Advanced Reporting half of the flaky-stage panel;
  // without the entitlement it is never requested (no pointless 403).
  const advancedReporting = useFeatures().isEnabled('advanced_reporting');
  const data = usePipelinesData(subTab, filters, { advancedReporting });
  const { loading, error, refetch } = data;

  useEffect(() => { onStatus({ loading, error, refetch }); }, [loading, error, refetch, onStatus]);

  return (
    <>
      <TabBar items={PIPELINE_TABS} activeId={subTab} onSelect={(id) => setSubTab(id as PipelineSubTab)} />

      {subTab === 'overview' && (
        <PipelineOverview loading={loading} executions={data.executions} timeline={data.timeline} />
      )}
      {subTab === 'performance' && (
        <PipelinePerformance loading={loading} executions={data.executions} durations={data.durations} bottlenecks={data.bottlenecks} />
      )}
      {subTab === 'failures' && (
        <>
          <PipelineFailures loading={loading} stageFailures={data.stageFailures} actionFailures={data.actionFailures} errors={data.errors} showErrors={!!filters.systemAdmin} />
          {/* The org's own error patterns and flaky stages: every reports:read
              holder (the cross-org "all organizations" card above is the
              operator's read). Shown once the first read settles. */}
          {!(loading && data.errorCategories.length === 0 && data.flakyStages.length === 0) && (
            <>
              <ErrorPatterns categories={data.errorCategories} />
              <FlakyStages stages={data.flakyStages} trend={data.flakyTrend} trendEnabled={advancedReporting} />
            </>
          )}
        </>
      )}
    </>
  );
}
