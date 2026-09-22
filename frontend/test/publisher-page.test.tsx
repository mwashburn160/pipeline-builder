// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The tenant Publisher page (plan §3.1, §3.4, §3.7):
 *  - no publisher yet: the create form (handle + terms); a reserved handle
 *    offers a `claim` request instead;
 *  - terms changed: a re-acceptance banner;
 *  - a team org: publishing happens from the root org;
 *  - publishing disabled on the instance;
 *  - Verified: disabled below Team, an application otherwise;
 *  - listings: pause is immediate, unpause / yank are requests;
 *  - requests: withdraw, and incoming transfers accepted through step-up.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import PublisherPage from '../pages/dashboard/publisher';
import { ApiError } from '../src/lib/api/errors';
import { mockAuthGuard, pageToast } from './helpers/pageMocks';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());
jest.mock('@/components/admin/StepUpModal', () => ({
  __esModule: true,
  StepUpModal: ({ details, onConfirmed, onClose }: { details?: ReactNode; onConfirmed: (t: string) => Promise<void>; onClose: () => void }) => (
    <div data-testid="step-up">
      {details}
      <button onClick={() => { void onConfirmed('step-tok').then(onClose, () => {}); }}>Verify step-up</button>
    </div>
  ),
}));

let routerQuery: Record<string, string> = {};
jest.mock('next/router', () => ({
  __esModule: true,
  useRouter: () => ({
    isReady: true,
    query: routerQuery,
    pathname: '/dashboard/publisher',
    replace: ({ query }: { query: Record<string, string> }) => { routerQuery = query; return Promise.resolve(true); },
  }),
}));

const api = {
  getPublisher: jest.fn<AnyFn>(),
  createPublisher: jest.fn<AnyFn>(),
  updatePublisher: jest.fn<AnyFn>(),
  acceptPublisherTerms: jest.fn<AnyFn>(),
  submitPublishRequest: jest.fn<AnyFn>(),
  listPublisherListings: jest.fn<AnyFn>(),
  pauseListing: jest.fn<AnyFn>(),
  listPublishRequests: jest.fn<AnyFn>(),
  listIncomingTransfers: jest.fn<AnyFn>(),
  withdrawPublishRequest: jest.fn<AnyFn>(),
  respondToTransfer: jest.fn<AnyFn>(),
  listPlugins: jest.fn<AnyFn>(),
  listPublisherAdvisories: jest.fn<AnyFn>(),
  getPublishDraft: jest.fn<AnyFn>(),
  getPublisherInsights: jest.fn<AnyFn>(),
};
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: new Proxy({}, {
    get: (_t, key: string) => (...a: unknown[]) => (api as Record<string, AnyFn>)[key](...a),
  }),
}));

const publisher = {
  id: 'pub1', handle: 'acme', displayName: 'Acme Corp', description: 'Tools', homepageUrl: null, tier: 'community',
  verifiedAt: null, verifiedGraceUntil: null, termsVersion: '2026-01', termsAcceptedAt: '2026-01-01', suspendedAt: null,
  suspendReason: null, ownerOrgId: 'org-1', createdAt: '2026-01-01', updatedAt: '2026-01-02',
};

const ctx = (over: Record<string, unknown> = {}) => ({
  publisher,
  isRootOrg: true,
  terms: { currentVersion: '2026-09', accepted: true },
  verifiedEligible: false,
  listingsQuota: { used: 2, limit: 3 },
  publishingEnabled: true,
  ...over,
});

const listing = {
  id: 'l1', publisherId: 'pub1', publisherHandle: 'acme', publisherTier: 'community', name: 'eslint', category: 'quality',
  summary: 'Lint JS', description: null, license: 'MIT', homepageUrl: null, sourceUrl: null, icon: null, keywords: [],
  state: 'listed', pausedAt: null, featured: false, latestVersion: '1.0.0', createdAt: '2026-01-01', updatedAt: '2026-01-01',
  openRequests: 1,
  versions: [
    { id: 'v1', version: '1.0.0', imageDigest: null, imageRepository: null, breaking: false, pausedAt: null, yankedAt: null, yankReason: null, vulnCritical: 0, vulnHigh: 2, publishedAt: '2026-01-01', changelog: null },
    { id: 'v0', version: '0.9.0', imageDigest: null, imageRepository: null, breaking: false, pausedAt: '2026-02-01', yankedAt: null, yankReason: null, vulnCritical: 0, vulnHigh: 0, publishedAt: '2025-12-01', changelog: null },
  ],
};

const request = (over: Record<string, unknown> = {}) => ({
  id: 'r1', kind: 'new_listing', status: 'pending', lane: 'standard', publisherId: 'pub1', publisherHandle: 'acme',
  publisherTier: 'community', listingId: null, listingName: 'eslint', pluginId: 'p1', version: '1.0.0', digest: null,
  payload: {}, submittedBy: 'u1', submittedOrgId: 'org-1', submittedAt: '2026-09-20T00:00:00Z', firstApprovedBy: null,
  secondApprovedBy: null, decidedBy: null, decidedAt: null, reason: null, autoRuleId: null, securityFixAdvisoryId: null,
  ...over,
});

const allPerms = (p: string) => ['plugins:read', 'plugins:publish', 'publishers:manage'].includes(p);

beforeEach(() => {
  routerQuery = {};
  for (const fn of Object.values(api)) fn.mockReset();
  mockAuthGuard({ can: allPerms });
  api.getPublisher.mockResolvedValue({ success: true, data: ctx() });
  api.listPublisherListings.mockResolvedValue({ success: true, data: { listings: [listing] } });
  api.listPublishRequests.mockResolvedValue({ success: true, data: { requests: [request()] } });
  api.listIncomingTransfers.mockResolvedValue({ success: true, data: { requests: [] } });
  api.submitPublishRequest.mockResolvedValue({ success: true, data: { request: request(), autoApproved: false } });
  api.pauseListing.mockResolvedValue({ success: true, data: { listing } });
  api.withdrawPublishRequest.mockResolvedValue({ success: true, data: { request: request({ status: 'withdrawn' }) } });
  api.respondToTransfer.mockResolvedValue({ success: true, data: { request: request() } });
  api.listPlugins.mockResolvedValue({ success: true, data: { plugins: [
    { id: 'p1', orgId: 'org-1', name: 'eslint', version: '1.1.0', visibility: 'public' },
    { id: 'p2', orgId: 'org-1', name: 'secret', version: '1.0.0', visibility: 'private' },
    { id: 'p3', orgId: 'system', name: 'trivy', version: '1.0.0', visibility: 'public' },
  ] } });
});

const tab = (name: RegExp) => fireEvent.click(screen.getByRole('tab', { name }));

describe('Publisher page — profile states', () => {
  it('renders the access denial', async () => {
    mockAuthGuard({ accessDenied: { kind: 'permission', permission: 'plugins:read', pathname: '/dashboard/publisher' }, isReady: false });
    render(<PublisherPage />);
    expect(await screen.findByTestId('access-denied')).toHaveTextContent('plugins:read');
    await waitFor(() => expect(api.getPublisher).not.toHaveBeenCalled());
  });

  it('no publisher yet: create with a handle and the terms', async () => {
    api.getPublisher.mockResolvedValue({ success: true, data: ctx({ publisher: null }) });
    api.createPublisher.mockResolvedValue({ success: true, data: { publisher } });
    render(<PublisherPage />);
    expect(await screen.findByText('Create your publisher')).toBeInTheDocument();
    const create = screen.getByRole('button', { name: 'Create publisher' });
    expect(create).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/^handle/i), { target: { value: 'Acme' } });
    fireEvent.change(screen.getByLabelText(/^display name/i), { target: { value: 'Acme Corp' } });
    expect(create).toBeDisabled(); // terms not yet accepted
    fireEvent.click(screen.getByRole('checkbox', { name: /accept the publisher terms/i }));
    fireEvent.click(create);
    await waitFor(() => expect(api.createPublisher).toHaveBeenCalledWith({ handle: 'acme', displayName: 'Acme Corp', termsVersion: '2026-09' }));
  });

  it('a reserved handle offers a claim request', async () => {
    api.getPublisher.mockResolvedValue({ success: true, data: ctx({ publisher: null }) });
    api.createPublisher.mockRejectedValue(new ApiError('reserved', 409, 'PUBLISHER_HANDLE_RESERVED'));
    render(<PublisherPage />);
    await screen.findByText('Create your publisher');
    fireEvent.change(screen.getByLabelText(/^handle/i), { target: { value: 'eslint' } });
    fireEvent.change(screen.getByLabelText(/^display name/i), { target: { value: 'ESLint' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /accept the publisher terms/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Create publisher' }));
    expect(await screen.findByText('That handle is reserved')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Request this handle' }));
    fireEvent.change(screen.getByLabelText(/why this handle is yours/i), { target: { value: 'We maintain ESLint' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit claim' }));
    await waitFor(() => expect(api.submitPublishRequest).toHaveBeenCalledWith({ kind: 'claim', target: { handle: 'eslint' }, reason: 'We maintain ESLint' }));
  });

  it('asks to re-accept changed terms', async () => {
    api.getPublisher.mockResolvedValue({ success: true, data: ctx({ terms: { currentVersion: '2026-09', accepted: false } }) });
    api.acceptPublisherTerms.mockResolvedValue({ success: true, data: { publisher } });
    render(<PublisherPage />);
    expect(await screen.findByText('The publisher terms have changed')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Accept the new terms' }));
    await waitFor(() => expect(api.acceptPublisherTerms).toHaveBeenCalledWith('2026-09'));
  });

  it('a team org is told publishing happens from the root org', async () => {
    api.getPublisher.mockResolvedValue({ success: true, data: ctx({ publisher: null, isRootOrg: false }) });
    render(<PublisherPage />);
    expect(await screen.findByText('Publishing happens from your root organization')).toBeInTheDocument();
    expect(screen.queryByText('Create your publisher')).not.toBeInTheDocument();
    tab(/listings/i);
    expect(await screen.findByText(/switch to your root organization/i)).toBeInTheDocument();
    expect(api.listPublisherListings).not.toHaveBeenCalled();
  });

  it('publishing disabled on the instance', async () => {
    api.getPublisher.mockResolvedValue({ success: true, data: ctx({ publishingEnabled: false }) });
    render(<PublisherPage />);
    expect(await screen.findByText('Publishing is turned off')).toBeInTheDocument();
  });

  it('shows tier, quota, and Verified disabled below Team', async () => {
    render(<PublisherPage />);
    expect(await screen.findByText('Acme Corp')).toBeInTheDocument();
    expect(screen.getByTestId('listings-quota')).toHaveTextContent('2 of 3');
    expect(screen.getByText(/available to organizations on the team and enterprise plans/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /apply for verified/i })).toBeDisabled();
  });

  it('applies for Verified when eligible, and edits the description directly', async () => {
    api.getPublisher.mockResolvedValue({ success: true, data: ctx({ verifiedEligible: true }) });
    api.updatePublisher.mockResolvedValue({ success: true, data: { publisher } });
    render(<PublisherPage />);
    fireEvent.click(await screen.findByRole('button', { name: /apply for verified/i }));
    fireEvent.change(screen.getByLabelText(/verified domain/i), { target: { value: 'acme.dev' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit application' }));
    await waitFor(() => expect(api.submitPublishRequest).toHaveBeenCalledWith({ kind: 'verify', application: { domain: 'acme.dev' } }));

    fireEvent.change(screen.getByLabelText(/^description/i), { target: { value: 'Better tools' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.updatePublisher).toHaveBeenCalledWith({ description: 'Better tools', homepageUrl: null }));
  });

  it('requests a handle change', async () => {
    render(<PublisherPage />);
    fireEvent.click(await screen.findByRole('button', { name: /request handle or name change/i }));
    fireEvent.change(screen.getByLabelText(/new handle/i), { target: { value: 'acme-corp' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit request' }));
    await waitFor(() => expect(api.submitPublishRequest).toHaveBeenCalledWith({ kind: 'profile_change', target: { handle: 'acme-corp' } }));
  });

  it('a member without publishers:manage sees the profile read-only', async () => {
    mockAuthGuard({ can: (p) => p === 'plugins:read' });
    render(<PublisherPage />);
    expect(await screen.findByText('Acme Corp')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(screen.getByLabelText(/^description/i)).toBeDisabled();
  });
});

describe('Publisher page — listings', () => {
  it('shows versions with paused markers and open requests; pauses at once', async () => {
    render(<PublisherPage />);
    await screen.findByText('Acme Corp');
    tab(/listings/i);
    const row = await screen.findByTestId('listing-eslint');
    expect(within(row).getByText('1 open request')).toBeInTheDocument();
    expect(within(screen.getByTestId('version-eslint-0.9.0')).getByText('Paused')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Pause eslint v1.0.0' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(api.pauseListing).toHaveBeenCalledWith('l1', '1.0.0'));
  });

  it('requests an unpause and a yank', async () => {
    render(<PublisherPage />);
    await screen.findByText('Acme Corp');
    tab(/listings/i);
    fireEvent.click(await screen.findByRole('button', { name: 'Request unpause of eslint v0.9.0' }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit request' }));
    await waitFor(() => expect(api.submitPublishRequest).toHaveBeenCalledWith({ kind: 'unpause', listingId: 'l1', version: '0.9.0' }));

    fireEvent.click(screen.getByRole('button', { name: 'Request yank of eslint v1.0.0' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Submit request' })).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/reason/i), { target: { value: 'Critical CVE' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Submit request' }));
    await waitFor(() => expect(api.submitPublishRequest).toHaveBeenCalledWith({ kind: 'yank', listingId: 'l1', version: '1.0.0', reason: 'Critical CVE' }));
  });

  it('requests a listing update pre-filled from the listing, and a transfer', async () => {
    render(<PublisherPage />);
    await screen.findByText('Acme Corp');
    tab(/listings/i);
    fireEvent.click(await screen.findByRole('button', { name: 'Request an update of eslint' }));
    expect(within(screen.getByTestId('catalog-field-summary')).getByText('Lint JS')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Submit update request' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Summary' }));
    fireEvent.change(screen.getByLabelText('New summary'), { target: { value: 'Lint JavaScript fast' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit update request' }));
    await waitFor(() => expect(api.submitPublishRequest).toHaveBeenCalledWith({ kind: 'listing_update', listingId: 'l1', metadata: { summary: 'Lint JavaScript fast' } }));

    fireEvent.click(screen.getByRole('button', { name: 'Request transfer of eslint' }));
    fireEvent.change(screen.getByLabelText(/receiving publisher handle/i), { target: { value: 'other' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit request' }));
    await waitFor(() => expect(api.submitPublishRequest).toHaveBeenCalledWith({ kind: 'transfer', listingId: 'l1', target: { targetPublisherHandle: 'other' } }));
  });
});

describe('Publisher page — publish and requests', () => {
  it('offers only the org’s own public plugin versions', async () => {
    routerQuery = { tab: 'publish' };
    render(<PublisherPage />);
    const select = await screen.findByLabelText(/plugin version/i);
    await waitFor(() => expect(within(select).getByRole('option', { name: 'eslint v1.1.0' })).toBeInTheDocument());
    expect(within(select).queryByRole('option', { name: /secret/ })).not.toBeInTheDocument();
    expect(within(select).queryByRole('option', { name: /trivy/ })).not.toBeInTheDocument();
  });

  it('asks the server for the org\'s public versions by name, and says when the page is truncated', async () => {
    routerQuery = { tab: 'publish' };
    api.listPlugins.mockResolvedValue({ success: true, data: {
      plugins: [{ id: 'p1', orgId: 'org-1', name: 'eslint', version: '1.1.0', visibility: 'public' }],
      pagination: { total: 120, limit: 50, offset: 0, hasMore: true },
    } });
    render(<PublisherPage />);
    await waitFor(() => expect(api.listPlugins).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'org-1', visibility: 'public', includeTotal: 'true' }), expect.anything(),
    ));
    expect(await screen.findByText(/showing the first 1 of 120 matches/i)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/find a plugin/i), { target: { value: 'esl' } });
    await waitFor(() => expect(api.listPlugins).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'esl' }), expect.anything()));
  });

  it('the Advisories tab asks for plugins:read rather than failing on it', async () => {
    routerQuery = { tab: 'advisories' };
    mockAuthGuard({ can: (p) => p === 'publishers:manage' });
    render(<PublisherPage />);
    expect(await screen.findByText(/needs the plugins:read permission/i)).toBeInTheDocument();
    expect(api.listPublisherAdvisories).not.toHaveBeenCalled();
  });

  it('a deep link opens the draft for that plugin', async () => {
    routerQuery = { tab: 'publish', pluginId: 'p1' };
    api.getPublishDraft.mockReturnValue(new Promise(() => {}));
    render(<PublisherPage />);
    await waitFor(() => expect(api.getPublishDraft).toHaveBeenCalledWith('p1', expect.anything()));
  });

  it('asks for the terms before the publish form', async () => {
    routerQuery = { tab: 'publish' };
    api.getPublisher.mockResolvedValue({ success: true, data: ctx({ terms: { currentVersion: '2026-09', accepted: false } }) });
    render(<PublisherPage />);
    expect(await screen.findByText(/accept the current publisher terms on the profile tab/i)).toBeInTheDocument();
  });

  it('pages the request list with the server cursor, and reads every page of incoming transfers', async () => {
    routerQuery = { tab: 'requests' };
    api.listPublishRequests
      .mockResolvedValueOnce({ success: true, data: { requests: [request()], nextCursor: 'c1' } })
      .mockResolvedValueOnce({ success: true, data: { requests: [request({ id: 'r9', kind: 'yank', status: 'rejected' })], nextCursor: null } });
    api.listIncomingTransfers
      .mockResolvedValueOnce({ success: true, data: { requests: [], nextCursor: 't1' } })
      .mockResolvedValueOnce({ success: true, data: { requests: [], nextCursor: null } });
    render(<PublisherPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(api.listPublishRequests).toHaveBeenLastCalledWith({ cursor: 'c1' }));
    expect(await screen.findByTestId('request-r9')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
    await waitFor(() => expect(api.listIncomingTransfers).toHaveBeenLastCalledWith({ cursor: 't1' }, expect.anything()));
  });

  it('lists requests with their reason and withdraws an open one', async () => {
    routerQuery = { tab: 'requests' };
    api.listPublishRequests.mockResolvedValue({ success: true, data: { requests: [
      request(),
      request({ id: 'r2', kind: 'yank', status: 'rejected', reason: 'Not a security issue' }),
    ] } });
    render(<PublisherPage />);
    expect(await screen.findByText('Reason: Not a security issue')).toBeInTheDocument();
    expect(within(screen.getByTestId('request-r2')).queryByRole('button', { name: /withdraw/i })).not.toBeInTheDocument();
    fireEvent.click(within(screen.getByTestId('request-r1')).getByRole('button', { name: /withdraw/i }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Withdraw' }));
    await waitFor(() => expect(api.withdrawPublishRequest).toHaveBeenCalledWith('r1'));
    expect(pageToast.success).toHaveBeenCalledWith('Request withdrawn');
  });

  it('accepts an incoming transfer through step-up', async () => {
    routerQuery = { tab: 'requests' };
    api.listIncomingTransfers.mockResolvedValue({ success: true, data: { requests: [
      request({ id: 't1', kind: 'transfer', publisherHandle: 'other', listingName: 'lint-x', payload: { transfer: { targetPublisherId: 'pub1', targetOrgId: 'org-1', response: 'pending' } } }),
    ] } });
    render(<PublisherPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }));
    fireEvent.click(screen.getByRole('button', { name: 'Verify step-up' }));
    await waitFor(() => expect(api.respondToTransfer).toHaveBeenCalledWith('t1', true, 'step-tok'));
  });

  it('filters requests by status', async () => {
    routerQuery = { tab: 'requests' };
    render(<PublisherPage />);
    await screen.findByTestId('request-r1');
    fireEvent.click(screen.getByRole('button', { name: 'Rejected' }));
    await waitFor(() => expect(api.listPublishRequests).toHaveBeenLastCalledWith({ status: 'rejected' }, expect.anything()));
  });
});

describe('Publisher page — insights (W7)', () => {
  const trend = Array.from({ length: 12 }, (_, i) => ({ month: `2026-${String(i + 1).padStart(2, '0')}`, average: i === 11 ? 4.5 : null, count: i === 11 ? 2 : 0 }));
  const insight = (over: Record<string, unknown> = {}) => ({
    listingId: 'l1', name: 'eslint', state: 'listed', paused: false, latestVersion: '1.0.0', installCount: 12,
    activeOrgs: { count: null, label: '<5' }, successRate30d: 0.95, healthScore: 86,
    healthBreakdown: { runtime: { score: 0.95, weight: 25 }, rating: { score: null, weight: 10 }, docs: { score: 1, weight: 10 } },
    rating: { score: 4.5, count: 2 }, ratingTrend: trend, openReviewReports: 1, openAdvisories: 0, statsUpdatedAt: null, ...over,
  });

  it('shows per-listing installs, k-anonymous orgs, success rate, reports and health with a breakdown', async () => {
    api.getPublisherInsights.mockResolvedValue({ success: true, data: {
      publisher: { handle: 'acme', displayName: 'Acme Corp', tier: 'community', healthScore: 86, successRate30d: 0.95 },
      listings: [insight(), insight({ listingId: 'l2', name: 'fmt', activeOrgs: { count: 7, label: '7' }, healthScore: null, healthBreakdown: null })],
    } });
    render(<PublisherPage />);
    await screen.findByText('Acme Corp');
    tab(/insights/i);
    const row = (await screen.findByText('eslint')).closest('tr')!;
    expect(within(row).getByText('<5')).toBeInTheDocument();
    expect(within(row).getByText('(fewer than five)')).toBeInTheDocument();
    expect(within(row).getAllByText('95%').length).toBeGreaterThan(0);
    expect(within(row).getByText('Health 86')).toBeInTheDocument();
    expect(within(screen.getByText('fmt').closest('tr')!).getByText('7')).toBeInTheDocument();
    expect(within(row).getByText(/2026-12: 4.5 stars from 2 reviews/)).toBeInTheDocument();

    const details = within(row).getByRole('button', { name: 'Details for eslint' });
    expect(details).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(details);
    const panel = await screen.findByTestId('health-breakdown');
    expect(within(panel).getByText('Runtime success (30 days)')).toBeInTheDocument();
    expect(within(panel).getByText(/Fewer than 3 ratings — not counted/)).toBeInTheDocument();
    // Weights renormalized over the known signals: runtime 25 of 35.
    expect(within(panel).getByText('71%')).toBeInTheDocument();
  });

  it('is empty without listings', async () => {
    api.getPublisherInsights.mockResolvedValue({ success: true, data: { publisher: null, listings: [] } });
    render(<PublisherPage />);
    await screen.findByText('Acme Corp');
    tab(/insights/i);
    expect(await screen.findByText('No listings yet')).toBeInTheDocument();
  });
});
