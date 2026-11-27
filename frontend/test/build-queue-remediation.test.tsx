// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Remediation builds (nightly CVE fixes) run on the plugin build queue under the
 * job id `remediation-<id>`. They spend no build credits, so the failed-builds
 * table must label them, say so, link to the remediation, and let a reader
 * narrow the page to them.
 */

import { describe, expect, it } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react';
import { FailedJobsTable } from '../src/components/build-queue/FailedJobsTable';
import { remediationJobOf } from '../src/components/build-queue/remediation-job';

const PAGE = { total: 2, limit: 25, offset: 0 };
const JOBS = [
  { id: 'remediation-rem-1', pluginName: 'terraform-plan', failedAt: '2026-01-02T00:00:00Z', error: 'build failed' },
  { id: 'job-7', pluginName: 'rust', failedAt: '2026-01-01T00:00:00Z', error: 'oops' },
];

describe('remediation builds in the failed-builds table', () => {
  it('recognises a remediation job by id, name or kind', () => {
    expect(remediationJobOf({ id: 'remediation-abc' })).toEqual({ remediationId: 'abc' });
    expect(remediationJobOf({ id: '42', name: 'plugin-remediation' })).toEqual({ remediationId: null });
    expect(remediationJobOf({ id: '42', kind: 'plugin-remediation' })).toEqual({ remediationId: null });
    expect(remediationJobOf({ id: 'remediation-' })).toBeNull();
    expect(remediationJobOf({ id: 7 })).toBeNull();
  });

  it('labels it, marks it credit-free, links to the remediation and filters to it', () => {
    render(<FailedJobsTable jobs={JOBS} pagination={PAGE} onPageChange={() => {}} title="failed jobs" />);
    const link = screen.getByRole('link', { name: 'Remediation' });
    expect(link.getAttribute('href')).toBe('/dashboard/plugins?tab=security&section=remediations&remediation=rem-1');
    expect(screen.getByText('No build credits')).toBeInTheDocument();
    expect(screen.getByText('rust')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Remediation builds' }));
    expect(screen.queryByText('rust')).not.toBeInTheDocument();
    expect(screen.getByText('terraform-plan')).toBeInTheDocument();
  });

  it('offers no remediation filter when the page has none', () => {
    render(<FailedJobsTable jobs={[JOBS[1]]} pagination={{ ...PAGE, total: 1 }} onPageChange={() => {}} title="failed jobs" />);
    expect(screen.queryByRole('button', { name: 'Remediation builds' })).toBeNull();
    expect(screen.queryByText('No build credits')).toBeNull();
  });
});
