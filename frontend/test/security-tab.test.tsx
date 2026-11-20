// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Reports → Security: the two advanced panels, their empty states and CSV
 * buttons, the upsell (no fetch without the entitlement), and that the reads
 * carry the org's reporting timezone + week start — the same bucketing the
 * report sections use.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { render, screen, waitFor } from '@testing-library/react';

const mockVulns = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockCompliance = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockPolicy = jest.fn<(...a: unknown[]) => Promise<unknown>>();

jest.mock('@/lib/api', () => {
  const client = {
    getVulnerabilityExposure: (...a: unknown[]) => mockVulns(...a),
    getComplianceTrend: (...a: unknown[]) => mockCompliance(...a),
    getReportPolicy: (...a: unknown[]) => mockPolicy(...a),
  };
  return { __esModule: true, default: client, api: client };
});

import { CompliancePanel, SecurityTab, VulnerabilityPanel, fmtSeconds } from '../src/components/reports/tabs/SecurityTab';
import type { ComplianceTrendReport, VulnerabilityExposureReport } from '../src/lib/api/domains/reporting-security';

const VULNS: VulnerabilityExposureReport = {
  window: { from: '2026-09-01T00:00:00Z', to: '2026-10-01T00:00:00Z' },
  asOf: '2026-10-01T00:00:00.000Z',
  open: { exposures: 2, pipelines: 2, critical: 4, high: 3, medium: 0, low: 0, kev: 1 },
  scanners: { reports: 1, pipelines: 1, critical: 1, high: 0, medium: 2, low: 5, kev: 2 },
  timeToFix: { n: 3, medianSeconds: 2 * 86_400, p90Seconds: 5 * 86_400 },
  trend: [{ period: '2026-08-31 00:00:00', new: 2, fixed: 1 }],
  totals: { new: 2, fixed: 1 },
  expiringAcceptances: { count: 1, items: [{ pipelineId: 'p1', pipelineName: 'web-deploy', plugin: 'node', version: '1.0.0', acceptedUntil: '2026-10-11T00:00:00.000Z', daysLeft: 10 }] },
};
const EMPTY_VULNS: VulnerabilityExposureReport = {
  ...VULNS,
  open: { exposures: 0, pipelines: 0, critical: 0, high: 0, medium: 0, low: 0, kev: 0 },
  scanners: { reports: 0, pipelines: 0, critical: 0, high: 0, medium: 0, low: 0, kev: 0 },
  timeToFix: { n: 0, medianSeconds: null, p90Seconds: null },
  trend: [{ period: '2026-08-31 00:00:00', new: 0, fixed: 0 }],
  totals: { new: 0, fixed: 0 },
  expiringAcceptances: { count: 0, items: [] },
};
const COMPLIANCE: ComplianceTrendReport = {
  window: VULNS.window,
  asOf: VULNS.asOf,
  trend: [{ period: '2026-08-31 00:00:00', scans: 2, pass: 6, warn: 1, block: 2, exemptionsCreated: 1, exemptionsActive: 1 }],
  totals: { scans: 2, pass: 6, warn: 1, block: 2, exemptionsCreated: 1 },
  activeExemptions: 1,
  topRules: [{ ruleId: 'r1', ruleName: 'require-approval', severity: 'error', violations: 3, entities: 2 }],
};

const FILTERS = { dateFrom: '2026-09-01', dateTo: '2026-10-01', interval: 'week' as const, includeDescendants: false };

beforeEach(() => {
  jest.clearAllMocks();
  mockVulns.mockResolvedValue(VULNS);
  mockCompliance.mockResolvedValue(COMPLIANCE);
  mockPolicy.mockResolvedValue({ data: { policy: { defaultTimezone: 'America/Chicago', defaultWeekStart: 'sunday' } } });
});

describe('fmtSeconds', () => {
  it('picks the unit', () => {
    expect(fmtSeconds(null)).toBe('—');
    expect(fmtSeconds(600)).toBe('10m');
    expect(fmtSeconds(7200)).toBe('2.0h');
    expect(fmtSeconds(2 * 86_400)).toBe('2.0d');
  });
});

describe('VulnerabilityPanel', () => {
  it('renders severity, KEV, time to fix and the expiring acceptances, with CSV per table', () => {
    render(<VulnerabilityPanel loading={false} data={VULNS} />);
    expect(screen.getByText('Open critical')).toBeInTheDocument();
    expect(screen.getByText('3 high · 2 pipelines')).toBeInTheDocument();
    // KEV: plugin images + scanners.
    expect(screen.getByText('1 in plugin images · 2 from scanners')).toBeInTheDocument();
    expect(screen.getByText('2.0d')).toBeInTheDocument();
    expect(screen.getByText('p90 5.0d · n = 3')).toBeInTheDocument();
    expect(screen.getByText('web-deploy')).toBeInTheDocument();
    expect(screen.getByText('2026-08-31')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /csv/i })).toHaveLength(3);
  });

  it('shows an empty state for a range with nothing in it', () => {
    render(<VulnerabilityPanel loading={false} data={EMPTY_VULNS} />);
    expect(screen.getByText('No vulnerability findings in this range')).toBeInTheDocument();
  });
});

describe('CompliancePanel', () => {
  it('renders the verdict trend, exemptions and top rules', () => {
    render(<CompliancePanel loading={false} data={COMPLIANCE} />);
    expect(screen.getByText('Blocked checks')).toBeInTheDocument();
    expect(screen.getByText('require-approval')).toBeInTheDocument();
    expect(screen.getByText('1 requested in range')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /csv/i })).toHaveLength(2);
  });

  it('shows an empty state when nothing ran', () => {
    render(<CompliancePanel loading={false} data={{ ...COMPLIANCE, trend: [], topRules: [], activeExemptions: 0, totals: { scans: 0, pass: 0, warn: 0, block: 0, exemptionsCreated: 0 } }} />);
    expect(screen.getByText('No compliance scans or checks in this range')).toBeInTheDocument();
  });
});

describe('SecurityTab', () => {
  it('shows the upsell and fetches nothing without advanced_reporting', async () => {
    render(<SecurityTab filters={FILTERS} enabled={false} onStatus={() => {}} />);
    expect(screen.getByText('Unlock Advanced Reporting')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 0));
    expect(mockVulns).not.toHaveBeenCalled();
    expect(mockCompliance).not.toHaveBeenCalled();
  });

  it("reads both reports in the org's reporting timezone and week start", async () => {
    render(<SecurityTab filters={FILTERS} enabled onStatus={() => {}} />);
    await waitFor(() => expect(screen.getByText('require-approval')).toBeInTheDocument());
    const expected = { from: '2026-09-01', to: '2026-10-01', interval: 'week', tz: 'America/Chicago', weekStart: 'sunday' };
    expect(mockVulns).toHaveBeenCalledWith(expected, expect.anything());
    expect(mockCompliance).toHaveBeenCalledWith(expected, expect.anything());
  });
});
