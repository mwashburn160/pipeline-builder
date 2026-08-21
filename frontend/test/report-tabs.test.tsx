// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Isolation tests for the extracted top-tab components (PipelinesTab / PluginsTab /
 * DoraTab). Each owns its sub-tab state + data hook, renders the matching panels,
 * and reports loading/error/refetch up via `onStatus`. Page-level wiring (clamp,
 * shared banner) is covered by reports-clamp / reports-error-banner.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PipelinesTab } from '../src/components/reports/tabs/PipelinesTab';
import { PluginsTab } from '../src/components/reports/tabs/PluginsTab';
import { DoraTab } from '../src/components/reports/tabs/DoraTab';
import type { SharedFilters } from '../src/components/reports/useReportData';

const getExecutionCount = jest.fn();
const getSuccessRate = jest.fn();
const getPipelineDuration = jest.fn();
const getStageBottlenecks = jest.fn();
const getPluginSummary = jest.fn();
const getPluginDistribution = jest.fn();
const getDora = jest.fn();
const getDoraTrend = jest.fn();

jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getExecutionCount: (...a: unknown[]) => getExecutionCount(...a),
    getSuccessRate: (...a: unknown[]) => getSuccessRate(...a),
    getPipelineDuration: (...a: unknown[]) => getPipelineDuration(...a),
    getStageBottlenecks: (...a: unknown[]) => getStageBottlenecks(...a),
    getStageFailures: jest.fn().mockResolvedValue({ data: { stages: [] } }),
    getActionFailures: jest.fn().mockResolvedValue({ data: { actions: [] } }),
    getExecutionErrors: jest.fn().mockResolvedValue({ data: { errors: [] } }),
    getPluginSummary: (...a: unknown[]) => getPluginSummary(...a),
    getPluginDistribution: (...a: unknown[]) => getPluginDistribution(...a),
    getBuildSuccessRate: jest.fn().mockResolvedValue({ data: { timeline: [] } }),
    getBuildDuration: jest.fn().mockResolvedValue({ data: { plugins: [] } }),
    getBuildFailures: jest.fn().mockResolvedValue({ data: { failures: [] } }),
    getPluginVersions: jest.fn().mockResolvedValue({ data: { plugins: [] } }),
    getDora: (...a: unknown[]) => getDora(...a),
    getDoraTrend: (...a: unknown[]) => getDoraTrend(...a),
    listPipelines: jest.fn().mockResolvedValue({ data: { pipelines: [] } }),
    getReportEnvironments: jest.fn().mockResolvedValue({ data: { environments: [] } }),
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
});

describe('PipelinesTab', () => {
  it('renders the sub-tab bar, fetches overview data, and reports status up', async () => {
    const onStatus = jest.fn();
    render(<PipelinesTab filters={filters} onStatus={onStatus} />);

    expect(screen.getByRole('button', { name: 'Overview' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Performance' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Failures' })).toBeInTheDocument();

    await waitFor(() => expect(getExecutionCount).toHaveBeenCalled());
    expect(getSuccessRate).toHaveBeenCalled();
    // onStatus receives a { loading, error, refetch } bag.
    await waitFor(() => expect(onStatus).toHaveBeenCalledWith(
      expect.objectContaining({ error: null, refetch: expect.any(Function) }),
    ));
  });

  it('switches to Performance and fetches its slices', async () => {
    render(<PipelinesTab filters={filters} onStatus={jest.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Performance' }));
    await waitFor(() => expect(getPipelineDuration).toHaveBeenCalled());
    expect(getStageBottlenecks).toHaveBeenCalled();
  });
});

describe('PluginsTab', () => {
  it('renders the sub-tab bar and fetches plugin overview data', async () => {
    render(<PluginsTab filters={filters} onStatus={jest.fn()} />);
    expect(screen.getByRole('button', { name: 'Overview' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Builds' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Versions' })).toBeInTheDocument();
    await waitFor(() => expect(getPluginSummary).toHaveBeenCalled());
    expect(getPluginDistribution).toHaveBeenCalled();
  });
});

describe('DoraTab', () => {
  it('renders the upsell and fires NO fetch when not entitled', async () => {
    render(<DoraTab filters={filters} enabled={false} canMark={false} onStatus={jest.fn()} />);
    expect(await screen.findByRole('link', { name: /unlock advanced reporting/i })).toBeInTheDocument();
    expect(getDora).not.toHaveBeenCalled();
    expect(getDoraTrend).not.toHaveBeenCalled();
  });

  it('mounts + fetches DORA when entitled and reports status up', async () => {
    const onStatus = jest.fn();
    getDora.mockResolvedValue(null);
    render(<DoraTab filters={filters} enabled canMark onStatus={onStatus} />);
    await waitFor(() => expect(getDora).toHaveBeenCalled());
    expect(getDoraTrend).toHaveBeenCalled();
    await waitFor(() => expect(onStatus).toHaveBeenCalledWith(
      expect.objectContaining({ refetch: expect.any(Function) }),
    ));
  });
});
