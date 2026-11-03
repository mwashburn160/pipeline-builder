// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Choosing the campaign a discount code belongs to.
 *
 * `campaign` used to be a free-text box, which was fine while it was a label:
 * any string was accepted and a typo quietly created a second campaign. It is
 * now a REFERENCE the server validates, so a typed name it has never seen is
 * refused — a text box would hand the author a 400 for a value they had no way
 * to know was wrong, and still not tell them which campaigns exist.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, waitFor } from '@testing-library/react';
import { CampaignSelect } from '../src/components/discounts/CampaignSelect';

const listCampaigns = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: { listCampaigns: (...a: unknown[]) => listCampaigns(...a) },
}));

const campaign = (over: Record<string, unknown>) => ({
  id: 'summer26', name: 'Summer 26', spentCents: 0, grantsCount: 0, isActive: true, remainingCents: null, open: true, ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  listCampaigns.mockResolvedValue({ data: { campaigns: [] } });
});

describe('CampaignSelect', () => {
  it('offers the open campaigns, with "no campaign" always available', async () => {
    listCampaigns.mockResolvedValue({ data: { campaigns: [
      campaign({ id: 'summer26', name: 'Summer 26' }),
      campaign({ id: 'launch', name: 'Launch' }),
    ] } });

    render(<CampaignSelect value="" onChange={() => {}} />);

    expect(await screen.findByRole('option', { name: /Summer 26 \(summer26\)/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Launch \(launch\)/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'No campaign' })).toBeInTheDocument();
  });

  /**
   * A closed, ended or budget-exhausted campaign accepts no redemptions, so a
   * code minted into one is a code that cannot be used.
   */
  it('hides a campaign that is no longer open', async () => {
    listCampaigns.mockResolvedValue({ data: { campaigns: [
      campaign({ id: 'spent', name: 'Spent', open: false, budgetExhausted: true }),
    ] } });

    render(<CampaignSelect value="" onChange={() => {}} />);

    await waitFor(() => expect(listCampaigns).toHaveBeenCalled());
    expect(screen.queryByRole('option', { name: /Spent/ })).not.toBeInTheDocument();
  });

  /**
   * ...but the currently-SELECTED one stays listed even once it closes, or the
   * field would look like it had been cleared and a save would silently
   * re-point an existing record.
   */
  it('keeps a selected campaign visible after it closes, marked closed', async () => {
    listCampaigns.mockResolvedValue({ data: { campaigns: [
      campaign({ id: 'over', name: 'Over', open: false }),
      campaign({ id: 'live', name: 'Live' }),
    ] } });

    render(<CampaignSelect value="over" onChange={() => {}} />);

    expect(await screen.findByRole('option', { name: /Over \(over\) — closed/ })).toBeInTheDocument();
  });

  it('says where to create one when the org has no campaigns', async () => {
    render(<CampaignSelect value="" onChange={() => {}} />);
    expect(await screen.findByText(/No campaigns yet/)).toBeInTheDocument();
  });

  /** A campaign list that fails must not block minting — the field is optional. */
  it('degrades to a hint when campaigns cannot be loaded', async () => {
    listCampaigns.mockRejectedValue(new Error('boom'));
    render(<CampaignSelect value="" onChange={() => {}} />);
    expect(await screen.findByText(/Could not load campaigns/)).toBeInTheDocument();
  });
});
