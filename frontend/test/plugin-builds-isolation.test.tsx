// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Isolation tests for the extracted PluginBuilds tab: the loading skeleton, the
 * no-data empty state, and the data render (build success-rate timeline via the
 * shared StackedTimelineBar, duration table, and recent-failure cards keyed by
 * plugin_name+last_seen).
 */

import { render, screen } from '@testing-library/react';
import { PluginBuilds } from '../src/components/reports/PluginBuilds';
import type { BuildSuccessEntry, BuildDurationStat, BuildFailure } from '../src/components/reports/types';

const timeline: BuildSuccessEntry = { period: '2026-07-01T00:00:00.000Z', succeeded: 6, failed: 1, success_pct: 86 };
const duration: BuildDurationStat = { plugin_name: 'my-plugin', avg_ms: 4000, max_ms: 9000, builds: 7 };
const failure: BuildFailure = { plugin_name: 'flaky-plugin', error_message: 'npm install failed', occurrences: 3, last_seen: '2026-07-20T00:00:00.000Z' };

const base = { buildTimeline: [] as BuildSuccessEntry[], buildDurations: [] as BuildDurationStat[], buildFailures: [] as BuildFailure[] };

describe('PluginBuilds (isolation)', () => {
  it('renders the skeleton while loading with no data', () => {
    const { container } = render(<PluginBuilds {...base} loading />);
    expect(container.querySelector('.skeleton')).toBeInTheDocument();
  });

  it('renders the empty state when not loading and no data', () => {
    render(<PluginBuilds {...base} loading={false} />);
    expect(screen.getByText('No build data yet')).toBeInTheDocument();
  });

  it('renders the success-rate timeline, duration table and failure cards with data', () => {
    render(<PluginBuilds loading={false} buildTimeline={[timeline]} buildDurations={[duration]} buildFailures={[failure]} />);
    expect(screen.getByText('Build Success Rate')).toBeInTheDocument();
    expect(screen.getByText('Build Duration')).toBeInTheDocument();
    expect(screen.getByText('my-plugin')).toBeInTheDocument();
    expect(screen.getByText('Recent Build Failures')).toBeInTheDocument();
    expect(screen.getByText('flaky-plugin')).toBeInTheDocument();
    expect(screen.getByText('npm install failed')).toBeInTheDocument();
  });
});
