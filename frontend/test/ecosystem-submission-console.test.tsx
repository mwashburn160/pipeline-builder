// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Ecosystem console → Publish queue, `submission` requests (plan §4.2 item 5, W5):
 *  - the kind is labelled "Community submission" in rows, the filter and the detail;
 *  - the detail shows the gate report, EVERY heuristics finding (medium ones
 *    too), the quarantine image and SBOM / scan downloads, beside the normal
 *    review diff against the prior version;
 *  - rejecting tells the moderator the submitter is emailed;
 *  - a claim whose email doesn't match the community submitter needs a justification.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PublishQueuePanel } from '../src/components/ecosystem/PublishQueuePanel';
import { triggerBlobDownload } from '../src/lib/csv-export';

jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());
jest.mock('@/lib/csv-export', () => ({ __esModule: true, triggerBlobDownload: jest.fn() }));

const api = {
  getEcosystemOverview: jest.fn<AnyFn>(),
  listEcosystemRequests: jest.fn<AnyFn>(),
  getEcosystemRequest: jest.fn<AnyFn>(),
  approveEcosystemRequest: jest.fn<AnyFn>(),
  secondApproveEcosystemRequest: jest.fn<AnyFn>(),
  rejectEcosystemRequest: jest.fn<AnyFn>(),
  downloadEcosystemArtifact: jest.fn<AnyFn>(),
};
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: new Proxy({}, {
    get: (_t, key: string) => (...a: unknown[]) => (api as Record<string, AnyFn>)[key](...a),
  }),
}));

const standing = (holders: number) => ({
  permission: 'plugins:moderate',
  count: { holders, eligible: holders, superadmins: 1 },
  belowMinimum: false,
  belowTwoPerson: false,
});
const overview = {
  approvers: { minimum: 3, twoPersonMinimum: 2, moderate: standing(3), verify: standing(3) },
  pending: { standard: 1, security: 0, secondApproval: 0, verify: 0 },
  bootstrap: { state: 'closed', openedAt: null, closedAt: null, reason: null },
  officialAutoApprovalEnabled: true,
  termsVersion: '2026-09',
  reviews: { held: 0, reported: 0 },
};

const submissionItem = {
  id: 'r-sub', kind: 'submission', status: 'pending', lane: 'standard', publisherId: 'pub-community', publisherHandle: 'community',
  publisherTier: 'unverified', listingId: null, listingName: null, pluginId: null, version: '1.2.0', digest: 'sha256:q',
  payload: { submissionId: 'sub-1', name: 'eslint-runner', version: '1.2.0', newListing: true },
  submittedBy: 'anonymous', submittedOrgId: null, submittedAt: '2026-09-20T00:00:00Z',
  firstApprovedBy: null, secondApprovedBy: null, decidedBy: null, decidedAt: null, reason: null, autoRuleId: null,
  securityFixAdvisoryId: null, ageHours: 3, slaHours: 48, slaBreached: false, requiresTwoPerson: true,
  requiresStepUp: false, requiredPermission: 'plugins:moderate', conflictOfInterest: false, conflictReason: null,
};

const review = {
  previousVersion: '1.1.0',
  metadata: [{ field: 'summary', value: 'Run ESLint', previous: 'Lint', source: 'user', changed: true, userEdited: true, isLink: false, highlight: false }],
  contract: null,
  vuln: { previous: { critical: 0, high: 0 }, current: { critical: 0, high: 2, scannedAt: '2026-09-20T00:00:00Z' }, newCritical: 0, newHigh: 2 },
  dockerfile: { previous: 'FROM node:20', current: 'FROM node:22', changed: true },
  sbom: { added: ['eslint@9.0.0'], removed: [], error: null },
  icon: null,
  gates: [],
  publisherHistory: { tier: 'unverified', createdAt: '2026-01-01', listings: 4, approved: 4, rejected: 0 },
  autoApproval: { eligible: false, ruleId: null, ruleName: null, reasons: ['Submissions are never auto-approved'] },
};

const submission = {
  id: 'sub-1',
  status: 'pending_review',
  newListing: true,
  gates: [
    { id: 'spec', ok: true, message: 'Spec and contract are valid' },
    { id: 'heuristics', ok: true, message: 'No high-severity findings' },
    { id: 'smoke_test', ok: true, message: 'Smoke test passed' },
  ],
  heuristics: [
    { id: 'obfuscation.base64-blob', severity: 'medium', path: 'scripts/setup.sh', line: 12, excerpt: 'echo aGVsbG8= | base64 -d' },
  ],
  sbomUrl: '/api/plugins/ecosystem/submissions/sub-1/sbom',
  scanUrl: '/api/plugins/ecosystem/submissions/sub-1/scan',
  quarantineImage: 'registry:5000/quarantine/sub-1:1.2.0@sha256:q',
  submittedAt: '2026-09-20T00:00:00Z',
  verifiedAt: '2026-09-20T00:05:00Z',
};

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.getEcosystemOverview.mockResolvedValue({ success: true, data: overview });
  api.listEcosystemRequests.mockResolvedValue({ success: true, data: { requests: [submissionItem] } });
  api.getEcosystemRequest.mockResolvedValue({ success: true, data: { request: submissionItem, review, approvers: null, eligibility: null, submission } });
  api.rejectEcosystemRequest.mockResolvedValue({ success: true, data: { request: submissionItem } });
  api.downloadEcosystemArtifact.mockResolvedValue({ blob: new Blob(['{}']), filename: 'sub-1.spdx.json' });
});

const openDetail = async () => {
  fireEvent.click(await screen.findByRole('button', { name: /^review community submission/i }));
  return screen.findByTestId('queue-detail');
};

describe('Publish queue — community submissions', () => {
  it('labels the row and offers the kind in the filter', async () => {
    render(<PublishQueuePanel can={() => true} />);
    const row = await screen.findByTestId('queue-item-r-sub');
    expect(within(row).getByText('Community submission')).toBeInTheDocument();
    expect(within(row).getByText('eslint-runner v1.2.0')).toBeInTheDocument();
    expect(within(row).getByText('Anonymous · new')).toBeInTheDocument();
    expect(within(screen.getByLabelText('Kind')).getByRole('option', { name: 'Community submission' })).toHaveValue('submission');
  });

  it('shows the gate report, every heuristics finding, the quarantine image, downloads and the diff vs the prior version', async () => {
    render(<PublishQueuePanel can={() => true} />);
    const detail = await openDetail();
    expect(within(detail).getByRole('heading', { name: 'Community submission' })).toBeInTheDocument();

    const section = await within(detail).findByTestId('submission-review-section');
    expect(within(section).getByText('New listing')).toBeInTheDocument();
    expect(within(section).getByTestId('gate-smoke_test')).toHaveTextContent('Smoke test passed');
    const finding = within(section).getByTestId('finding-obfuscation.base64-blob');
    expect(finding).toHaveTextContent('medium');
    expect(finding).toHaveTextContent('scripts/setup.sh:12');
    expect(within(section).getByText('registry:5000/quarantine/sub-1:1.2.0@sha256:q')).toBeInTheDocument();
    expect(within(section).queryByText('Failed checks on a queued submission')).not.toBeInTheDocument();

    fireEvent.click(within(section).getByRole('button', { name: 'SBOM' }));
    expect(api.downloadEcosystemArtifact).toHaveBeenCalledWith('/api/plugins/ecosystem/submissions/sub-1/sbom', 'submission-sub-1.spdx.json');
    await waitFor(() => expect(triggerBlobDownload).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(within(section).getByRole('button', { name: 'SBOM' })).toBeEnabled());
    fireEvent.click(within(section).getByRole('button', { name: 'Vulnerability scan' }));
    expect(api.downloadEcosystemArtifact).toHaveBeenCalledWith('/api/plugins/ecosystem/submissions/sub-1/scan', 'submission-sub-1-scan.json');
    await waitFor(() => expect(triggerBlobDownload).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(within(section).getByRole('button', { name: 'Vulnerability scan' })).toBeEnabled());

    // The normal §3.0.2 review diff is still there, against 1.1.0.
    expect(within(detail).getByTestId('review-diff')).toHaveTextContent('1.1.0');
    expect(within(detail).getByTestId('review-dockerfile')).toBeInTheDocument();
    expect(within(detail).getByTestId('review-sbom')).toHaveTextContent('eslint@9.0.0');
    expect(within(detail).getByTestId('two-person-note')).toBeInTheDocument();
  });

  it('warns loudly when a queued submission shows a failed gate or a high finding, and when details are missing', async () => {
    api.getEcosystemRequest.mockResolvedValueOnce({
      success: true,
      data: {
        request: submissionItem, review, approvers: null, eligibility: null,
        submission: { ...submission, heuristics: [{ id: 'miner.xmrig', severity: 'high', path: 'run.sh', line: 1, excerpt: 'xmrig' }] },
      },
    });
    const { unmount } = render(<PublishQueuePanel can={() => true} />);
    const detail = await openDetail();
    expect(within(detail).getByText('Failed checks on a queued submission')).toBeInTheDocument();
    unmount();

    api.getEcosystemRequest.mockResolvedValueOnce({ success: true, data: { request: submissionItem, review, approvers: null, eligibility: null, submission: null } });
    render(<PublishQueuePanel can={() => true} />);
    const again = await openDetail();
    expect(within(again).getByText('Submission details unavailable')).toBeInTheDocument();
  });

  it('reads the plugin service\'s stored shape (gateReport.gates / facts, heuristics.findings)', async () => {
    api.getEcosystemRequest.mockResolvedValueOnce({
      success: true,
      data: {
        request: submissionItem, review, approvers: null, eligibility: null,
        submission: {
          id: 'sub-1', status: 'pending_review', name: 'eslint-runner', version: '1.2.0', newListing: false,
          submittedAt: '2026-09-20T00:00:00Z', verifiedAt: null,
          gateReport: {
            gates: [{ id: 'vuln', ok: true, message: 'No critical vulnerabilities' }],
            facts: { imageRepository: 'quarantine/sub-1', digest: 'sha256:abc', vulnCritical: 0, vulnHigh: 1, vulnMedium: 3, vulnLow: 7, scannedAt: '2026-09-20T00:06:00Z', runAsRoot: false },
            completedAt: '2026-09-20T00:07:00Z',
          },
          heuristics: { findings: [{ id: 'cred.imds', severity: 'medium', path: 'Dockerfile', line: 4, excerpt: 'curl 169.254.169.254' }] },
        },
      },
    });
    render(<PublishQueuePanel can={() => true} />);
    const section = await within(await openDetail()).findByTestId('submission-review-section');
    expect(within(section).getByText('Update to an existing listing')).toBeInTheDocument();
    expect(within(section).getByTestId('gate-vuln')).toHaveTextContent('No critical vulnerabilities');
    expect(within(section).getByTestId('finding-cred.imds')).toHaveTextContent('Dockerfile:4');
    expect(within(section).getByText('quarantine/sub-1@sha256:abc')).toBeInTheDocument();
    expect(within(section).getByTestId('submission-vuln')).toHaveTextContent('0 critical, 1 high, 3 medium, 7 low');
    expect(within(section).getByText('No SBOM.')).toBeInTheDocument();
  });

  it('rejecting says the submitter is emailed the reason', async () => {
    render(<PublishQueuePanel can={() => true} />);
    const detail = await openDetail();
    fireEvent.click(within(detail).getByRole('button', { name: 'Reject' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('The submitter is emailed the reason.')).toBeInTheDocument();
  });

  it('approving explains where it is published', async () => {
    render(<PublishQueuePanel can={() => true} />);
    const detail = await openDetail();
    fireEvent.click(within(detail).getByRole('button', { name: 'Approve' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('public/community/eslint-runner')).toBeInTheDocument();
  });
});

describe('Publish queue — claims on community listings (E10)', () => {
  const claim = { ...submissionItem, id: 'r-claim', kind: 'claim', requiresTwoPerson: false, payload: { target: { listingId: 'l-1' } }, listingName: 'eslint-runner', version: null };

  it('an email mismatch warns and makes the approval note a required justification', async () => {
    api.listEcosystemRequests.mockResolvedValue({ success: true, data: { requests: [claim] } });
    api.getEcosystemRequest.mockResolvedValue({ success: true, data: { request: claim, review, approvers: null, eligibility: null, claimEmailMatch: false } });
    render(<PublishQueuePanel can={() => true} />);
    fireEvent.click(await screen.findByRole('button', { name: /^review handle claim/i }));
    const detail = await screen.findByTestId('queue-detail');
    expect(within(detail).getByText('Email does not match submitter')).toBeInTheDocument();
    fireEvent.click(within(detail).getByRole('button', { name: 'Approve' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText(/Justification/)).toBeInTheDocument();
  });

  it('a match is confirmed', async () => {
    api.listEcosystemRequests.mockResolvedValue({ success: true, data: { requests: [claim] } });
    api.getEcosystemRequest.mockResolvedValue({ success: true, data: { request: claim, review, approvers: null, eligibility: null, claimEmailMatch: true } });
    render(<PublishQueuePanel can={() => true} />);
    fireEvent.click(await screen.findByRole('button', { name: /^review handle claim/i }));
    expect(await screen.findByText('Email matches the submitter')).toBeInTheDocument();
  });
});
