// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The publish-request form (plan §3.1a steps 3–4):
 *  - new listing: accept-or-edit fields with source badges, a live card preview
 *    that follows the edits, and only EDITED fields sent as `metadata`;
 *  - a failing gate blocks submit;
 *  - new version: the changed-fields-only offer — Keep current by default,
 *    Accept / Edit submit a SEPARATE listing_update after the version request;
 *  - the submit's error codes read as actions.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PublishRequestForm, describePublishError } from '../src/components/publisher/PublishRequestForm';
import { ApiError } from '../src/lib/api/errors';
import { pageToast } from './helpers/pageMocks';

jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());

const getPublishDraft = jest.fn<AnyFn>();
const submitPublishRequest = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getPublishDraft: (...a: unknown[]) => getPublishDraft(...a),
    submitPublishRequest: (...a: unknown[]) => submitPublishRequest(...a),
  },
}));

const publisher = {
  id: 'pub1', handle: 'acme', displayName: 'Acme', description: null, homepageUrl: null, tier: 'verified',
  verifiedAt: null, verifiedGraceUntil: null, termsVersion: '1', termsAcceptedAt: '2026-01-01', suspendedAt: null,
  suspendReason: null, ownerOrgId: 'org-1', createdAt: '2026-01-01', updatedAt: '2026-01-01',
};

const okGates = [
  { id: 'visibility', ok: true, message: 'The version is public' },
  { id: 'license', ok: true, message: 'License MIT' },
];

const newListingDraft = (gates = okGates) => ({
  kind: 'new_listing',
  plugin: {
    id: 'p1', name: 'eslint', version: '1.2.0', visibility: 'public', imageDigest: 'sha256:abc', license: 'MIT',
    hasReadme: true, signed: true, scannedAt: null, vulnCritical: 0, vulnHigh: 0, breaking: false,
  },
  listing: null,
  gates,
  metadata: [
    { field: 'displayName', value: 'ESLint', source: 'spec' },
    { field: 'summary', value: 'Lint JavaScript', source: 'readme' },
    { field: 'category', value: 'quality', source: 'spec' },
    { field: 'license', value: 'MIT', source: 'dockerfile' },
    { field: 'homepageUrl', value: 'https://eslint.org', source: 'derived' },
  ],
  listingUpdateOffer: [],
  publisher,
  listingsQuota: { used: 1, limit: 25 },
  terms: { currentVersion: '1', accepted: true },
});

const listing = {
  id: 'l1', publisherId: 'pub1', publisherHandle: 'acme', publisherTier: 'verified', name: 'eslint', category: 'quality',
  summary: 'Old summary', description: null, license: 'MIT', homepageUrl: null, sourceUrl: null, icon: null, keywords: [],
  state: 'listed', pausedAt: null, featured: false, latestVersion: '1.1.0', createdAt: '2026-01-01', updatedAt: '2026-01-01',
};

const newVersionDraft = () => ({
  ...newListingDraft(),
  kind: 'new_version',
  listing,
  metadata: [
    { field: 'summary', value: 'New summary', source: 'spec', current: 'Old summary', changed: true },
    { field: 'license', value: 'MIT', source: 'spec', current: 'MIT', changed: false },
    { field: 'homepageUrl', value: 'https://new.example', source: 'spec', current: null, changed: true },
  ],
  listingUpdateOffer: [
    { field: 'summary', value: 'New summary', current: 'Old summary' },
    { field: 'homepageUrl', value: 'https://new.example', current: null },
  ],
});

const onSubmitted = jest.fn<AnyFn>();

beforeEach(() => {
  getPublishDraft.mockReset();
  submitPublishRequest.mockReset().mockResolvedValue({ success: true, data: { request: { id: 'r1' }, autoApproved: false } });
  onSubmitted.mockReset();
});

const preview = () => screen.getByTestId('listing-card-preview');

describe('new listing — accept or edit, with a live card preview', () => {
  it('shows each field with its source badge and pre-fills the card preview', async () => {
    getPublishDraft.mockResolvedValue({ success: true, data: newListingDraft() });
    render(<PublishRequestForm pluginId="p1" onSubmitted={onSubmitted} />);

    const summary = await screen.findByTestId('catalog-field-summary');
    expect(within(summary).getByText('README')).toBeInTheDocument();
    expect(within(screen.getByTestId('catalog-field-license')).getByText('Dockerfile')).toBeInTheDocument();
    expect(within(screen.getByTestId('catalog-field-homepageUrl')).getByText('Generated')).toBeInTheDocument();

    expect(within(preview()).getByText('eslint')).toBeInTheDocument();
    expect(within(preview()).getByText('Lint JavaScript')).toBeInTheDocument();
    expect(within(preview()).getByText('v1.2.0')).toBeInTheDocument();
    // The publisher's tier badge rides on the card.
    expect(preview().querySelector('[data-tier="verified"]')).not.toBeNull();
    expect(getPublishDraft).toHaveBeenCalledWith('p1', expect.anything());
  });

  it('updates the preview as a field is edited and sends only the edit', async () => {
    getPublishDraft.mockResolvedValue({ success: true, data: newListingDraft() });
    render(<PublishRequestForm pluginId="p1" onSubmitted={onSubmitted} />);
    await screen.findByTestId('catalog-field-summary');

    fireEvent.click(screen.getByRole('button', { name: 'Accept all' }));
    expect(within(screen.getByTestId('catalog-field-license')).getByText('Accepted')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Edit Summary' }));
    fireEvent.change(screen.getByLabelText('New summary'), { target: { value: 'Find problems in JS' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(within(screen.getByTestId('catalog-field-summary')).getByText('Edited')).toBeInTheDocument();
    expect(within(preview()).getByText('Find problems in JS')).toBeInTheDocument();
    expect(within(preview()).queryByText('Lint JavaScript')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Submit listing request' }));
    await waitFor(() => expect(submitPublishRequest).toHaveBeenCalledWith({
      kind: 'new_listing', pluginId: 'p1', metadata: { summary: 'Find problems in JS' },
    }));
    expect(pageToast.success).toHaveBeenCalledWith(expect.stringMatching(/submitted/i));
    expect(onSubmitted).toHaveBeenCalled();
  });

  it('sends no metadata when everything is accepted as detected', async () => {
    getPublishDraft.mockResolvedValue({ success: true, data: newListingDraft() });
    render(<PublishRequestForm pluginId="p1" onSubmitted={onSubmitted} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Submit listing request' }));
    await waitFor(() => expect(submitPublishRequest).toHaveBeenCalledWith({ kind: 'new_listing', pluginId: 'p1' }));
  });

  it('a failing gate blocks submit', async () => {
    getPublishDraft.mockResolvedValue({
      success: true,
      data: newListingDraft([...okGates, { id: 'readme', ok: false, message: 'Add a README.md' }]),
    });
    render(<PublishRequestForm pluginId="p1" onSubmitted={onSubmitted} />);
    expect(await screen.findByText('Add a README.md')).toBeInTheDocument();
    expect(screen.getByText(/can't be submitted yet/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Submit listing request' })).toBeDisabled();
  });

  it('shows the failing gates the server reports on submit', async () => {
    getPublishDraft.mockResolvedValue({ success: true, data: newListingDraft() });
    submitPublishRequest.mockRejectedValue(new ApiError('gates', 409, 'PUBLISH_GATE_FAILED', {
      gates: [{ id: 'vuln', ok: false, message: 'New critical vulnerabilities' }],
    }));
    render(<PublishRequestForm pluginId="p1" onSubmitted={onSubmitted} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Submit listing request' }));
    expect(await screen.findByText('New critical vulnerabilities')).toBeInTheDocument();
    expect(onSubmitted).not.toHaveBeenCalled();
  });
});

describe('new version — the changed-fields-only listing update offer', () => {
  it('keeps the current listing by default: only the version request is sent', async () => {
    getPublishDraft.mockResolvedValue({ success: true, data: newVersionDraft() });
    render(<PublishRequestForm pluginId="p1" onSubmitted={onSubmitted} />);
    const summary = await screen.findByTestId('offer-field-summary');
    expect(within(summary).getByText('Unchanged')).toBeInTheDocument();
    expect(within(preview()).getByText('Old summary')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Submit version request' }));
    await waitFor(() => expect(submitPublishRequest).toHaveBeenCalledTimes(1));
    expect(submitPublishRequest).toHaveBeenCalledWith({ kind: 'new_version', pluginId: 'p1', breaking: false });
  });

  it('Accept and Edit become a separate listing_update request', async () => {
    getPublishDraft.mockResolvedValue({ success: true, data: newVersionDraft() });
    render(<PublishRequestForm pluginId="p1" onSubmitted={onSubmitted} />);
    await screen.findByTestId('offer-field-summary');

    fireEvent.click(screen.getByRole('button', { name: 'Accept new Summary' }));
    expect(within(screen.getByTestId('offer-field-summary')).getByText('Accepted')).toBeInTheDocument();
    expect(within(preview()).getByText('New summary')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Edit Homepage URL' }));
    fireEvent.change(screen.getByLabelText('New homepage url'), { target: { value: 'https://edited.example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(within(screen.getByTestId('offer-field-homepageUrl')).getByText('Edited')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Submit version request' }));
    await waitFor(() => expect(submitPublishRequest).toHaveBeenCalledTimes(2));
    expect(submitPublishRequest).toHaveBeenNthCalledWith(1, { kind: 'new_version', pluginId: 'p1', breaking: true });
    expect(submitPublishRequest).toHaveBeenNthCalledWith(2, {
      kind: 'listing_update',
      listingId: 'l1',
      metadata: { summary: 'New summary', homepageUrl: 'https://edited.example' },
      // The accepted field carries its detected source; the edited one defaults to `user`.
      sources: { summary: 'spec' },
    });
  });

  it('Keep current withdraws an accepted field', async () => {
    getPublishDraft.mockResolvedValue({ success: true, data: newVersionDraft() });
    render(<PublishRequestForm pluginId="p1" onSubmitted={onSubmitted} />);
    await screen.findByTestId('offer-field-summary');
    fireEvent.click(screen.getByRole('button', { name: 'Accept new Summary' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep current Summary' }));
    expect(within(screen.getByTestId('offer-field-summary')).getByText('Unchanged')).toBeInTheDocument();
  });

  it('tells the publisher when the listing update fails after the version was submitted', async () => {
    getPublishDraft.mockResolvedValue({ success: true, data: newVersionDraft() });
    submitPublishRequest
      .mockResolvedValueOnce({ success: true, data: { request: { id: 'r1' }, autoApproved: true } })
      .mockRejectedValueOnce(new ApiError('dup', 409, 'DUPLICATE_ENTRY'));
    render(<PublishRequestForm pluginId="p1" onSubmitted={onSubmitted} />);
    await screen.findByTestId('offer-field-summary');
    fireEvent.click(screen.getByRole('button', { name: 'Accept new Summary' }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit version request' }));
    await waitFor(() => expect(pageToast.error).toHaveBeenCalledWith(expect.stringMatching(/listing update was not/i)));
    expect(pageToast.success).toHaveBeenCalledWith(expect.stringMatching(/approved automatically/i));
    expect(onSubmitted).toHaveBeenCalled();
  });
});

describe('describePublishError', () => {
  it.each([
    ['QUOTA_EXCEEDED', /listings limit/i],
    ['PUBLISHER_REQUIRED', /publisher profile first/i],
    ['PUBLISHER_TERMS_REQUIRED', /accept the current publisher terms/i],
    ['PUBLISHER_ROOT_ORG_REQUIRED', /root organization/i],
    ['PUBLISHER_SUSPENDED', /suspended/i],
    ['PLUGIN_PUBLISHING_DISABLED', /turned off/i],
  ])('%s', (code, pattern) => {
    expect(describePublishError(new ApiError('x', 403, code)).message).toMatch(pattern);
  });

  it('falls back to the message', () => {
    expect(describePublishError(new Error('boom')).message).toBe('boom');
  });

  it('a draft that fails to load offers a retry', async () => {
    getPublishDraft.mockRejectedValue(new ApiError('nope', 403, 'PUBLISHER_ROOT_ORG_REQUIRED'));
    render(<PublishRequestForm pluginId="p1" onSubmitted={onSubmitted} />);
    expect(await screen.findByText(/root organization/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });
});
