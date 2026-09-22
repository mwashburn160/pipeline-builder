// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Ecosystem console panels:
 *  - the queue's overview reports the server's approver standing and warns below
 *    two (and below the staffing minimum of three);
 *  - Verified applications show the automatic eligibility checks;
 *  - reserved names can be listed, added and removed;
 *  - a request the caller has a conflict of interest on can't be approved;
 *  - two-person requests say what the first approval does;
 *  - step-up kinds run the step-up flow and forward its token;
 *  - a viewer without the request's required permission sees no decision controls;
 *  - the proposer of an auto-approval rule change can't approve it;
 *  - publisher suspension and listing yanks go through step-up with a reason.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { PublishQueuePanel } from '../src/components/ecosystem/PublishQueuePanel';
import { AutoApprovalRulesPanel } from '../src/components/ecosystem/AutoApprovalRulesPanel';
import { PublisherVerificationPanel } from '../src/components/ecosystem/PublisherVerificationPanel';
import { ListingStatePanel } from '../src/components/ecosystem/ListingStatePanel';
import { ReservedNamesPanel } from '../src/components/ecosystem/ReservedNamesPanel';
import { pageToast } from './helpers/pageMocks';

jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());
// The step-up dialog: renders its details (the reason field lives there) and a
// button that "verifies" with a fixed token.
jest.mock('@/components/admin/StepUpModal', () => ({
  __esModule: true,
  StepUpModal: ({ title, details, onConfirmed, onClose, confirmDisabledReason }: {
    title?: string; details?: ReactNode; onConfirmed: (t: string) => Promise<void>; onClose: () => void; confirmDisabledReason?: string | null;
  }) => (
    <div data-testid="step-up">
      <p>{title}</p>
      {details}
      {confirmDisabledReason && <p>{confirmDisabledReason}</p>}
      <button disabled={!!confirmDisabledReason} onClick={() => { void onConfirmed('step-tok').then(onClose, () => {}); }}>Verify step-up</button>
    </div>
  ),
}));
jest.mock('@/hooks/useDebounce', () => ({ __esModule: true, useDebounce: <T,>(v: T) => v }));

const api = {
  getEcosystemOverview: jest.fn<AnyFn>(),
  listEcosystemRequests: jest.fn<AnyFn>(),
  getEcosystemRequest: jest.fn<AnyFn>(),
  approveEcosystemRequest: jest.fn<AnyFn>(),
  secondApproveEcosystemRequest: jest.fn<AnyFn>(),
  rejectEcosystemRequest: jest.fn<AnyFn>(),
  listAutoRules: jest.fn<AnyFn>(),
  createAutoRule: jest.fn<AnyFn>(),
  updateAutoRule: jest.fn<AnyFn>(),
  approveAutoRuleChange: jest.fn<AnyFn>(),
  deleteAutoRule: jest.fn<AnyFn>(),
  listEcosystemPublishers: jest.fn<AnyFn>(),
  suspendPublisher: jest.fn<AnyFn>(),
  unsuspendPublisher: jest.fn<AnyFn>(),
  setPublisherTier: jest.fn<AnyFn>(),
  listEcosystemListings: jest.fn<AnyFn>(),
  setListingState: jest.fn<AnyFn>(),
  yankListingVersion: jest.fn<AnyFn>(),
  requestUnyankListingVersion: jest.fn<AnyFn>(),
  resignAllPublishedImages: jest.fn<AnyFn>(),
  listReservedNames: jest.fn<AnyFn>(),
  putReservedName: jest.fn<AnyFn>(),
  deleteReservedName: jest.fn<AnyFn>(),
};
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: new Proxy({}, {
    get: (_t, key: string) => (...a: unknown[]) => (api as Record<string, AnyFn>)[key](...a),
  }),
}));

/** An approver standing with `holders` Ecosystem Managers (all eligible). */
const standing = (holders: number, permission = 'plugins:moderate') => ({
  permission,
  count: { holders, eligible: holders, superadmins: 1 },
  belowMinimum: holders < 3,
  belowTwoPerson: holders < 2,
});
const overview = (holders = 3) => ({
  approvers: { minimum: 3, twoPersonMinimum: 2, moderate: standing(holders), verify: standing(holders, 'publishers:verify') },
  pending: { standard: 2, security: 1, secondApproval: 1, verify: 0 },
  bootstrap: { state: 'closed', openedAt: null, closedAt: '2026-09-01', reason: null, approved: 12 },
  officialAutoApprovalEnabled: true,
  termsVersion: '2026-09',
  officialLoaderAccount: 'official-catalog-loader',
  resignJobs: [{ scope: 'publisher', id: 'pub1', reason: 'tier', done: 3, createdAt: '2026-09-20' }],
});

const baseItem = {
  id: 'r1', kind: 'new_listing', status: 'pending', lane: 'standard', publisherId: 'pub1', publisherHandle: 'acme',
  publisherTier: 'community', listingId: null, listingName: 'eslint', pluginId: 'p1', version: '1.0.0', digest: 'sha256:x',
  payload: { name: 'eslint' }, submittedBy: 'u-9', submittedOrgId: 'org-9', submittedAt: '2026-09-20T00:00:00Z',
  firstApprovedBy: null, secondApprovedBy: null, decidedBy: null, decidedAt: null, reason: null, autoRuleId: null,
  securityFixAdvisoryId: null, ageHours: 5, slaHours: 48, slaBreached: false, requiresTwoPerson: false,
  requiresStepUp: false, requiredPermission: 'plugins:moderate', conflictOfInterest: false, conflictReason: null,
};

const review = {
  previousVersion: '0.9.0',
  metadata: [
    { field: 'summary', value: 'Lint', previous: 'Old', source: 'spec', changed: true, userEdited: false, isLink: false, highlight: false },
    { field: 'homepageUrl', value: 'https://evil.example', previous: 'https://eslint.org', source: 'user', changed: true, userEdited: true, isLink: true, highlight: true },
  ],
  contract: {
    secrets: { added: ['NPM_TOKEN'], removed: [] },
    egress: { added: ['registry.npmjs.org'], removed: [] },
    requiredMetadata: { added: [], removed: [] },
    requiredVars: { added: [], removed: [] },
    env: { added: [], removed: [], changed: ['NODE_ENV'] },
    commands: { previous: ['npm ci'], current: ['npm ci', 'npx eslint .'], changed: true },
    installCommands: { previous: [], current: [], changed: false },
    runAsRoot: { previous: false, current: true, regression: true },
    pluginType: { previous: 'CodeBuildStep', current: 'CodeBuildStep' },
    computeType: { previous: 'SMALL', current: 'MEDIUM' },
  },
  vuln: { previous: { critical: 0, high: 1 }, current: { critical: 1, high: 1, scannedAt: '2026-09-20T00:00:00Z' }, newCritical: 1, newHigh: 0 },
  dockerfile: { previous: 'FROM node:20\nRUN npm ci', current: 'FROM node:22\nRUN npm ci', changed: true },
  sbom: { added: ['left-pad@1.0.0'], removed: ['lodash@4.17.20'], error: null },
  icon: { previous: null, current: { key: 'eslint' }, changed: true, curatedMark: true },
  gates: [{ id: 'signed', ok: true, message: 'Signed' }, { id: 'vuln', ok: false, message: 'New critical vulnerability' }],
  publisherHistory: { tier: 'community', createdAt: '2026-01-01', listings: 2, approved: 3, rejected: 1 },
  autoApproval: { eligible: false, ruleId: null, ruleName: null, reasons: ['Not a Verified publisher'], bump: 'minor', bootstrapOpen: false },
};

const canAll = () => true;

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.getEcosystemOverview.mockResolvedValue({ success: true, data: overview() });
  api.listEcosystemRequests.mockResolvedValue({ success: true, data: { requests: [baseItem] } });
  api.approveEcosystemRequest.mockResolvedValue({ success: true, data: { request: baseItem } });
  api.secondApproveEcosystemRequest.mockResolvedValue({ success: true, data: { request: baseItem } });
  api.rejectEcosystemRequest.mockResolvedValue({ success: true, data: { request: baseItem } });
});

const openDetail = async (item: Record<string, unknown>) => {
  api.listEcosystemRequests.mockResolvedValue({ success: true, data: { requests: [{ ...baseItem, ...item }] } });
  api.getEcosystemRequest.mockResolvedValue({ success: true, data: { request: { ...baseItem, ...item }, review, approvers: null, eligibility: null } });
  fireEvent.click(await screen.findByRole('button', { name: /^review/i }));
  return screen.findByTestId('queue-detail');
};

describe('Publish queue — overview and filters', () => {
  it('pages through the queue (oldest first for open requests) and says how much is left', async () => {
    api.listEcosystemRequests
      .mockResolvedValueOnce({ success: true, data: { requests: [baseItem], total: 2, nextCursor: 'c1' } })
      .mockResolvedValueOnce({ success: true, data: { requests: [{ ...baseItem, id: 'r2' }], total: 2, nextCursor: null } });
    render(<PublishQueuePanel can={canAll} />);
    expect(await screen.findByTestId('queue-count')).toHaveTextContent('Showing 1 of 2 — oldest first');
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(api.listEcosystemRequests).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'open', cursor: 'c1' })));
    expect(await screen.findByTestId('queue-item-r2')).toBeInTheDocument();
    expect(screen.getByTestId('queue-count')).toHaveTextContent('Showing 2 of 2');
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('shows pending counts, bootstrap state and the runbook link', async () => {
    render(<PublishQueuePanel can={canAll} />);
    const ov = await screen.findByTestId('queue-overview');
    expect(within(ov).getByText('Security lane')).toBeInTheDocument();
    expect(within(ov).getByText(/closed/)).toBeInTheDocument();
    expect(within(ov).getByText(/12 approved under it/)).toBeInTheDocument();
    expect(within(ov).getByText('official-catalog-loader')).toBeInTheDocument();
    expect(within(ov).getByTestId('resign-jobs')).toHaveTextContent('1 re-sign job running');
    await waitFor(() => expect(within(ov).getByText('3')).toBeInTheDocument());
    expect(within(ov).getByRole('link', { name: /moderation runbook/i }))
      .toHaveAttribute('href', expect.stringContaining('docs/runbooks/ecosystem-moderation.md'));
    expect(screen.queryByText(/fewer than two ecosystem managers/i)).not.toBeInTheDocument();
  });

  it('warns when fewer than two Ecosystem Managers hold the permission (the overview\'s count)', async () => {
    api.getEcosystemOverview.mockResolvedValue({ success: true, data: overview(1) });
    render(<PublishQueuePanel can={canAll} />);
    expect(await screen.findByText(/fewer than two ecosystem managers/i)).toBeInTheDocument();
    expect(screen.getByText(/keep at least 3/i)).toBeInTheDocument();
  });

  it('warns below the staffing minimum of three', async () => {
    api.getEcosystemOverview.mockResolvedValue({ success: true, data: overview(2) });
    render(<PublishQueuePanel can={canAll} />);
    expect(await screen.findByText(/below 3 ecosystem managers/i)).toBeInTheDocument();
    expect(screen.queryByText(/fewer than two ecosystem managers/i)).not.toBeInTheDocument();
  });

  it('shows no approver warning when the count is unknown', async () => {
    const o = overview(1);
    o.approvers.moderate = { ...o.approvers.moderate, count: null as never, belowMinimum: false, belowTwoPerson: false };
    api.getEcosystemOverview.mockResolvedValue({ success: true, data: o });
    render(<PublishQueuePanel can={canAll} />);
    const ov = await screen.findByTestId('queue-overview');
    expect(within(ov).getByText('—')).toBeInTheDocument();
    expect(screen.queryByText(/ecosystem managers/i, { selector: '[role="alert"] *' })).not.toBeInTheDocument();
    expect(screen.queryByText(/fewer than two ecosystem managers/i)).not.toBeInTheDocument();
  });

  it('re-queries with the chosen status, kind and lane; highlights the security lane', async () => {
    api.listEcosystemRequests.mockResolvedValue({
      success: true,
      data: { requests: [{ ...baseItem, lane: 'security', slaHours: 4, slaBreached: true }] },
    });
    render(<PublishQueuePanel can={canAll} />);
    expect(await screen.findByText(/security lane · 4h sla/i)).toBeInTheDocument();
    expect(screen.getByText('SLA breached')).toBeInTheDocument();
    expect(api.listEcosystemRequests).toHaveBeenCalledWith({ status: 'open', limit: 100 }, expect.anything());

    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'auto' } });
    fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'yank' } });
    fireEvent.change(screen.getByLabelText('Lane'), { target: { value: 'security' } });
    await waitFor(() => expect(api.listEcosystemRequests).toHaveBeenLastCalledWith(
      { status: 'auto', kind: 'yank', lane: 'security', limit: 100 }, expect.anything(),
    ));
  });
});

describe('Publish queue — review diff', () => {
  it('shows provenance, the highlighted edited link, contract deltas, vuln, Dockerfile and SBOM', async () => {
    render(<PublishQueuePanel can={canAll} />);
    await openDetail({});
    expect(screen.getByText(/edited links — check where they go/i)).toBeInTheDocument();
    expect(screen.getByText('minor bump')).toBeInTheDocument();
    expect(screen.getByTestId('review-field-homepageUrl')).toHaveAttribute('data-highlight', 'true');
    expect(within(screen.getByTestId('review-field-homepageUrl')).getByText('Edited')).toBeInTheDocument();
    expect(screen.getByText('+ NPM_TOKEN')).toBeInTheDocument();
    expect(screen.getByText('+ registry.npmjs.org')).toBeInTheDocument();
    expect(screen.getByText(/now runs as root/i)).toBeInTheDocument();
    expect(screen.getByText(/new: 1 critical/i)).toBeInTheDocument();
    const docker = within(screen.getByTestId('review-dockerfile'));
    expect(docker.getByText(/- FROM node:20/)).toBeInTheDocument();
    expect(docker.getByText(/\+ FROM node:22/)).toBeInTheDocument();
    expect(screen.getByText('+ left-pad@1.0.0')).toBeInTheDocument();
    expect(screen.getByText('- lodash@4.17.20')).toBeInTheDocument();
    expect(screen.getByText(/resembles a curated vendor mark/i)).toBeInTheDocument();
    expect(screen.getByText('Not a Verified publisher')).toBeInTheDocument();
  });
});

describe('Publish queue — decisions', () => {
  it('a conflict of interest disables every decision, with the reason', async () => {
    render(<PublishQueuePanel can={canAll} />);
    await openDetail({ conflictOfInterest: true, conflictReason: 'You belong to the submitting organization.' });
    expect(screen.getByText('You belong to the submitting organization.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^approve$/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^reject$/i })).toBeDisabled();
  });

  it('explains that a two-person first approval only moves it to second approval', async () => {
    api.approveEcosystemRequest.mockResolvedValue({ success: true, data: { request: { ...baseItem, status: 'pending_second_approval' } } });
    render(<PublishQueuePanel can={canAll} />);
    await openDetail({ requiresTwoPerson: true });
    expect(screen.getByTestId('two-person-note')).toHaveTextContent(/awaiting second approval/i);

    fireEvent.click(screen.getByRole('button', { name: /^approve$/i }));
    expect(screen.getByText(/first of two approvals/i)).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^approve$/i }));
    await waitFor(() => expect(api.approveEcosystemRequest).toHaveBeenCalledWith('r1', undefined, undefined));
    expect(pageToast.success).toHaveBeenCalledWith(expect.stringMatching(/waits for a second approver/i));
  });

  it('offers Second-approve on a request awaiting the second approval', async () => {
    render(<PublishQueuePanel can={canAll} />);
    await openDetail({ status: 'pending_second_approval', requiresTwoPerson: true, firstApprovedBy: 'mod-a' });
    expect(screen.getByTestId('two-person-note')).toHaveTextContent(/first approved by mod-a/i);
    fireEvent.click(screen.getByRole('button', { name: /second-approve/i }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /second-approve/i }));
    await waitFor(() => expect(api.secondApproveEcosystemRequest).toHaveBeenCalledWith('r1', undefined, undefined));
  });

  it('runs step-up before a step-up kind and forwards the token and note', async () => {
    render(<PublishQueuePanel can={canAll} />);
    await openDetail({ kind: 'yank', requiresStepUp: true, payload: {}, listingName: 'eslint', version: '1.0.0' });
    fireEvent.click(screen.getByRole('button', { name: /^approve$/i }));
    const stepUp = screen.getByTestId('step-up');
    fireEvent.change(within(stepUp).getByLabelText(/note/i), { target: { value: 'confirmed CVE' } });
    fireEvent.click(within(stepUp).getByRole('button', { name: 'Verify step-up' }));
    await waitFor(() => expect(api.approveEcosystemRequest).toHaveBeenCalledWith('r1', 'confirmed CVE', 'step-tok'));
  });

  it('rejecting needs a reason', async () => {
    render(<PublishQueuePanel can={canAll} />);
    await openDetail({});
    fireEvent.click(screen.getByRole('button', { name: /^reject$/i }));
    const dialog = screen.getByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: /^reject$/i });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/reason/i), { target: { value: 'Not a real plugin' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(api.rejectEcosystemRequest).toHaveBeenCalledWith('r1', 'Not a real plugin'));
  });

  it('hides the decision controls from a viewer without the required permission', async () => {
    render(<PublishQueuePanel can={(p) => p === 'plugins:moderate'} />);
    await openDetail({ kind: 'verify', requiredPermission: 'publishers:verify' });
    expect(screen.queryByTestId('queue-decision')).not.toBeInTheDocument();
    expect(screen.getByTestId('review-diff')).toBeInTheDocument();
  });
});

const rule = (over: Record<string, unknown> = {}) => ({
  id: 'rule-1', name: 'Verified updates', enabled: true,
  conditions: { requestKinds: ['new_version'], publisherTiers: ['verified'], bumps: ['patch', 'minor'], maxPerDay: 50 },
  createdBy: 'u-a', approvedBy: 'u-b', createdAt: '2026-09-01', updatedAt: '2026-09-01',
  pendingChange: null, seeded: true, approvedToday: 4, flagDisabled: false,
  ...over,
});
const pendingChange = (requestedBy: string) => ({
  requestedBy, requestedAt: '2026-09-20T00:00:00Z', enabled: true, name: 'Verified updates',
  conditions: { requestKinds: ['new_version'], publisherTiers: ['verified', 'community'], bumps: ['patch'] },
});

describe('Auto-approval rules', () => {
  beforeEach(() => {
    api.updateAutoRule.mockResolvedValue({ success: true, data: { rule: rule() } });
    api.approveAutoRuleChange.mockResolvedValue({ success: true, data: { rule: rule() } });
    api.createAutoRule.mockResolvedValue({ success: true, data: { rule: rule() } });
    api.deleteAutoRule.mockResolvedValue({ success: true, data: { deleted: true } });
  });

  it('lists rules with their seeded / enabled / flag / usage state', async () => {
    api.listAutoRules.mockResolvedValue({ success: true, data: { rules: [rule({ flagDisabled: true })] } });
    render(<AutoApprovalRulesPanel can={canAll} currentUserId="u-me" />);
    const row = await screen.findByTestId('rule-rule-1');
    expect(within(row).getByText('Seeded')).toBeInTheDocument();
    expect(within(row).getByText('Enabled')).toBeInTheDocument();
    expect(within(row).getByText('Off by instance flag')).toBeInTheDocument();
    expect(within(row).getByText('4 approved today')).toBeInTheDocument();
    expect(within(row).getByText('At most 50 per day')).toBeInTheDocument();
  });

  it('the proposer of a pending change cannot approve it', async () => {
    api.listAutoRules.mockResolvedValue({ success: true, data: { rules: [rule({ pendingChange: pendingChange('u-me') })] } });
    render(<AutoApprovalRulesPanel can={canAll} currentUserId="u-me" />);
    expect(await screen.findByTestId('own-proposal-note')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /approve the change/i })).not.toBeInTheDocument();
  });

  it('another manager approves the change through step-up', async () => {
    api.listAutoRules.mockResolvedValue({ success: true, data: { rules: [rule({ pendingChange: pendingChange('u-other') })] } });
    render(<AutoApprovalRulesPanel can={canAll} currentUserId="u-me" />);
    fireEvent.click(await screen.findByRole('button', { name: /approve the change to verified updates/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Verify step-up' }));
    await waitFor(() => expect(api.approveAutoRuleChange).toHaveBeenCalledWith('rule-1', 'step-tok'));
  });

  it('disabling applies through step-up', async () => {
    api.listAutoRules.mockResolvedValue({ success: true, data: { rules: [rule()] } });
    render(<AutoApprovalRulesPanel can={canAll} currentUserId="u-me" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Disable Verified updates' }));
    fireEvent.click(screen.getByRole('button', { name: 'Verify step-up' }));
    await waitFor(() => expect(api.updateAutoRule).toHaveBeenCalledWith('rule-1', { enabled: false }, 'step-tok'));
  });

  it('creates a rule (form, then step-up)', async () => {
    api.listAutoRules.mockResolvedValue({ success: true, data: { rules: [] } });
    render(<AutoApprovalRulesPanel can={canAll} currentUserId="u-me" />);
    fireEvent.click(await screen.findByRole('button', { name: /new rule/i }));
    fireEvent.change(screen.getByLabelText(/^name/i), { target: { value: 'Minor bumps' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Minor' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Verify step-up' }));
    await waitFor(() => expect(api.createAutoRule).toHaveBeenCalledWith({
      name: 'Minor bumps',
      conditions: { requestKinds: ['new_version'], publisherTiers: ['verified'], bumps: ['patch', 'minor'] },
    }, 'step-tok'));
  });

  it('a refused save returns to the FILLED form with the reason', async () => {
    api.listAutoRules.mockResolvedValue({ success: true, data: { rules: [] } });
    api.createAutoRule.mockRejectedValue(new Error('Invalid conditions: bumps: bad'));
    render(<AutoApprovalRulesPanel can={canAll} currentUserId="u-me" />);
    fireEvent.click(await screen.findByRole('button', { name: /new rule/i }));
    fireEvent.change(screen.getByLabelText(/^name/i), { target: { value: 'Minor bumps' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Verify step-up' }));
    expect(await screen.findByText('Invalid conditions: bumps: bad')).toBeInTheDocument();
    expect(screen.getByLabelText(/^name/i)).toHaveValue('Minor bumps');
  });

  it('refuses an incomplete rule before the step-up, not after it', async () => {
    api.listAutoRules.mockResolvedValue({ success: true, data: { rules: [] } });
    render(<AutoApprovalRulesPanel can={canAll} currentUserId="u-me" />);
    fireEvent.click(await screen.findByRole('button', { name: /new rule/i }));
    fireEvent.change(screen.getByLabelText(/^name/i), { target: { value: 'No bumps' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Patch' }));
    expect(screen.getByText(/which version bumps/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
  });

  it('warns that a superadmin must be the second approver with fewer than two managers', async () => {
    api.getEcosystemOverview.mockResolvedValue({ success: true, data: overview(1) });
    api.listAutoRules.mockResolvedValue({ success: true, data: { rules: [] } });
    render(<AutoApprovalRulesPanel can={canAll} currentUserId="u-me" />);
    expect(await screen.findByTestId('rules-too-few-approvers')).toHaveTextContent(/superadmin/i);
    expect(screen.getByRole('button', { name: /new rule/i })).toBeEnabled();
  });

  it('shows no write controls without plugins:moderate', async () => {
    api.listAutoRules.mockResolvedValue({ success: true, data: { rules: [rule({ pendingChange: pendingChange('u-other') })] } });
    render(<AutoApprovalRulesPanel can={() => false} currentUserId="u-me" />);
    await screen.findByTestId('rule-rule-1');
    expect(screen.queryByRole('button', { name: /new rule|disable|approve the change|delete/i })).not.toBeInTheDocument();
  });
});

const pub = (over: Record<string, unknown> = {}) => ({
  id: 'pub1', handle: 'acme', displayName: 'Acme', description: null, homepageUrl: null, tier: 'community',
  verifiedAt: null, verifiedGraceUntil: null, termsVersion: '1', termsAcceptedAt: null, suspendedAt: null, suspendReason: null,
  ownerOrgId: 'org-1', createdAt: '2026-01-01', updatedAt: '2026-01-01', listingCount: 2, ...over,
});

describe('Publisher verification', () => {
  beforeEach(() => {
    api.listEcosystemRequests.mockResolvedValue({ success: true, data: { requests: [{ ...baseItem, id: 'v1', kind: 'verify', payload: { application: { domain: 'acme.dev' } } }] } });
    api.listEcosystemPublishers.mockResolvedValue({ success: true, data: { publishers: [pub(), pub({ id: 'pub2', handle: 'bad', suspendedAt: '2026-09-01', suspendReason: 'spam' })] } });
    api.suspendPublisher.mockResolvedValue({ success: true, data: { publisher: pub() } });
    api.unsuspendPublisher.mockResolvedValue({ success: true, data: { request: baseItem } });
    api.setPublisherTier.mockResolvedValue({ success: true, data: { request: baseItem } });
  });

  it('lists pending applications and publishers', async () => {
    render(<PublisherVerificationPanel can={canAll} />);
    expect(await screen.findByText(/acme\.dev/)).toBeInTheDocument();
    expect(api.listEcosystemRequests).toHaveBeenCalledWith({ status: 'open', kind: 'verify' }, expect.anything());
    expect(await screen.findByTestId('publisher-bad')).toHaveTextContent('Suspended');
  });

  it('suspending needs a reason and step-up', async () => {
    render(<PublisherVerificationPanel can={canAll} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Suspend acme' }));
    // The reason is required BEFORE the step-up can be spent.
    expect(screen.getByRole('button', { name: 'Verify step-up' })).toBeDisabled();
    expect(api.suspendPublisher).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: 'Malware' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify step-up' }));
    await waitFor(() => expect(api.suspendPublisher).toHaveBeenCalledWith('pub1', 'Malware', 'step-tok'));
  });

  it('lifting a suspension and awarding Verified are two-person requests', async () => {
    render(<PublisherVerificationPanel can={canAll} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Lift the suspension of bad' }));
    fireEvent.click(screen.getByRole('button', { name: 'Verify step-up' }));
    await waitFor(() => expect(api.unsuspendPublisher).toHaveBeenCalledWith('pub2', undefined, 'step-tok'));
    expect(pageToast.success).toHaveBeenCalledWith(expect.stringMatching(/second approver/i));

    fireEvent.click(screen.getByRole('button', { name: 'Make acme Verified' }));
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: 'Domain verified' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify step-up' }));
    await waitFor(() => expect(api.setPublisherTier).toHaveBeenCalledWith('pub1', 'verified', 'Domain verified', 'step-tok'));
  });

  it('opens an application in the review view', async () => {
    api.getEcosystemRequest.mockResolvedValue({
      success: true,
      data: { request: { ...baseItem, id: 'v1', kind: 'verify', requiredPermission: 'publishers:verify' }, review: { ...review, contract: null, vuln: null, dockerfile: null, sbom: null, icon: null, metadata: [] } },
    });
    render(<PublisherVerificationPanel can={canAll} />);
    fireEvent.click(await screen.findByRole('button', { name: /review application from acme/i }));
    expect(await screen.findByTestId('queue-detail')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /back to publishers/i }));
    expect(await screen.findByText('Publishers')).toBeInTheDocument();
  });

  it('shows no write controls without publishers:verify', async () => {
    render(<PublisherVerificationPanel can={() => false} />);
    await screen.findByTestId('publisher-acme');
    expect(screen.queryByRole('button', { name: /suspend|verified|community/i })).not.toBeInTheDocument();
  });
});

const ecoListing = {
  id: 'l1', publisherId: 'pub1', publisherHandle: 'acme', publisherTier: 'community', name: 'eslint', category: 'quality',
  summary: null, description: null, license: 'MIT', homepageUrl: null, sourceUrl: null, icon: null, keywords: [],
  state: 'suspended', pausedAt: null, featured: false, latestVersion: '1.0.0', createdAt: '2026-01-01', updatedAt: '2026-01-01',
  versions: [
    { id: 'v1', version: '1.0.0', imageDigest: null, imageRepository: null, breaking: false, pausedAt: null, yankedAt: null, yankReason: null, vulnCritical: 0, vulnHigh: 0, publishedAt: '2026-01-01', changelog: null },
    { id: 'v2', version: '0.9.0', imageDigest: null, imageRepository: null, breaking: false, pausedAt: null, yankedAt: '2026-02-01', yankReason: 'cve', vulnCritical: 0, vulnHigh: 0, publishedAt: '2025-12-01', changelog: null },
  ],
};

describe('Listing state', () => {
  beforeEach(() => {
    api.listEcosystemListings.mockResolvedValue({ success: true, data: { listings: [ecoListing] } });
    api.setListingState.mockResolvedValue({ success: true, data: { request: baseItem } });
    api.yankListingVersion.mockResolvedValue({ success: true, data: { listing: ecoListing } });
    api.requestUnyankListingVersion.mockResolvedValue({ success: true, data: { request: baseItem } });
  });

  it('relisting a suspended listing says it is two-person', async () => {
    render(<ListingStatePanel can={canAll} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Relist: eslint' }));
    expect(screen.getByText(/lifting a suspension is two-person/i)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: 'Fixed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify step-up' }));
    await waitFor(() => expect(api.setListingState).toHaveBeenCalledWith('l1', 'listed', 'Fixed', 'step-tok'));
    expect(pageToast.success).toHaveBeenCalledWith(expect.stringMatching(/second approver/i));
  });

  it('yanks a version and requests an unyank', async () => {
    render(<ListingStatePanel can={canAll} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Yank eslint v1.0.0' }));
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: 'Malicious' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify step-up' }));
    await waitFor(() => expect(api.yankListingVersion).toHaveBeenCalledWith('l1', '1.0.0', 'Malicious', 'step-tok'));

    fireEvent.click(screen.getByRole('button', { name: 'Request unyank of eslint v0.9.0' }));
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: 'False positive' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify step-up' }));
    await waitFor(() => expect(api.requestUnyankListingVersion).toHaveBeenCalledWith('l1', '0.9.0', 'False positive', 'step-tok'));
  });

  it('re-signs every published image with a reason and step-up', async () => {
    api.resignAllPublishedImages.mockResolvedValue({ success: true, data: { queued: 7 } });
    render(<ListingStatePanel can={canAll} />);
    fireEvent.click(await screen.findByRole('button', { name: /re-sign all published images/i }));
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: 'Key rotated' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify step-up' }));
    await waitFor(() => expect(api.resignAllPublishedImages).toHaveBeenCalledWith('Key rotated', 'step-tok'));
    expect(pageToast.success).toHaveBeenCalledWith('Queued a re-sign of 7 published images');
  });

  it('filters by state', async () => {
    render(<ListingStatePanel can={canAll} />);
    await screen.findByTestId('eco-listing-eslint');
    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'unmaintained' } });
    await waitFor(() => expect(api.listEcosystemListings).toHaveBeenLastCalledWith({ state: 'unmaintained' }, expect.anything()));
  });
});

const eligibility = (over: Partial<Record<'plan' | 'domain' | 'owner_mfa', boolean | null>> = {}) => {
  const ok = { plan: true, domain: true, owner_mfa: true, ...over };
  return {
    eligible: Object.values(ok).every((v) => v === true),
    checkedAt: '2026-09-21T00:00:00Z',
    verifiedDomains: ok.domain ? ['acme.dev'] : [],
    checks: [
      { id: 'plan', ok: ok.plan, detail: 'The plan includes Verified publishing.' },
      { id: 'domain', ok: ok.domain, detail: ok.domain ? 'Verified domain: acme.dev.' : 'The organization has no DNS-verified domain.' },
      { id: 'owner_mfa', ok: ok.owner_mfa, detail: ok.owner_mfa === null ? 'Owner two-factor enrolment could not be checked.' : 'Every owner has two-factor authentication.' },
    ],
  };
};

describe('Verified eligibility checks', () => {
  it('each application row shows the checks as recorded when it was submitted', async () => {
    api.listEcosystemRequests.mockResolvedValue({
      success: true,
      data: { requests: [{ ...baseItem, id: 'v1', kind: 'verify', payload: { application: { domain: 'acme.dev' }, eligibility: eligibility() } }] },
    });
    api.listEcosystemPublishers.mockResolvedValue({ success: true, data: { publishers: [] } });
    render(<PublisherVerificationPanel can={canAll} />);
    const checks = await screen.findByTestId('verified-checks');
    expect(checks).toHaveTextContent('Plan ✓');
    expect(checks).toHaveTextContent('Verified domain ✓');
    expect(checks).toHaveTextContent('Owner MFA ✓');
  });

  it('the review shows the LIVE re-check with each failing detail', async () => {
    render(<PublishQueuePanel can={canAll} />);
    const item = { ...baseItem, kind: 'verify', requiredPermission: 'publishers:verify', payload: { eligibility: eligibility() } };
    api.listEcosystemRequests.mockResolvedValue({ success: true, data: { requests: [item] } });
    api.getEcosystemRequest.mockResolvedValue({
      success: true,
      data: { request: item, review, approvers: null, eligibility: eligibility({ domain: false, owner_mfa: null }) },
    });
    fireEvent.click(await screen.findByRole('button', { name: /^review/i }));
    const box = await screen.findByTestId('verified-eligibility');
    expect(box).toHaveTextContent('checked now');
    expect(box).toHaveTextContent('Not eligible');
    expect(box).toHaveTextContent('no DNS-verified domain');
    expect(box).toHaveTextContent('could not be checked');
  });

  it('a decided application falls back to the submit-time snapshot', async () => {
    render(<PublishQueuePanel can={canAll} />);
    const item = { ...baseItem, kind: 'verify', status: 'approved', payload: { eligibility: eligibility() } };
    api.listEcosystemRequests.mockResolvedValue({ success: true, data: { requests: [item] } });
    api.getEcosystemRequest.mockResolvedValue({ success: true, data: { request: item, review, approvers: null, eligibility: null } });
    fireEvent.click(await screen.findByRole('button', { name: /^review/i }));
    expect(await screen.findByTestId('verified-eligibility')).toHaveTextContent('when submitted');
  });
});

describe('Per-request eligible approvers', () => {
  it('says how many managers can decide after the requester\'s conflicts, and when a superadmin is needed', async () => {
    render(<PublishQueuePanel can={canAll} />);
    const item = { ...baseItem, requiresTwoPerson: true };
    api.listEcosystemRequests.mockResolvedValue({ success: true, data: { requests: [item] } });
    api.getEcosystemRequest.mockResolvedValue({
      success: true,
      data: {
        request: item, review, eligibility: null,
        approvers: { permission: 'plugins:moderate', count: { holders: 3, eligible: 1, superadmins: 2 }, belowMinimum: false, belowTwoPerson: true },
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: /^review/i }));
    const note = await screen.findByTestId('request-approvers');
    expect(note).toHaveTextContent('1 of 3 Ecosystem Managers with moderation rights can decide this request');
    expect(note).toHaveTextContent('2 superadmins can also act');
    expect(note).toHaveTextContent('Two-person approval will need a superadmin.');
  });
});

describe('Reserved names', () => {
  const names = [
    { name: 'trivy', reason: 'Vendor brand', publisherId: null, createdAt: '2026-09-01T00:00:00Z' },
    { name: 'acme', reason: null, publisherId: 'pub1', createdAt: '2026-09-02T00:00:00Z' },
  ];
  beforeEach(() => {
    api.listReservedNames.mockResolvedValue({ success: true, data: { names } });
    api.listEcosystemPublishers.mockResolvedValue({ success: true, data: { publishers: [pub()] } });
    api.putReservedName.mockResolvedValue({ success: true, data: names[0] });
    api.deleteReservedName.mockResolvedValue({ success: true, data: { deleted: true } });
  });

  it('lists each name with who may claim it', async () => {
    render(<ReservedNamesPanel can={canAll} />);
    expect(await screen.findByTestId('reserved-trivy')).toHaveTextContent('Refused to everyone');
    expect(screen.getByTestId('reserved-trivy')).toHaveTextContent('Vendor brand');
    await waitFor(() => expect(screen.getByTestId('reserved-acme')).toHaveTextContent('Reserved for acme'));
  });

  it('reserves a name (lowercased) for a publisher', async () => {
    render(<ReservedNamesPanel can={canAll} />);
    await screen.findByTestId('reserved-trivy');
    fireEvent.change(screen.getByLabelText(/^name/i), { target: { value: 'Snyk' } });
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: 'Vendor' } });
    await waitFor(() => expect(screen.getByRole('option', { name: 'acme' })).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Reserved for publisher'), { target: { value: 'pub1' } });
    fireEvent.click(screen.getByRole('button', { name: /^reserve$/i }));
    await waitFor(() => expect(api.putReservedName).toHaveBeenCalledWith('snyk', { reason: 'Vendor', publisherId: 'pub1' }));
    expect(pageToast.success).toHaveBeenCalledWith('Reserved snyk');
    await waitFor(() => expect(api.listReservedNames).toHaveBeenCalledTimes(2));
  });

  it('refuses a malformed name before calling the API, and shows a server refusal', async () => {
    render(<ReservedNamesPanel can={canAll} />);
    await screen.findByTestId('reserved-trivy');
    fireEvent.change(screen.getByLabelText(/^name/i), { target: { value: 'bad name!' } });
    expect(screen.getByRole('button', { name: /^reserve$/i })).toBeDisabled();
    expect(screen.getByText(/lowercase letters, digits/i)).toBeInTheDocument();

    api.putReservedName.mockRejectedValueOnce(new Error('Publisher not found'));
    fireEvent.change(screen.getByLabelText(/^name/i), { target: { value: 'okname' } });
    fireEvent.click(screen.getByRole('button', { name: /^reserve$/i }));
    expect(await screen.findByText(/publisher not found/i)).toBeInTheDocument();
  });

  it('removes a reservation after confirmation', async () => {
    render(<ReservedNamesPanel can={canAll} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove reserved name trivy' }));
    expect(screen.getByText(/anyone can then claim this name/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.deleteReservedName).toHaveBeenCalledWith('trivy'));
    expect(pageToast.success).toHaveBeenCalledWith('trivy is no longer reserved');
  });

  it('is read-only without plugins:moderate, and shows an empty state', async () => {
    api.listReservedNames.mockResolvedValue({ success: true, data: { names: [] } });
    render(<ReservedNamesPanel can={() => false} />);
    expect(await screen.findByText('No reserved names')).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: /reserve a name/i })).not.toBeInTheDocument();
  });
});
