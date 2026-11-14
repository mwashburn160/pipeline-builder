// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Campaign authoring: Create (slug normalization, dollars → cents, validation)
 * and the Details/Edit modal (the detail read with ledger-vs-cache spend, and an
 * edit that sends only what changed — so a budget change no longer means ending
 * the campaign and re-minting every code).
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const createCampaign = jest.fn<AnyFn>();
const getCampaign = jest.fn<AnyFn>();
const updateCampaign = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    createCampaign: (...a: unknown[]) => createCampaign(...a),
    getCampaign: (...a: unknown[]) => getCampaign(...a),
    updateCampaign: (...a: unknown[]) => updateCampaign(...a),
  },
}));

import { CreateCampaignModal } from '@/components/discounts/CreateCampaignModal';
import { EditCampaignModal } from '@/components/discounts/EditCampaignModal';
import type { Campaign } from '@/types';

const campaign = (over: Partial<Campaign> = {}): Campaign => ({
  id: 'summer-26', name: 'Summer 26', budgetCents: 50_000, spentCents: 12_000, remainingCents: 38_000,
  grantsCount: 3, exclusive: false, startsAt: '2026-06-01T00:00:00.000Z', endsAt: '2026-08-31T00:00:00.000Z',
  isActive: true, ...over,
});
const detail = (over: { ledgerCents?: number } = {}) => ({
  success: true,
  data: {
    campaign: campaign(),
    codes: { total: 5, active: 4 },
    ledgerSpend: { cents: over.ledgerCents ?? 12_000, grants: 3 },
  },
});

beforeEach(() => {
  jest.clearAllMocks();
  createCampaign.mockResolvedValue({ success: true, data: { campaign: campaign() } });
  getCampaign.mockResolvedValue(detail());
  updateCampaign.mockResolvedValue({ success: true, data: { campaign: campaign() } });
});

describe('CreateCampaignModal', () => {
  it('lower-cases the id, sends the budget in cents and the window as ISO', async () => {
    const onCreated = jest.fn<AnyFn>();
    render(<CreateCampaignModal onClose={jest.fn<AnyFn>()} onCreated={onCreated} />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: ' Summer 26 ' } });
    fireEvent.change(screen.getByLabelText('Campaign id'), { target: { value: 'Summer-26' } });
    expect(screen.getByText(/Stored as/)).toHaveTextContent('summer-26');
    fireEvent.change(screen.getByLabelText(/Budget/), { target: { value: '250.50' } });
    fireEvent.change(screen.getByLabelText(/Starts/), { target: { value: '2026-06-01' } });
    fireEvent.click(screen.getByLabelText('One redemption per account'));
    fireEvent.click(screen.getByRole('button', { name: 'Create Campaign' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(createCampaign).toHaveBeenCalledWith({
      id: 'summer-26', name: 'Summer 26', budgetCents: 25_050, exclusive: true, startsAt: new Date('2026-06-01').toISOString(),
    });
  });

  it('refuses a bad slug, a non-positive budget, and a reversed window without calling the API', async () => {
    render(<CreateCampaignModal onClose={jest.fn<AnyFn>()} onCreated={jest.fn<AnyFn>()} />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'X' } });
    fireEvent.change(screen.getByLabelText('Campaign id'), { target: { value: 'has space' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Campaign' }));
    expect(await screen.findByText(/may contain only letters/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Campaign id'), { target: { value: 'ok' } });
    fireEvent.change(screen.getByLabelText(/Budget/), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Campaign' }));
    expect(await screen.findByText(/Budget must be a positive amount/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Budget/), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText(/Starts/), { target: { value: '2026-09-01' } });
    fireEvent.change(screen.getByLabelText(/Ends/), { target: { value: '2026-08-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Campaign' }));
    expect(await screen.findByText(/start date must be before/)).toBeInTheDocument();
    expect(createCampaign).not.toHaveBeenCalled();
  });

  it('keeps Create disabled until name and id are filled', () => {
    render(<CreateCampaignModal onClose={jest.fn<AnyFn>()} onCreated={jest.fn<AnyFn>()} />);
    expect(screen.getByRole('button', { name: 'Create Campaign' })).toBeDisabled();
  });
});

describe('EditCampaignModal', () => {
  it('shows code counts and ledger spend from the detail read', async () => {
    render(<EditCampaignModal campaign={campaign()} onClose={jest.fn<AnyFn>()} onSaved={jest.fn<AnyFn>()} />);
    expect(await screen.findByTestId('campaign-codes')).toHaveTextContent('4 live of 5');
    expect(screen.getByTestId('campaign-ledger-spend')).toHaveTextContent('$120.00 · 3 grants');
    expect(getCampaign).toHaveBeenCalledWith('summer-26', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(screen.queryByText(/cached spend is/)).not.toBeInTheDocument();
  });

  it('calls out a drift between the cached and ledger spend', async () => {
    getCampaign.mockResolvedValue(detail({ ledgerCents: 15_000 }));
    render(<EditCampaignModal campaign={campaign()} onClose={jest.fn<AnyFn>()} onSaved={jest.fn<AnyFn>()} />);
    expect(await screen.findByText(/cached spend is \$30\.00 below the ledger/)).toBeInTheDocument();
  });

  it('sends only the changed fields', async () => {
    const onSaved = jest.fn<AnyFn>();
    render(<EditCampaignModal campaign={campaign()} onClose={jest.fn<AnyFn>()} onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText('Budget'), { target: { value: '750' } });
    fireEvent.click(screen.getByLabelText('One redemption per account'));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(updateCampaign).toHaveBeenCalledWith('summer-26', { budgetCents: 75_000, exclusive: true });
  });

  it('shows the server\'s refusal (budget below committed spend) and stays open', async () => {
    updateCampaign.mockRejectedValue(new Error('Budget cannot be set below the 12000c already committed'));
    const onSaved = jest.fn<AnyFn>();
    render(<EditCampaignModal campaign={campaign()} onClose={jest.fn<AnyFn>()} onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText('Budget'), { target: { value: '50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText(/below the 12000c already committed/)).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('clears an emptied budget and an emptied date by sending null', async () => {
    const onSaved = jest.fn<AnyFn>();
    render(<EditCampaignModal campaign={campaign()} onClose={jest.fn<AnyFn>()} onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText('Budget'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Ends'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(updateCampaign).toHaveBeenCalledWith('summer-26', expect.objectContaining({ budgetCents: null, endsAt: null }));
    expect(updateCampaign.mock.calls[0][1]).not.toHaveProperty('startsAt', null);
  });

  it('clears a stored start date with null', async () => {
    const onSaved = jest.fn<AnyFn>();
    render(<EditCampaignModal campaign={campaign({ startsAt: '2026-06-01T00:00:00.000Z' })} onClose={jest.fn<AnyFn>()} onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText('Starts'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(updateCampaign).toHaveBeenCalledWith('summer-26', { startsAt: null });
  });

  it('closes without a call when nothing changed', async () => {
    const onClose = jest.fn<AnyFn>();
    render(<EditCampaignModal campaign={campaign()} onClose={onClose} onSaved={jest.fn<AnyFn>()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(updateCampaign).not.toHaveBeenCalled();
  });
});
