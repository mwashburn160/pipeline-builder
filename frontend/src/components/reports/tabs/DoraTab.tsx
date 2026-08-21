// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useState } from 'react';
import { Gauge } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import { DoraReport } from '../DoraReport';
import { BuildHealthPanel } from '../BuildHealth';
import { DoraUpsell } from '../ReportHelpers';
import { useDoraData, type SharedFilters, type TabDataStatus } from '../useReportData';

interface DoraTabProps {
  filters: SharedFilters;
  /** Whether `advanced_reporting` is entitled — non-entitled renders the upsell. */
  enabled: boolean;
  /** Whether the viewer may mark deployment outcomes (`reports:read`). */
  canMark: boolean;
  /** Report loading/error/refetch up to the shell (for the shared banner + refresh). */
  onStatus: (status: TabDataStatus) => void;
}

/**
 * DORA top-tab: entitlement-gated delivery analytics. Owns the DORA scope state
 * (pipeline + environment, with a debounced/committed env value), fetches via
 * {@link useDoraData}, and renders the metrics + per-pipeline build health. Non-
 * entitled viewers get the {@link DoraUpsell} teaser and NO fetch fires. When the
 * tab is genuinely empty (no executions, no scope) it shows ONE consolidated
 * empty state with a next-step hint instead of four stacked empty cards.
 */
export function DoraTab({ filters, enabled, canMark, onStatus }: DoraTabProps) {
  const [pipelineId, setPipelineId] = useState('');
  // `environment` is the live input value; `environmentApplied` is the committed
  // value that feeds the fetch. Typing updates only the former; a short debounce
  // (plus an immediate commit on blur/Enter/pill-click) promotes it to the latter.
  const [environment, setEnvironment] = useState('');
  const [environmentApplied, setEnvironmentApplied] = useState('');

  const data = useDoraData({ ...filters, enabled, pipelineId, environmentApplied });
  const { loading, refetch } = data;
  // A failed mark-outcome write surfaces on the shared banner (as the pre-refactor
  // page did). Merged with the fetch error; cleared when a fresh fetch begins.
  const [markError, setMarkError] = useState<string | null>(null);
  const error = markError ?? data.error;

  useEffect(() => { if (loading) setMarkError(null); }, [loading]);
  useEffect(() => { onStatus({ loading, error, refetch }); }, [loading, error, refetch, onStatus]);

  // Debounce the environment filter: promote the live input to the committed
  // value ~400ms after typing stops (blur/Enter commit immediately via controls).
  useEffect(() => {
    if (environment === environmentApplied) return;
    const t = setTimeout(() => setEnvironmentApplied(environment), 400);
    return () => clearTimeout(t);
  }, [environment, environmentApplied]);

  // Environment a marked outcome is attributed to: the applied env filter when
  // set, otherwise the DORA headline (`production`).
  const markEnvironment = environmentApplied.trim() || 'production';

  const handleMarkOutcome = useCallback(
    async (executionId: string, outcome: 'failed' | 'restored') => {
      setMarkError(null);
      try {
        await api.markDeploymentOutcome(executionId, {
          outcome,
          at: new Date().toISOString(),
          environment: markEnvironment,
        });
        await refetch();
      } catch (e) {
        setMarkError(formatError(e, 'Failed to record deployment outcome'));
      }
    },
    [markEnvironment, refetch],
  );

  if (!enabled) return <DoraUpsell />;

  const hasActiveScope = !!pipelineId || environmentApplied.trim() !== '';
  // Consolidated empty state: only when the tab is genuinely empty — no metrics,
  // no executions to seed the picker, and no active scope the user might clear.
  // (A scoped filter that returns nothing keeps the controls + scoped empty so the
  // user isn't trapped in an over-narrow filter.)
  const trulyEmpty = !loading && data.dora === null && data.executions.length === 0 && !hasActiveScope;
  if (trulyEmpty) {
    return (
      <EmptyState
        icon={Gauge}
        title="No deploy data yet"
        description={<>No deploy data yet — set a stage <code>environment</code> and enable <code>setup-events --with-dora</code> to start tracking delivery performance.</>}
        illustration="pipelines"
      />
    );
  }

  return (
    <>
      <DoraReport
        loading={loading}
        dora={data.dora}
        doraTrend={data.doraTrend}
        pipelineOptions={data.pipelineOptions}
        executions={data.executions}
        environmentOptions={data.environmentOptions}
        deployments={data.deployments}
        deployPipelineSelected={!!pipelineId}
        markEnvironment={markEnvironment}
        canMark={canMark}
        onMarkOutcome={handleMarkOutcome}
        requestedFrom={filters.dateFrom}
        doraScope={{
          pipelineId,
          environment,
          onPipelineChange: setPipelineId,
          onEnvironmentChange: setEnvironment,
          // Commit both the live + applied value so a pivot (env pill click) also
          // updates the visible filter input, not just the fetch.
          onEnvironmentCommit: (v) => { setEnvironment(v); setEnvironmentApplied(v); },
        }}
      />
      {/* Build Health — standard (every-tier) per-stage breakdown, keyed by the
          scoped pipeline. Only rendered once a pipeline is scoped, so the default
          view isn't cluttered by a lonely "select a pipeline" empty card. */}
      {pipelineId && (
        <BuildHealthPanel loading={loading} buildHealth={data.buildHealth} pipelineSelected />
      )}
    </>
  );
}
