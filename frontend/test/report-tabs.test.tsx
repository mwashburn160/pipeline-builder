// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Isolation tests for the extracted top-tab components (PipelinesTab / PluginsTab /
 * DoraTab). Each owns its sub-tab state + data hook, renders the matching panels,
 * and reports loading/error/refetch up via `onStatus`. Page-level wiring (clamp,
 * shared banner) is covered by reports-clamp / reports-error-banner.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PipelinesTab } from '../src/components/reports/tabs/PipelinesTab';
import { PluginsTab } from '../src/components/reports/tabs/PluginsTab';
import { DoraTab } from '../src/components/reports/tabs/DoraTab';
import type { SharedFilters } from '../src/components/reports/useReportData';

jest.mock('next/router', () => ({
  __esModule: true,
  useRouter: () => ({ isReady: true, query: {}, pathname: '/', replace: jest.fn<AnyFn>() }),
}));

const getExecutionCount = jest.fn<AnyFn>();
const getSuccessRate = jest.fn<AnyFn>();
const getPipelineDuration = jest.fn<AnyFn>();
const getStageBottlenecks = jest.fn<AnyFn>();
const getPluginSummary = jest.fn<AnyFn>();
const getPluginDistribution = jest.fn<AnyFn>();
const getDora = jest.fn<AnyFn>();
const getDoraTrend = jest.fn<AnyFn>();
// Every rollup-aware report the tabs call — asserted to share ONE scope.
const scoped = {
  getStageFailures: jest.fn<AnyFn>(),
  getActionFailures: jest.fn<AnyFn>(),
  getExecutionErrors: jest.fn<AnyFn>(),
  getBuildSuccessRate: jest.fn<AnyFn>(),
  getBuildDuration: jest.fn<AnyFn>(),
  getBuildFailures: jest.fn<AnyFn>(),
  getReportEnvironments: jest.fn<AnyFn>(),
};

jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getExecutionCount: (...a: unknown[]) => getExecutionCount(...a),
    getSuccessRate: (...a: unknown[]) => getSuccessRate(...a),
    getPipelineDuration: (...a: unknown[]) => getPipelineDuration(...a),
    getStageBottlenecks: (...a: unknown[]) => getStageBottlenecks(...a),
    getStageFailures: (...a: unknown[]) => scoped.getStageFailures(...a),
    getActionFailures: (...a: unknown[]) => scoped.getActionFailures(...a),
    getExecutionErrors: (...a: unknown[]) => scoped.getExecutionErrors(...a),
    getPluginSummary: (...a: unknown[]) => getPluginSummary(...a),
    getPluginDistribution: (...a: unknown[]) => getPluginDistribution(...a),
    getBuildSuccessRate: (...a: unknown[]) => scoped.getBuildSuccessRate(...a),
    getBuildDuration: (...a: unknown[]) => scoped.getBuildDuration(...a),
    getBuildFailures: (...a: unknown[]) => scoped.getBuildFailures(...a),
    getPluginVersions: jest.fn<AnyFn>().mockResolvedValue({ data: { plugins: [] } }),
    getDora: (...a: unknown[]) => getDora(...a),
    getDoraTrend: (...a: unknown[]) => getDoraTrend(...a),
    listPipelines: jest.fn<AnyFn>().mockResolvedValue({ data: { pipelines: [] } }),
    getReportEnvironments: (...a: unknown[]) => scoped.getReportEnvironments(...a),
  },
}));

const filters: SharedFilters = { dateFrom: '', dateTo: '', interval: 'week', includeDescendants: false };

beforeEach(() => {
  getExecutionCount.mockReset().mockResolvedValue({ data: { pipelines: [] } });
  getSuccessRate.mockReset().mockResolvedValue({ data: { timeline: [] } });
  getPipelineDuration.mockReset().mockResolvedValue({ data: { pipelines: [] } });
  getStageBottlenecks.mockReset().mockResolvedValue({ data: { stages: [] } });
  getPluginSummary.mockReset().mockResolvedValue({ data: { summary: null } });
  getPluginDistribution.mockReset().mockResolvedValue({ data: { distribution: [] } });
  getDora.mockReset().mockResolvedValue(null);
  getDoraTrend.mockReset().mockResolvedValue([]);
  scoped.getStageFailures.mockReset().mockResolvedValue({ data: { stages: [] } });
  scoped.getActionFailures.mockReset().mockResolvedValue({ data: { actions: [] } });
  scoped.getExecutionErrors.mockReset().mockResolvedValue({ data: { errors: [] } });
  scoped.getBuildSuccessRate.mockReset().mockResolvedValue({ data: { timeline: [] } });
  scoped.getBuildDuration.mockReset().mockResolvedValue({ data: { plugins: [] } });
  scoped.getBuildFailures.mockReset().mockResolvedValue({ data: { failures: [] } });
  scoped.getReportEnvironments.mockReset().mockResolvedValue({ data: { environments: [] } });
});

/** The first-argument params bag of every call to a report mock. */
const paramsOf = (fn: jest.Mock<AnyFn>) => fn.mock.calls.map((c) => c[0] as Record<string, unknown>);

describe('one scope for every panel (includeDescendants)', () => {
  const rollup: SharedFilters = { ...filters, includeDescendants: true, systemAdmin: true };

  it('threads the team rollup into EVERY pipelines report, failures included', async () => {
    render(<PipelinesTab filters={rollup} onStatus={jest.fn<AnyFn>()} />);
    await waitFor(() => expect(getExecutionCount).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('tab', { name: 'Performance' }));
    await waitFor(() => expect(getStageBottlenecks).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('tab', { name: 'Failures' }));
    await waitFor(() => expect(scoped.getExecutionErrors).toHaveBeenCalled());

    for (const fn of [
      getExecutionCount, getSuccessRate, getPipelineDuration, getStageBottlenecks,
      scoped.getStageFailures, scoped.getActionFailures, scoped.getExecutionErrors,
    ]) {
      expect(paramsOf(fn)).toEqual(expect.arrayContaining([expect.objectContaining({ includeDescendants: true })]));
    }
  });

  it('threads the team rollup into every plugin BUILD report and notes the inventory is per-org', async () => {
    render(<PluginsTab filters={rollup} onStatus={jest.fn<AnyFn>()} />);
    expect(screen.getByText(/plugin inventory is per-organization/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Builds' }));
    await waitFor(() => expect(scoped.getBuildFailures).toHaveBeenCalled());
    for (const fn of [scoped.getBuildSuccessRate, scoped.getBuildDuration, scoped.getBuildFailures]) {
      expect(paramsOf(fn)).toEqual([expect.objectContaining({ includeDescendants: true })]);
    }
  });

  it('sends no rollup flag when the switch is off', async () => {
    render(<PipelinesTab filters={{ ...filters, systemAdmin: true }} onStatus={jest.fn<AnyFn>()} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Failures' }));
    await waitFor(() => expect(scoped.getStageFailures).toHaveBeenCalled());
    expect(paramsOf(scoped.getStageFailures)[0]).not.toHaveProperty('includeDescendants');
  });
});

describe('sysadmin-only reports', () => {
  it('never requests the error / build-failure reports for a non-sysadmin (they would 403)', async () => {
    render(<PipelinesTab filters={filters} onStatus={jest.fn<AnyFn>()} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Failures' }));
    await waitFor(() => expect(scoped.getStageFailures).toHaveBeenCalled());
    expect(scoped.getExecutionErrors).not.toHaveBeenCalled();
    expect(screen.queryByText('Top errors')).not.toBeInTheDocument();
  });
});

describe('PipelinesTab', () => {
  it('renders the sub-tab bar, fetches overview data, and reports status up', async () => {
    const onStatus = jest.fn<AnyFn>();
    render(<PipelinesTab filters={filters} onStatus={onStatus} />);

    expect(screen.getByRole('tab', { name: 'Overview' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Performance' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Failures' })).toBeInTheDocument();

    await waitFor(() => expect(getExecutionCount).toHaveBeenCalled());
    expect(getSuccessRate).toHaveBeenCalled();
    // onStatus receives a { loading, error, refetch } bag.
    await waitFor(() => expect(onStatus).toHaveBeenCalledWith(
      expect.objectContaining({ error: null, refetch: expect.any(Function) }),
    ));
  });

  it('switches to Performance and fetches its slices', async () => {
    render(<PipelinesTab filters={filters} onStatus={jest.fn<AnyFn>()} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Performance' }));
    await waitFor(() => expect(getPipelineDuration).toHaveBeenCalled());
    expect(getStageBottlenecks).toHaveBeenCalled();
  });
});

describe('PluginsTab', () => {
  it('renders the sub-tab bar and fetches plugin overview data', async () => {
    render(<PluginsTab filters={filters} onStatus={jest.fn<AnyFn>()} />);
    expect(screen.getByRole('tab', { name: 'Overview' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Builds' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Versions' })).toBeInTheDocument();
    await waitFor(() => expect(getPluginSummary).toHaveBeenCalled());
    expect(getPluginDistribution).toHaveBeenCalled();
  });
});

describe('DoraTab', () => {
  it('renders the upsell and fires NO fetch when not entitled', async () => {
    render(<DoraTab filters={filters} enabled={false} canMark={false} onStatus={jest.fn<AnyFn>()} />);
    expect(await screen.findByRole('link', { name: /unlock advanced reporting/i })).toBeInTheDocument();
    expect(getDora).not.toHaveBeenCalled();
    expect(getDoraTrend).not.toHaveBeenCalled();
  });

  it('mounts + fetches DORA when entitled and reports status up', async () => {
    const onStatus = jest.fn<AnyFn>();
    getDora.mockResolvedValue(null);
    render(<DoraTab filters={filters} enabled canMark onStatus={onStatus} />);
    await waitFor(() => expect(getDora).toHaveBeenCalled());
    expect(getDoraTrend).toHaveBeenCalled();
    await waitFor(() => expect(onStatus).toHaveBeenCalledWith(
      expect.objectContaining({ refetch: expect.any(Function) }),
    ));
  });
});
