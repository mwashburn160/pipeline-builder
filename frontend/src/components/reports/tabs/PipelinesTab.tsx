// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react';
import { TabBar } from '@/components/ui/TabBar';
import { PipelineOverview } from '../PipelineOverview';
import { PipelinePerformance } from '../PipelinePerformance';
import { PipelineFailures } from '../PipelineFailures';
import {
  usePipelinesData, type PipelineSubTab, type SharedFilters, type TabDataStatus,
} from '../useReportData';

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
  const [subTab, setSubTab] = useState<PipelineSubTab>('overview');
  const data = usePipelinesData(subTab, filters);
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
        <PipelineFailures loading={loading} stageFailures={data.stageFailures} actionFailures={data.actionFailures} errors={data.errors} />
      )}
    </>
  );
}
