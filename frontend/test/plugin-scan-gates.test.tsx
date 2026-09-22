// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The scan gates in the dashboard:
 *  - vulnerability badges show Critical / High as FIXABLE / TOTAL (the gates
 *    count fixable Criticals only), "Unscanned" for a version stored without a
 *    scan, and "Flagged by rescan" with the top CVEs and their fixed versions;
 *  - a failed build explains IMAGE_SCAN_UNAVAILABLE and PLUGIN_VULN_GATE in
 *    plain words, listing each blocking CVE with its fix;
 *  - the pipeline editor previews lookup's VULN_FLAGGED warning, and block
 *    mode's 409 PLUGIN_VERSION_VULN_BLOCKED message as the server wrote it.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, within } from '@testing-library/react';

const lookupPlugin = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: { lookupPlugin: (...a: unknown[]) => lookupPlugin(...a) },
}));

import { VulnSummary } from '../src/components/plugin/VulnSummary';
import { BuildFailureMessage } from '../src/components/plugin/BuildFailureMessage';
import { PluginResolutionWarnings } from '../src/components/pipeline/editors/PluginResolutionWarnings';
import { FailedJobsTable } from '../src/components/build-queue/FailedJobsTable';
import { ApiError } from '../src/lib/api/errors';
import { clearQueryCache } from '../src/lib/query-cache';
import { buildFailureInfo, describeFinding, normalizeScanFlag, normalizeVulnFindings } from '../src/lib/plugin-vulns';

/** The flag as the plugin service stores it (api-core `PluginScanFlag`). */
const FLAG = {
  critical: 2,
  high: 1,
  maxCritical: 0,
  findings: [
    { id: 'CVE-2026-0001', severity: 'critical', packageName: 'openssl', packageVersion: '3.0.1', fixedIn: ['3.0.2'] },
    { id: 'GHSA-aaaa-bbbb-cccc', severity: 'high', packageName: 'lodash', packageVersion: '4.17.0', fixedIn: [] },
  ],
};

beforeEach(() => {
  jest.clearAllMocks();
  clearQueryCache();
});

describe('plugin-vulns helpers', () => {
  it('normalizes the stored flag and words a finding like the server does', () => {
    const flag = normalizeScanFlag(FLAG)!;
    expect(flag.critical).toBe(2);
    expect(flag.findings.map(describeFinding)).toEqual([
      'CVE-2026-0001 (openssl@3.0.1 → 3.0.2)',
      'GHSA-aaaa-bbbb-cccc (lodash@4.17.0 (no fix))',
    ]);
    expect(normalizeScanFlag(null)).toBeNull();
    expect(normalizeVulnFindings([{ cve: 'CVE-1', fixedIn: '1.0.1, 1.1.0' }, { nope: true }, 'x'])).toEqual([
      { id: 'CVE-1', severity: 'Unknown', package: null, packageVersion: null, fixedIn: ['1.0.1', '1.1.0'] },
    ]);
  });

  it('recognizes the scan-gate codes from the event data or, failing that, the message', () => {
    expect(buildFailureInfo({ message: 'Build failed', data: { code: 'PLUGIN_VULN_GATE', findings: FLAG.findings } })).toMatchObject({
      code: 'PLUGIN_VULN_GATE', findings: [expect.objectContaining({ id: 'CVE-2026-0001' }), expect.objectContaining({ fixedIn: [] })],
    });
    expect(buildFailureInfo({ message: 'Build failed (error): IMAGE_SCAN_UNAVAILABLE: grype timed out' }).code).toBe('IMAGE_SCAN_UNAVAILABLE');
    expect(buildFailureInfo({ message: 'Build failed (exit code 1)' })).toMatchObject({ code: null, message: 'Build failed (exit code 1)' });
  });
});

describe('VulnSummary', () => {
  it('shows fixable vs total for Critical and High', () => {
    render(<VulnSummary facts={{ vulnCritical: 5, vulnHigh: 3, vulnCriticalFixable: 2, vulnHighFixable: 0, scannedAt: '2026-09-20T00:00:00Z' }} />);
    expect(screen.getByTestId('vuln-critical')).toHaveTextContent('2 fixable / 5 Critical');
    expect(screen.getByTestId('vuln-high')).toHaveTextContent('0 fixable / 3 High');
    expect(screen.queryByTestId('vuln-unscanned')).not.toBeInTheDocument();
  });

  it('falls back to the total alone when the fixable count is unknown', () => {
    render(<VulnSummary facts={{ vulnCritical: 1, vulnHigh: 0 }} />);
    expect(screen.getByTestId('vuln-critical')).toHaveTextContent(/^1 Critical$/);
  });

  it('marks a version stored without a scan as Unscanned', () => {
    render(<VulnSummary facts={{ vulnCritical: null, vulnHigh: null }} />);
    expect(screen.getByTestId('vuln-unscanned')).toHaveTextContent('Unscanned');
  });

  it('says clean when there is nothing Critical or High, and stays quiet in dense lists', () => {
    const { unmount } = render(<VulnSummary facts={{ vulnCritical: 0, vulnHigh: 0, vulnCriticalFixable: 0, vulnHighFixable: 0 }} />);
    expect(screen.getByTestId('vuln-clean')).toBeInTheDocument();
    unmount();
    const { container } = render(<VulnSummary facts={{ vulnCritical: 0, vulnHigh: 0 }} quiet />);
    expect(container).toBeEmptyDOMElement();
  });

  it('flags a rescan finding, with the top CVEs and fixed versions', () => {
    render(<VulnSummary facts={{ vulnCritical: 2, vulnHigh: 1, vulnCriticalFixable: 2, vulnHighFixable: 1, scanFlaggedAt: '2026-09-21T00:00:00Z', scanFlag: FLAG }} details />);
    const badge = screen.getByTestId('vuln-flagged');
    expect(badge).toHaveTextContent('Flagged by rescan');
    expect(badge).toHaveAttribute('title', expect.stringContaining('CVE-2026-0001 (openssl@3.0.1 → 3.0.2)'));
    const list = screen.getByTestId('vuln-flag-findings');
    expect(within(list).getByText('CVE-2026-0001 (openssl@3.0.1 → 3.0.2)')).toBeInTheDocument();
    expect(within(list).getByText('GHSA-aaaa-bbbb-cccc (lodash@4.17.0 (no fix))')).toBeInTheDocument();
  });

  it('flags a public version that carries only the flag time', () => {
    render(<VulnSummary facts={{ vulnCritical: 1, vulnHigh: 0, vulnCriticalFixable: 1, scanFlaggedAt: '2026-09-21T00:00:00Z' }} details />);
    expect(screen.getByTestId('vuln-flagged')).toHaveAttribute('title', expect.stringMatching(/fixable Critical findings/));
    expect(screen.queryByTestId('vuln-flag-findings')).not.toBeInTheDocument();
  });

  it('shows the flag even in quiet mode', () => {
    render(<VulnSummary facts={{ vulnCritical: 0, vulnHigh: 0, scanFlaggedAt: '2026-09-21T00:00:00Z', scanFlag: FLAG }} quiet />);
    expect(screen.getByTestId('vuln-flagged')).toBeInTheDocument();
  });
});

describe('BuildFailureMessage', () => {
  it('explains an image that could not be scanned', () => {
    render(<BuildFailureMessage event={{ message: 'Build failed (error): image could not be scanned', data: { code: 'IMAGE_SCAN_UNAVAILABLE' } }} />);
    const box = screen.getByTestId('build-failure-IMAGE_SCAN_UNAVAILABLE');
    expect(screen.getByText('The image could not be scanned')).toBeInTheDocument();
    expect(box).toHaveTextContent(/nothing was saved/i);
  });

  it('lists each blocking CVE with its fix for PLUGIN_VULN_GATE', () => {
    // The build stream's shape: the typed code plus the AppError's details.
    render(<BuildFailureMessage event={{ message: 'Build failed (error): PLUGIN_VULN_GATE: …', data: { code: 'PLUGIN_VULN_GATE', details: { critical: 1, high: 0, maxCritical: 0, findings: FLAG.findings } } }} />);
    expect(screen.getByText('Blocked by Critical vulnerabilities')).toBeInTheDocument();
    const list = screen.getByRole('list', { name: /blocking vulnerabilities/i });
    expect(within(list).getByText('CVE-2026-0001 (openssl@3.0.1 → 3.0.2)')).toBeInTheDocument();
  });

  it('falls back to the server text for a gate failure without structured findings', () => {
    render(<BuildFailureMessage event={{ message: 'PLUGIN_VULN_GATE: CVE-9 (zlib@1.2 → 1.3)' }} />);
    expect(screen.getByTestId('build-failure-PLUGIN_VULN_GATE')).toHaveTextContent('CVE-9 (zlib@1.2 → 1.3)');
  });

  it('shows any other failure as the server wrote it', () => {
    render(<BuildFailureMessage event={{ message: 'Build failed (exit code 2)\nLast 1 log line(s):\nnpm ERR!' }} />);
    expect(screen.getByTestId('build-failure-message')).toHaveTextContent('Build failed (exit code 2)');
  });

  it('labels a scan-gate refusal in the failed-builds table', () => {
    render(
      <FailedJobsTable
        jobs={[{ id: 'j1', pluginName: 'trivy', version: '1.0.0', error: 'PLUGIN_VULN_GATE: 2 fixable Critical', attemptsMade: 1, maxAttempts: 3, failedAt: '2026-09-21T00:00:00Z' }]}
        pagination={{ offset: 0, limit: 25, total: 1 }}
        onPageChange={() => {}}
        title="Failed builds"
      />,
    );
    expect(screen.getByText('Blocked by Critical vulnerabilities')).toBeInTheDocument();
  });
});

describe('PluginResolutionWarnings (pipeline editor)', () => {
  it('shows lookup\'s VULN_FLAGGED warning and ignores the rest', async () => {
    lookupPlugin.mockResolvedValue({
      success: true,
      data: {
        plugin: { id: 'p1', name: 'trivy', version: '1.4.0' },
        warnings: [
          { code: 'PLUGIN_DEPRECATED', message: 'Plugin trivy@1.4.0 is deprecated.' },
          { code: 'VULN_FLAGGED', plugin: 'trivy', version: '1.4.0', critical: 2, high: 1, message: 'trivy@1.4.0 has 2 fixable Critical findings — rebuild or upgrade', findings: FLAG.findings },
        ],
      },
    });
    render(<PluginResolutionWarnings name="trivy" version="^1" />);
    const warning = await screen.findByTestId('plugin-vuln-flagged');
    expect(warning).toHaveTextContent('trivy@1.4.0 has 2 fixable Critical findings — rebuild or upgrade');
    expect(warning).toHaveTextContent('CVE-2026-0001 (openssl@3.0.1 → 3.0.2)');
    expect(screen.queryByText(/deprecated/)).not.toBeInTheDocument();
    expect(lookupPlugin).toHaveBeenCalledWith({ name: 'trivy', version: '^1' }, expect.anything());
  });

  it('prints block mode\'s 409 as the server wrote it', async () => {
    const msg = 'trivy@1.4.0 is blocked: a rescan found 2 fixable Critical findings (PLUGIN_BLOCK_ON_NEW_CRITICAL). Fix: CVE-2026-0001 (openssl@3.0.1 → 3.0.2).';
    lookupPlugin.mockRejectedValue(new ApiError(msg, 409, 'PLUGIN_VERSION_VULN_BLOCKED'));
    render(<PluginResolutionWarnings name="trivy" version="1.4.0" publisher="acme" />);
    expect(await screen.findByTestId('plugin-vuln-blocked')).toHaveTextContent(msg);
  });

  it('stays silent for other refusals, and makes no call without a name', async () => {
    lookupPlugin.mockRejectedValue(new ApiError('Plugin not found', 404, 'NOT_FOUND'));
    const { container, rerender } = render(<PluginResolutionWarnings name="nope" />);
    await new Promise((r) => setTimeout(r, 0));
    expect(container).toBeEmptyDOMElement();
    lookupPlugin.mockClear();
    rerender(<PluginResolutionWarnings name="" />);
    expect(lookupPlugin).not.toHaveBeenCalled();
  });
});
