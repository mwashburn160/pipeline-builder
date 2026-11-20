// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The Pipelines → Failures insight panels (org error patterns, flaky stages),
 * the unknown-lead-time explanation, and the DORA "How these are counted" note.
 */

import { describe, it, expect } from '@jest/globals';
import { render, screen } from '@testing-library/react';
import { ErrorPatterns } from '../src/components/reports/ErrorPatterns';
import { FlakyStages } from '../src/components/reports/FlakyStages';
import { DoraCountingNote } from '../src/components/reports/DoraParts';
import {
  LEAD_TIME_GAP_COPY, FAILURE_CATEGORY_LABELS, failureCategoryLabel, leadTimeGapTooltip, pipelineRunsHref, DORA_HELP_HREF,
} from '../src/components/reports/report-copy';
import type { FlakyStageRow } from '../src/components/reports/types';

describe('ErrorPatterns', () => {
  it('lists each failure category by label with its top error texts', () => {
    render(<ErrorPatterns categories={[
      { category: 'unit_test', occurrences: 3, affected_pipelines: 2, last_seen: '2026-11-17T10:00:00Z', patterns: [{ error_pattern: 'expected 1 to equal 2', occurrences: 3 }] },
      { category: 'brand_new', occurrences: 1, affected_pipelines: 1, last_seen: '2026-11-17T10:00:00Z', patterns: [] },
    ]} />);
    expect(screen.getByText('Error patterns')).toBeInTheDocument();
    expect(screen.getByText('Unit tests')).toBeInTheDocument();
    expect(screen.getByText('expected 1 to equal 2')).toBeInTheDocument();
    // An id this build does not know reads as itself, never blank.
    expect(screen.getByText('brand_new')).toBeInTheDocument();
  });

  it('says so when there is nothing to show', () => {
    render(<ErrorPatterns categories={[]} />);
    expect(screen.getByText(/no failures with an error message/i)).toBeInTheDocument();
  });
});

describe('FlakyStages', () => {
  const row: FlakyStageRow = {
    pipeline_id: 'p-api', pipeline_name: 'api', stage_name: 'Build', flaky_runs: 2, runs: 4, flake_pct: 50,
    flaky_actions: ['unit'], last_flaked: '2026-11-18T08:15:00Z',
  };

  it('ranks flaky stages with their rate and links to the pipeline runs', () => {
    render(<FlakyStages stages={[row]} trend={[]} trendEnabled={false} />);
    expect(screen.getByText('Build')).toBeInTheDocument();
    expect(screen.getByText(/2\/4 runs \(50%\)/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'api' })).toHaveAttribute('href', '/dashboard/pipelines/p-api?tab=runs');
    expect(screen.getByText('unit')).toBeInTheDocument();
  });

  it('without Advanced Reporting, the trend is an add-on note — never a chart', () => {
    render(<FlakyStages stages={[row]} trend={[]} trendEnabled={false} />);
    expect(screen.getByText(/part of Advanced Reporting/i)).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('with Advanced Reporting, the trend renders its buckets (readable as a table too)', () => {
    render(<FlakyStages stages={[row]} trendEnabled trend={[
      { period: '2026-11-17 00:00:00', flaky_runs: 1, runs: 4, flake_pct: 25 },
      { period: '2026-11-18 00:00:00', flaky_runs: 1, runs: 1, flake_pct: 100 },
    ]} />);
    expect(screen.getByText('Flake rate over time')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /flake rate over 2 periods/i })).toBeInTheDocument();
    expect(screen.getByText('25%')).toBeInTheDocument();
    expect(screen.queryByText(/part of Advanced Reporting/i)).toBeNull();
  });
});

describe('report copy catalogs', () => {
  it('has a label and a fix for every stored lead-time gap reason', () => {
    expect(Object.keys(LEAD_TIME_GAP_COPY).sort()).toEqual(['no_commit_data', 'no_token', 'rate_limited', 'unsupported_source']);
    for (const c of Object.values(LEAD_TIME_GAP_COPY)) {
      expect(c.label.length).toBeGreaterThan(0);
      expect(c.fix.length).toBeGreaterThan(20);
    }
  });

  it('the tooltip lists each reason that occurred, most deploys first, with its fix', () => {
    const text = leadTimeGapTooltip({ rate_limited: 1, no_token: 3 })!;
    expect(text.indexOf('No SCM token (3 deploys)')).toBeLessThan(text.indexOf('SCM rate-limited (1 deploy)'));
    expect(text).toContain(LEAD_TIME_GAP_COPY.no_token.fix);
    expect(leadTimeGapTooltip({})).toBeNull();
    expect(leadTimeGapTooltip(undefined)).toBeNull();
  });

  it('labels every failure category and falls back to the id', () => {
    expect(Object.keys(FAILURE_CATEGORY_LABELS)).toHaveLength(15);
    expect(failureCategoryLabel('dependency')).toBe('Dependency resolution');
    expect(failureCategoryLabel('x_new')).toBe('x_new');
  });

  it('links a pipeline to its Runs tab, encoding the id', () => {
    expect(pipelineRunsHref('a/b')).toBe('/dashboard/pipelines/a%2Fb?tab=runs');
  });
});

describe('DoraCountingNote', () => {
  it('links to the DORA Metrics help topic with the help-center deep-link pattern', () => {
    render(<DoraCountingNote />);
    expect(screen.getByRole('link', { name: 'How these are counted' })).toHaveAttribute('href', DORA_HELP_HREF);
    expect(DORA_HELP_HREF).toBe('/dashboard/help#topic-dora-metrics');
  });
});
