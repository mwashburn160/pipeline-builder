// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Security advisories and version deprecation:
 *  - the plugin page's advisory banner (severity order, CVEs, sanitized details)
 *    and the per-version advisory marker;
 *  - the publisher submits an advisory REQUEST and deprecates a version;
 *  - the console publishes a draft by approving its request, discards it by
 *    rejecting it, edits it, creates one, withdraws a published one and
 *    deprecates / clears a version — step-up tokens forwarded;
 *  - install rows show their advisories (red when blocking) and warnings;
 *  - the API domain's paths and bodies.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { ApiCore } from '../src/lib/api/core';
import { pageToast } from './helpers/pageMocks';
import { detail } from './helpers/publicDirectoryFixtures';
import { catalogEntry, installView } from './helpers/pluginInstallFixtures';

jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());
jest.mock('@/components/admin/StepUpModal', () => ({
  __esModule: true,
  StepUpModal: ({ title, details, onConfirmed, onClose }: {
    title?: string; details?: ReactNode; onConfirmed: (t: string) => Promise<void>; onClose: () => void;
  }) => (
    <div data-testid="step-up">
      <p>{title}</p>
      {details}
      <button onClick={() => { void onConfirmed('step-tok').then(onClose, () => {}); }}>Verify step-up</button>
    </div>
  ),
}));
jest.mock('@/hooks/useDebounce', () => ({ __esModule: true, useDebounce: <T,>(v: T) => v }));
jest.mock('next/router', () => require('./helpers/pageMocks').routerModule(() => ({ isReady: true, query: {}, replace: jest.fn(), push: jest.fn() })));

const api = {
  listPublisherAdvisories: jest.fn<AnyFn>(),
  listPublisherListings: jest.fn<AnyFn>(),
  submitPublishRequest: jest.fn<AnyFn>(),
  withdrawPublishRequest: jest.fn<AnyFn>(),
  deprecateListingVersion: jest.fn<AnyFn>(),
  pauseListing: jest.fn<AnyFn>(),
  listEcosystemAdvisories: jest.fn<AnyFn>(),
  listEcosystemListings: jest.fn<AnyFn>(),
  createEcosystemAdvisory: jest.fn<AnyFn>(),
  updateEcosystemAdvisory: jest.fn<AnyFn>(),
  withdrawEcosystemAdvisory: jest.fn<AnyFn>(),
  approveEcosystemRequest: jest.fn<AnyFn>(),
  rejectEcosystemRequest: jest.fn<AnyFn>(),
  setListingVersionDeprecation: jest.fn<AnyFn>(),
  listPluginInstalls: jest.fn<AnyFn>(),
  getPluginCatalog: jest.fn<AnyFn>(),
  getListingInstallState: jest.fn<AnyFn>(),
};
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: new Proxy({}, {
    get: (_t, key: string) => (...a: unknown[]) => (api as Record<string, AnyFn>)[key](...a),
  }),
}));

import { AdvisoryBanner, VersionAdvisoryMarker } from '../src/components/public-directory/AdvisoryBanner';
import { VersionsPanel } from '../src/components/public-directory/ListingTabs';
import { PublisherAdvisoriesPanel } from '../src/components/publisher/PublisherAdvisoriesPanel';
import { PublisherListingsPanel } from '../src/components/publisher/PublisherListingsPanel';
import { AdvisoriesPanel } from '../src/components/ecosystem/AdvisoriesPanel';
import { ListingStatePanel } from '../src/components/ecosystem/ListingStatePanel';
import { InstallsTab } from '../src/components/plugin-installs/InstallsTab';
import { CatalogTab } from '../src/components/plugin-installs/CatalogTab';
import { InstallWarnings } from '../src/components/plugin-installs/InstallWarnings';
import { ecosystemApi } from '../src/lib/api/domains/ecosystem';
import { parseCveIds, severityColor, severityLabel, sortBySeverity } from '../src/lib/advisories';
import type { ListingAdvisory } from '../src/lib/public-directory/types';

const ok = (data: unknown) => Promise.resolve({ success: true, statusCode: 200, data });

const pubAdvisory = (over: Partial<ListingAdvisory> = {}): ListingAdvisory => ({
  id: 'PBSA-1', severity: 'high', summary: 'Token leak in logs', affectedRange: '>=1.0.0 <1.4.2', fixedVersion: '1.4.2',
  publishedAt: '2026-09-20', detailsHtml: null, cveIds: [], ...over,
});

const advisoryView = (over: Record<string, unknown> = {}) => ({
  id: 'a1', listingId: 'l1', listingName: 'eslint', publisherHandle: 'acme', affectedRange: '<1.1.0', fixedVersion: '1.1.0',
  severity: 'critical', summary: 'RCE via config', detailsMd: '# Details', detailsHtml: '<h1>Details</h1>', cveIds: ['CVE-2026-1111'],
  state: 'draft', source: 'publisher', createdBy: 'u1', publishedAt: null, withdrawnAt: null, createdAt: '2026-09-20',
  updatedAt: '2026-09-20', requestId: 'req-1', affectedVersions: ['1.0.0'], ...over,
});

const versionView = (over: Record<string, unknown> = {}) => ({
  id: 'v1', version: '1.0.0', imageDigest: null, imageRepository: null, breaking: false, pausedAt: null, yankedAt: null,
  yankReason: null, vulnCritical: 0, vulnHigh: 0, publishedAt: '2026-01-01', changelog: null, deprecatedAt: null,
  deprecationMessage: null, ...over,
});

const listingView = (over: Record<string, unknown> = {}) => ({
  id: 'l1', publisherId: 'pub1', publisherHandle: 'acme', publisherTier: 'community', name: 'eslint', category: 'quality',
  summary: 'Lint JS', description: null, license: 'MIT', homepageUrl: null, sourceUrl: null, icon: null, keywords: [],
  state: 'listed', pausedAt: null, featured: false, latestVersion: '1.0.0', createdAt: '2026-01-01', updatedAt: '2026-01-01',
  versions: [versionView(), versionView({ id: 'v0', version: '0.9.0', deprecatedAt: '2026-02-01', deprecationMessage: 'Use 1.x' })],
  ...over,
});

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  for (const fn of Object.values(pageToast)) fn.mockReset();
});

// ---------------------------------------------------------------------------
// Public plugin page
// ---------------------------------------------------------------------------

describe('AdvisoryBanner', () => {
  it('renders nothing without advisories', () => {
    const { container } = render(<AdvisoryBanner advisories={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('lists advisories most severe first with range, fix, CVEs and sanitized details', () => {
    render(<AdvisoryBanner advisories={[
      pubAdvisory({ id: 'PBSA-2', severity: 'low', summary: 'Verbose output', fixedVersion: null }),
      pubAdvisory({ id: 'PBSA-1', severity: 'critical', cveIds: ['CVE-2026-0001', 'CVE-2026-0002'], detailsHtml: '<p>Rotate <strong>tokens</strong></p>' }),
    ]} />);
    expect(screen.getByText('Active security advisory')).toBeInTheDocument();
    const items = within(screen.getByTestId('advisory-banner')).getAllByRole('listitem').filter((li) => li.dataset.testid?.startsWith('advisory-'));
    expect(items.map((li) => li.dataset.testid)).toEqual(['advisory-PBSA-1', 'advisory-PBSA-2']);
    const first = screen.getByTestId('advisory-PBSA-1');
    expect(within(first).getByText('Critical')).toBeInTheDocument();
    expect(within(first).getByText('Token leak in logs')).toBeInTheDocument();
    expect(within(first).getByText('>=1.0.0 <1.4.2')).toBeInTheDocument();
    expect(within(first).getByText('1.4.2')).toBeInTheDocument();
    expect(within(first).getByText('CVE-2026-0001')).toBeInTheDocument();
    expect(within(first).getByText('CVE-2026-0002')).toBeInTheDocument();
    expect(within(first).getByTestId('advisory-details').querySelector('strong')).toHaveTextContent('tokens');
    expect(within(screen.getByTestId('advisory-PBSA-2')).getByText(/no fix yet/)).toBeInTheDocument();
    expect(within(screen.getByTestId('advisory-PBSA-2')).queryByTestId('advisory-details')).toBeNull();
  });
});

describe('Versions tab markers', () => {
  it('marks versions covered by an advisory, with deprecated and yanked markers', () => {
    const listing = detail({
      advisories: [pubAdvisory({ id: 'PBSA-1', severity: 'critical' }), pubAdvisory({ id: 'PBSA-3', severity: 'medium' })],
      versions: [
        { ...detail().versions[0], version: '1.4.1', advisoryIds: ['PBSA-3', 'PBSA-1'] },
        { ...detail().versions[0], version: '1.4.2', advisoryIds: [], deprecated: true, deprecationMessage: 'Move to 2.x' },
        { ...detail().versions[0], version: '1.0.0', advisoryIds: [], yanked: true },
      ],
    });
    render(<VersionsPanel listing={listing} />);
    const markers = screen.getAllByTestId('version-advisory');
    expect(markers).toHaveLength(1);
    expect(markers[0]).toHaveTextContent('Critical advisory (+1)');
    expect(markers[0]).toHaveAttribute('title', expect.stringContaining('PBSA-1: Token leak in logs'));
    expect(screen.getByText('Deprecated')).toBeInTheDocument();
    expect(screen.getByText('Move to 2.x')).toBeInTheDocument();
    expect(screen.getByText('Yanked')).toBeInTheDocument();
  });

  it('falls back to a plain marker when the advisory is not in the list', () => {
    render(<VersionAdvisoryMarker advisoryIds={['PBSA-9']} advisories={[]} />);
    expect(screen.getByTestId('version-advisory')).toHaveTextContent('Advisory');
  });
});

// ---------------------------------------------------------------------------
// Publisher page
// ---------------------------------------------------------------------------

describe('PublisherAdvisoriesPanel', () => {
  beforeEach(() => {
    api.listPublisherAdvisories.mockReturnValue(ok({ advisories: [
      advisoryView(),
      advisoryView({ id: 'a2', state: 'published', source: 'cve_rescan', requestId: null, publishedAt: '2026-09-20' }),
    ] }));
    api.listPublisherListings.mockReturnValue(ok({ listings: [listingView()] }));
    api.submitPublishRequest.mockReturnValue(ok({ request: {}, autoApproved: false }));
    api.withdrawPublishRequest.mockReturnValue(ok({ request: {} }));
  });

  it('lists advisories with state badges and marks drafts private', async () => {
    render(<PublisherAdvisoriesPanel canManage />);
    const draft = await screen.findByTestId('advisory-a1');
    expect(within(draft).getByText('Draft')).toBeInTheDocument();
    expect(within(draft).getByText(/Private draft — not public/)).toBeInTheDocument();
    const published = screen.getByTestId('advisory-a2');
    expect(within(published).getByText('Published')).toBeInTheDocument();
    expect(within(published).getByText('CVE rescan')).toBeInTheDocument();
    expect(within(published).queryByText(/Private draft/)).toBeNull();
  });

  it('submits an advisory request with the parsed fields', async () => {
    render(<PublisherAdvisoriesPanel canManage />);
    await screen.findByTestId('advisory-a1');
    fireEvent.click(screen.getByRole('button', { name: /submit advisory/i }));
    await waitFor(() => expect(screen.getByRole('option', { name: 'eslint' })).toBeInTheDocument());
    const submit = screen.getByRole('button', { name: 'Submit request' });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/^listing/i), { target: { value: 'l1' } });
    fireEvent.change(screen.getByLabelText(/^affected versions/i), { target: { value: ' >=1.0.0 <1.4.2 ' } });
    fireEvent.change(screen.getByLabelText(/^severity/i), { target: { value: 'critical' } });
    fireEvent.change(screen.getByLabelText(/^summary/i), { target: { value: 'Token leak' } });
    fireEvent.change(screen.getByLabelText(/^details/i), { target: { value: '## Impact' } });
    fireEvent.change(screen.getByLabelText(/^cve ids/i), { target: { value: 'cve-2026-1, CVE-2026-2 cve-2026-1' } });
    fireEvent.change(screen.getByLabelText(/^fixed version/i), { target: { value: '1.4.2' } });
    fireEvent.click(submit);
    await waitFor(() => expect(api.submitPublishRequest).toHaveBeenCalledWith({
      kind: 'advisory',
      listingId: 'l1',
      advisory: {
        affectedRange: '>=1.0.0 <1.4.2', severity: 'critical', summary: 'Token leak', detailsMd: '## Impact',
        fixedVersion: '1.4.2', cveIds: ['CVE-2026-1', 'CVE-2026-2'],
      },
    }));
    expect(pageToast.success).toHaveBeenCalled();
  });

  it('omits empty optional fields and shows a validation error from the server', async () => {
    api.submitPublishRequest.mockRejectedValue(new Error('Listing is paused'));
    render(<PublisherAdvisoriesPanel canManage />);
    await screen.findByTestId('advisory-a1');
    fireEvent.click(screen.getByRole('button', { name: /submit advisory/i }));
    await waitFor(() => expect(screen.getByRole('option', { name: 'eslint' })).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/^listing/i), { target: { value: 'l1' } });
    fireEvent.change(screen.getByLabelText(/^affected versions/i), { target: { value: '<2.0.0' } });
    fireEvent.change(screen.getByLabelText(/^summary/i), { target: { value: 'Bad' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit request' }));
    expect(await screen.findByText('Listing is paused')).toBeInTheDocument();
    expect(api.submitPublishRequest).toHaveBeenCalledWith({
      kind: 'advisory', listingId: 'l1', advisory: { affectedRange: '<2.0.0', severity: 'high', summary: 'Bad' },
    });
    // The form kept every value for the retry.
    expect(screen.getByLabelText(/^summary/i)).toHaveValue('Bad');
  });

  it('refuses a malformed range, fixed version or CVE id in the form, before anything is sent', async () => {
    render(<PublisherAdvisoriesPanel canManage />);
    await screen.findByTestId('advisory-a1');
    fireEvent.click(screen.getByRole('button', { name: /submit advisory/i }));
    await waitFor(() => expect(screen.getByRole('option', { name: 'eslint' })).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/^listing/i), { target: { value: 'l1' } });
    fireEvent.change(screen.getByLabelText(/^summary/i), { target: { value: 'Bad' } });
    fireEvent.change(screen.getByLabelText(/^affected versions/i), { target: { value: 'nope' } });
    expect(await screen.findByText(/"nope" is not a version/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Submit request' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/^affected versions/i), { target: { value: '>=1.0.0 <1.4.2' } });
    fireEvent.change(screen.getByLabelText(/^fixed version/i), { target: { value: 'soon' } });
    expect(screen.getByText(/must be a semver version/i)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/^fixed version/i), { target: { value: '1.4.2' } });
    fireEvent.change(screen.getByLabelText(/^cve ids/i), { target: { value: 'CVE-2026-1234, !!' } });
    expect(screen.getByText(/is not a vulnerability id/)).toBeInTheDocument();
    expect(api.submitPublishRequest).not.toHaveBeenCalled();
  });

  it('refuses an over-long summary', async () => {
    render(<PublisherAdvisoriesPanel canManage />);
    await screen.findByTestId('advisory-a1');
    fireEvent.click(screen.getByRole('button', { name: /submit advisory/i }));
    await waitFor(() => expect(screen.getByRole('option', { name: 'eslint' })).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/^listing/i), { target: { value: 'l1' } });
    fireEvent.change(screen.getByLabelText(/^affected versions/i), { target: { value: '<2' } });
    fireEvent.change(screen.getByLabelText(/^summary/i), { target: { value: 'x'.repeat(301) } });
    expect(screen.getByText('At most 300 characters.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Submit request' })).toBeDisabled();
  });

  it('withdraws a draft request', async () => {
    render(<PublisherAdvisoriesPanel canManage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Withdraw the advisory request for eslint' }));
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw' }));
    await waitFor(() => expect(api.withdrawPublishRequest).toHaveBeenCalledWith('req-1'));
  });

  it('hides the write controls without publishers:manage', async () => {
    render(<PublisherAdvisoriesPanel canManage={false} />);
    await screen.findByTestId('advisory-a1');
    expect(screen.queryByRole('button', { name: /submit advisory/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /withdraw the advisory request/i })).toBeNull();
  });
});

describe('PublisherListingsPanel — deprecate', () => {
  beforeEach(() => {
    api.listPublisherListings.mockReturnValue(ok({ listings: [listingView()] }));
    api.deprecateListingVersion.mockReturnValue(ok({ listing: listingView() }));
  });

  it('shows deprecated versions and deprecates one with a required message', async () => {
    render(<PublisherListingsPanel canPublish canManage />);
    const old = await screen.findByTestId('version-eslint-0.9.0');
    expect(within(old).getByText('Deprecated')).toBeInTheDocument();
    expect(within(old).getByText('Use 1.x')).toBeInTheDocument();
    expect(within(old).queryByRole('button', { name: /deprecate/i })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Deprecate eslint v1.0.0' }));
    const confirm = screen.getByRole('button', { name: 'Deprecate' });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/^deprecation message/i), { target: { value: ' Upgrade to 2.0 ' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(api.deprecateListingVersion).toHaveBeenCalledWith('l1', '1.0.0', 'Upgrade to 2.0'));
    expect(pageToast.success).toHaveBeenCalledWith('Deprecated eslint v1.0.0');
  });

  it('refuses a message over 500 characters', async () => {
    render(<PublisherListingsPanel canPublish canManage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Deprecate eslint v1.0.0' }));
    fireEvent.change(screen.getByLabelText(/^deprecation message/i), { target: { value: 'x'.repeat(501) } });
    fireEvent.click(screen.getByRole('button', { name: 'Deprecate' }));
    expect(await screen.findByText(/at most 500 characters/)).toBeInTheDocument();
    expect(api.deprecateListingVersion).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Ecosystem console
// ---------------------------------------------------------------------------

describe('AdvisoriesPanel (console)', () => {
  const can = (p: string) => p === 'plugins:moderate';

  beforeEach(() => {
    api.listEcosystemAdvisories.mockImplementation((params: { state: string }) => ok({ advisories: params.state === 'published'
      ? [advisoryView({ id: 'a2', state: 'published', requestId: null, source: 'moderator' })]
      : [advisoryView({ source: 'cve_rescan' }), advisoryView({ id: 'a3', listingName: 'jest', source: 'review', requestId: null })] }));
    api.listEcosystemListings.mockReturnValue(ok({ listings: [listingView()] }));
    api.approveEcosystemRequest.mockReturnValue(ok({ request: {} }));
    api.rejectEcosystemRequest.mockReturnValue(ok({ request: {} }));
    api.withdrawEcosystemAdvisory.mockReturnValue(ok({ advisory: {} }));
    api.updateEcosystemAdvisory.mockReturnValue(ok({ advisory: {} }));
    api.createEcosystemAdvisory.mockReturnValue(ok({ advisory: {}, request: {} }));
  });

  it('lists drafts with source badges; a draft without a request cannot be published', async () => {
    render(<AdvisoriesPanel can={can} />);
    const draft = await screen.findByTestId('eco-advisory-a1');
    expect(within(draft).getByText('CVE rescan')).toBeInTheDocument();
    expect(within(screen.getByTestId('eco-advisory-a3')).getByText('Review')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish the advisory for jest' })).toBeDisabled();
    expect(api.listEcosystemAdvisories).toHaveBeenCalledWith({ state: 'draft' }, expect.anything());
  });

  it('publishes a draft by approving its request through step-up', async () => {
    render(<AdvisoriesPanel can={can} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Publish the advisory for eslint' }));
    fireEvent.click(screen.getByRole('button', { name: 'Verify step-up' }));
    await waitFor(() => expect(api.approveEcosystemRequest).toHaveBeenCalledWith('req-1', undefined, 'step-tok'));
  });

  it('discards a draft by rejecting its request with a reason', async () => {
    render(<AdvisoriesPanel can={can} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Discard the draft for eslint' }));
    fireEvent.change(screen.getByLabelText(/^reason/i), { target: { value: 'Duplicate' } });
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(api.rejectEcosystemRequest).toHaveBeenCalledWith('req-1', 'Duplicate'));
  });

  it('withdraws a published advisory with the reason', async () => {
    render(<AdvisoriesPanel can={can} />);
    await screen.findByTestId('eco-advisory-a1');
    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'published' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Withdraw the advisory for eslint' }));
    fireEvent.change(screen.getByLabelText(/^reason/i), { target: { value: 'False positive' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify step-up' }));
    await waitFor(() => expect(api.withdrawEcosystemAdvisory).toHaveBeenCalledWith('a2', 'False positive', 'step-tok'));
  });

  it('edits a draft (PATCH with every field, empties cleared)', async () => {
    render(<AdvisoriesPanel can={can} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit the draft for eslint' }));
    expect(screen.getByLabelText(/^details/i)).toHaveValue('# Details');
    fireEvent.change(screen.getByLabelText(/^summary/i), { target: { value: 'RCE via crafted config' } });
    fireEvent.change(screen.getByLabelText(/^fixed version/i), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Verify step-up' }));
    await waitFor(() => expect(api.updateEcosystemAdvisory).toHaveBeenCalledWith('a1', {
      affectedRange: '<1.1.0', severity: 'critical', summary: 'RCE via crafted config', detailsMd: '# Details',
      fixedVersion: null, cveIds: ['CVE-2026-1111'],
    }, 'step-tok'));
  });

  it('creates a moderator draft', async () => {
    render(<AdvisoriesPanel can={can} />);
    fireEvent.click(await screen.findByRole('button', { name: /new draft/i }));
    await waitFor(() => expect(screen.getByRole('option', { name: 'acme/eslint' })).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/^listing/i), { target: { value: 'l1' } });
    fireEvent.change(screen.getByLabelText(/^affected versions/i), { target: { value: '<1.1.0' } });
    fireEvent.change(screen.getByLabelText(/^summary/i), { target: { value: 'Leak' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Verify step-up' }));
    await waitFor(() => expect(api.createEcosystemAdvisory).toHaveBeenCalledWith(
      { listingId: 'l1', affectedRange: '<1.1.0', severity: 'high', summary: 'Leak' }, 'step-tok',
    ));
  });

  it('a refused create returns to the FILLED draft form with the server\'s reason', async () => {
    api.createEcosystemAdvisory.mockRejectedValueOnce(new Error('fixedVersion 1.0.5 is inside the affected range <1.1.0'));
    render(<AdvisoriesPanel can={can} />);
    fireEvent.click(await screen.findByRole('button', { name: /new draft/i }));
    await waitFor(() => expect(screen.getByRole('option', { name: 'acme/eslint' })).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/^listing/i), { target: { value: 'l1' } });
    fireEvent.change(screen.getByLabelText(/^affected versions/i), { target: { value: '<1.1.0' } });
    fireEvent.change(screen.getByLabelText(/^summary/i), { target: { value: 'Leak' } });
    fireEvent.change(screen.getByLabelText(/^fixed version/i), { target: { value: '1.0.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Verify step-up' }));

    expect(await screen.findByText(/is inside the affected range/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^summary/i)).toHaveValue('Leak');
    expect(screen.getByLabelText(/^affected versions/i)).toHaveValue('<1.1.0');
    expect(screen.getByLabelText(/^fixed version/i)).toHaveValue('1.0.5');
  });

  it('shows no write controls without plugins:moderate', async () => {
    render(<AdvisoriesPanel can={() => false} />);
    await screen.findByTestId('eco-advisory-a1');
    expect(screen.queryByRole('button', { name: /publish the advisory/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /new draft/i })).toBeNull();
  });
});

describe('ListingStatePanel — deprecation', () => {
  beforeEach(() => {
    api.listEcosystemListings.mockReturnValue(ok({ listings: [listingView()] }));
    api.setListingVersionDeprecation.mockReturnValue(ok({ listing: listingView() }));
  });

  it('deprecates a version with an optional message and clears a deprecation', async () => {
    render(<ListingStatePanel can={(p) => p === 'plugins:moderate'} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Deprecate eslint v1.0.0' }));
    fireEvent.change(screen.getByLabelText(/^deprecation message/i), { target: { value: 'Use 2.x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify step-up' }));
    await waitFor(() => expect(api.setListingVersionDeprecation).toHaveBeenCalledWith('l1', '1.0.0', { message: 'Use 2.x' }, 'step-tok'));

    fireEvent.click(await screen.findByRole('button', { name: 'Clear the deprecation of eslint v0.9.0' }));
    expect(screen.getByText(/Current message: Use 1.x/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Verify step-up' }));
    await waitFor(() => expect(api.setListingVersionDeprecation).toHaveBeenCalledWith('l1', '0.9.0', { deprecated: false }, 'step-tok'));
  });
});

// ---------------------------------------------------------------------------
// Installs
// ---------------------------------------------------------------------------

describe('Install warnings', () => {
  it('renders nothing without warnings or advisories', () => {
    const { container } = render(<InstallWarnings install={{ warnings: [], advisories: [] }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows advisories (blocking in red) and non-advisory warnings on install rows', async () => {
    api.listPluginInstalls.mockReturnValue(ok({ installs: [installView({
      advisories: [
        { id: 'x1', severity: 'medium', summary: 'Minor leak', fixedVersion: null, blocking: false },
        { id: 'x2', severity: 'critical', summary: 'RCE', fixedVersion: '1.3.0', blocking: true },
      ],
      warnings: [
        { code: 'PLUGIN_ADVISORY', message: 'This version has an advisory' },
        { code: 'PLUGIN_DEPRECATED', message: 'v1.2.0 is deprecated: use 2.x' },
      ],
    })], policy: {} }));
    render(<InstallsTab canInstall usage={{}} />);
    const row = await screen.findByTestId('install-row');
    const blocking = within(row).getByTestId('install-advisory-blocking');
    expect(blocking).toHaveClass('text-danger-strong');
    expect(blocking).toHaveTextContent('Blocked by advisory');
    expect(blocking).toHaveTextContent('RCE');
    expect(blocking).toHaveTextContent('fixed in v1.3.0');
    expect(within(row).getByTestId('install-advisory')).toHaveTextContent('Medium advisory');
    expect(within(row).getByTestId('install-warning-PLUGIN_DEPRECATED')).toHaveTextContent('v1.2.0 is deprecated: use 2.x');
    expect(within(row).queryByTestId('install-warning-PLUGIN_ADVISORY')).toBeNull();
  });

  it('keeps the advisory warning when no advisory detail came back', () => {
    render(<InstallWarnings install={{ warnings: [{ code: 'PLUGIN_ADVISORY', message: 'Advisory PBSA-1' }], advisories: [] }} />);
    expect(screen.getByTestId('install-warning-PLUGIN_ADVISORY')).toHaveTextContent('Advisory PBSA-1');
  });

  it('shows an installed catalog entry’s warnings', async () => {
    api.getPluginCatalog.mockReturnValue(ok({ listings: [catalogEntry({
      install: installView({ warnings: [{ code: 'LISTING_UNMAINTAINED', message: 'Unmaintained listing' }] }),
      installable: false,
    })] }));
    render(<CatalogTab canInstall usage={{}} />);
    const card = await screen.findByTestId('catalog-card');
    expect(within(card).getByTestId('install-warning-LISTING_UNMAINTAINED')).toHaveTextContent('Unmaintained listing');
  });
});

// ---------------------------------------------------------------------------
// Helpers and API domain
// ---------------------------------------------------------------------------

describe('advisory helpers', () => {
  it('parses, orders and labels', () => {
    expect(parseCveIds(' cve-1,CVE-2  cve-1\n')).toEqual(['CVE-1', 'CVE-2']);
    expect(parseCveIds('')).toEqual([]);
    expect(sortBySeverity([{ severity: 'low' }, { severity: 'weird' }, { severity: 'CRITICAL' }]).map((a) => a.severity))
      .toEqual(['CRITICAL', 'low', 'weird']);
    expect(severityColor('high')).toBe('red');
    expect(severityColor('medium')).toBe('yellow');
    expect(severityColor('low')).toBe('gray');
    expect(severityLabel('weird')).toBe('weird');
  });
});

describe('ecosystem API — advisories and deprecation', () => {
  it('hits the contract paths with the right bodies and step-up header', async () => {
    const calls: Array<{ path: string; init: RequestInit }> = [];
    const core = {
      request: jest.fn<AnyFn>((path: string, init: RequestInit = {}) => { calls.push({ path, init }); return ok({}); }),
      stepUpHeader: (t?: string) => (t ? { 'X-Step-Up-Token': t } : {}),
    } as unknown as ApiCore;
    const e = ecosystemApi(core);
    const body = (i: number) => JSON.parse(String(calls[i].init.body));

    await e.listPublisherAdvisories();
    await e.deprecateListingVersion('l 1', '1.0.0', 'Use 2');
    await e.listEcosystemAdvisories({ state: 'draft', listingId: 'l1' });
    await e.createEcosystemAdvisory({ listingId: 'l1', affectedRange: '<2', severity: 'low', summary: 's' }, 'tok');
    await e.updateEcosystemAdvisory('a1', { summary: 't' }, 'tok');
    await e.withdrawEcosystemAdvisory('a1', 'why', 'tok');
    await e.setListingVersionDeprecation('l1', '1.0.0', { deprecated: false }, 'tok');

    expect(calls[0].path).toBe('/api/plugins/publisher/advisories');
    expect(calls[1]).toMatchObject({ path: '/api/plugins/publisher/listings/l%201/deprecate', init: { method: 'POST' } });
    expect(body(1)).toEqual({ version: '1.0.0', message: 'Use 2' });
    expect(calls[2].path).toBe('/api/plugins/ecosystem/advisories?state=draft&listingId=l1');
    expect(calls[3]).toMatchObject({ path: '/api/plugins/ecosystem/advisories', init: { method: 'POST', headers: { 'X-Step-Up-Token': 'tok' } } });
    expect(body(3)).toEqual({ listingId: 'l1', affectedRange: '<2', severity: 'low', summary: 's' });
    expect(calls[4]).toMatchObject({ path: '/api/plugins/ecosystem/advisories/a1', init: { method: 'PATCH', headers: { 'X-Step-Up-Token': 'tok' } } });
    expect(body(4)).toEqual({ summary: 't' });
    expect(calls[5]).toMatchObject({ path: '/api/plugins/ecosystem/advisories/a1/withdraw', init: { method: 'POST' } });
    expect(body(5)).toEqual({ reason: 'why' });
    expect(calls[6].path).toBe('/api/plugins/ecosystem/listings/l1/versions/1.0.0/deprecate');
    expect(body(6)).toEqual({ deprecated: false });
  });
});
