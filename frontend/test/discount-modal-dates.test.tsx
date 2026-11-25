// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * "Redeem by" is an INCLUSIVE local day. The billing service refuses a
 * redemption once `redeemBy < now`, so sending midnight UTC (what
 * `new Date('YYYY-MM-DD')` yields) expired every code a day early — earlier
 * still west of UTC. And an edit re-sent the seeded day on every save, so
 * toggling Active alone rewrote the stored instant.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const createDiscount = jest.fn<AnyFn>();
const updateDiscount = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    createDiscount: (...a: unknown[]) => createDiscount(...a),
    updateDiscount: (...a: unknown[]) => updateDiscount(...a),
    listCampaigns: async () => ({ success: true, data: { campaigns: [] } }),
  },
}));

import { MintDiscountModal } from '@/components/discounts/MintDiscountModal';
import { EditDiscountModal } from '@/components/discounts/EditDiscountModal';
import type { Discount } from '@/types';

const lastInstantOf = (y: number, m: number, d: number) => new Date(y, m - 1, d, 23, 59, 59, 999).toISOString();

const discount = (over: Partial<Discount> = {}): Discount => ({
  id: 'd1', value: 10, unit: 'percent', currency: 'usd', kind: 'onetime', timesRedeemed: 0, isActive: true,
  redeemBy: lastInstantOf(2026, 12, 31), appliesToTiers: [], ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  createDiscount.mockResolvedValue({ success: true });
  updateDiscount.mockResolvedValue({ success: true });
});

describe('MintDiscountModal redeem-by', () => {
  it('sends the LAST local instant of the picked day', async () => {
    const onCreated = jest.fn<AnyFn>();
    render(<MintDiscountModal onClose={jest.fn<AnyFn>()} onCreated={onCreated} />);
    fireEvent.change(screen.getByLabelText('Code'), { target: { value: 'WELCOME' } });
    fireEvent.change(screen.getByLabelText(/Redeem by/), { target: { value: '2026-12-31' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Discount' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(createDiscount).toHaveBeenCalledWith(expect.objectContaining({ code: 'WELCOME', redeemBy: lastInstantOf(2026, 12, 31) }));
  });
});

describe('EditDiscountModal redeem-by', () => {
  it('seeds the field from the LOCAL day of the stored instant', () => {
    render(<EditDiscountModal discount={discount()} onClose={jest.fn<AnyFn>()} onSaved={jest.fn<AnyFn>()} />);
    expect(screen.getByLabelText('Redeem by')).toHaveValue('2026-12-31');
  });

  it('does not re-send an unchanged day on an unrelated edit', async () => {
    const onSaved = jest.fn<AnyFn>();
    render(<EditDiscountModal discount={discount()} onClose={jest.fn<AnyFn>()} onSaved={onSaved} />);
    fireEvent.click(screen.getByLabelText(/Active/));
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(updateDiscount.mock.calls[0][1]).not.toHaveProperty('redeemBy');
  });

  it('sends a changed day as its last local instant', async () => {
    const onSaved = jest.fn<AnyFn>();
    render(<EditDiscountModal discount={discount()} onClose={jest.fn<AnyFn>()} onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText('Redeem by'), { target: { value: '2027-01-15' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(updateDiscount).toHaveBeenCalledWith('d1', expect.objectContaining({ redeemBy: lastInstantOf(2027, 1, 15) }));
  });
});
