// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Billing admin → a subscription's NEGOTIATED support floor
 * (PUT /billing/admin/subscriptions/:id/support-floor): `{ seats, floorCents,
 * note? }` sets it — `seats` is the count the price was agreed at, and
 * `floorCents` is per month — and `{ floorCents: null }` drops back to the
 * computed ramp. System org + `subscriptions:manage` + step-up.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { mockAuthGuard, pageToast } from './helpers/pageMocks';
import { ApiError } from '../src/lib/api/errors';
import { SupportFloorModal } from '../src/components/billing/SupportFloorModal';
import BillingAdminPage from '../pages/dashboard/admin/billing';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('next/router', () => require('./helpers/pageMocks').routerModule());
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());
jest.mock('@/components/billing/BillingAdminTabs', () => ({ __esModule: true, BillingAdminTabs: () => null }));
jest.mock('@/components/admin/StepUpModal', () => ({
  __esModule: true,
  StepUpModal: ({ onConfirmed, onClose, action }: { onConfirmed: (t: string) => Promise<void> | void; onClose: () => void; action: string }) => (
    <div data-testid="stepup-modal">
      <p>{action}</p>
      <button type="button" onClick={async () => { await onConfirmed('tok'); onClose(); }}>Confirm step-up</button>
    </div>
  ),
}));

const api: Record<string, jest.Mock<AnyFn>> = {
  setSupportFloor: jest.fn<AnyFn>(),
  listAdminSubscriptions: jest.fn<AnyFn>(),
  getAdminBillingSummary: jest.fn<AnyFn>(),
};
jest.mock('@/lib/api', () => {
  const errors = jest.requireActual<typeof import('../src/lib/api/errors')>('../src/lib/api/errors');
  return {
    __esModule: true,
    ApiError: errors.ApiError,
    default: new Proxy({}, {
      get: (_t, k: string) => (...a: unknown[]) => (api[k] ? api[k](...a) : Promise.resolve({ success: true, data: {} })),
    }),
  };
});

const SUB = {
  id: 'sub-1', orgId: 'org-acme', planId: 'pro', planName: 'Pro', status: 'active', interval: 'monthly',
  currentPeriodStart: '2026-11-01T00:00:00Z', currentPeriodEnd: '2026-12-01T00:00:00Z', cancelAtPeriodEnd: false,
  addons: [], recurringDiscount: null, creditRemainingCents: 0, currency: 'usd', dunning: null,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z',
} as never;

const AGREEMENT = { seats: 2500, floorCents: 800000, agreedAt: '2026-11-27T00:00:00Z', agreedBy: 'op', note: 'MSA 2026' };

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthGuard({ user: { id: 'op', organizationId: 'system' }, isSuperAdmin: true });
  api.setSupportFloor.mockResolvedValue({ success: true, data: { supportFloorOverride: AGREEMENT } });
  api.getAdminBillingSummary.mockResolvedValue({ success: true, data: { totalsByCurrency: [], byOrg: [], invoiceCount: 0 } });
  api.listAdminSubscriptions.mockResolvedValue({ success: true, data: { subscriptions: [SUB], total: 1, limit: 25, offset: 0 } });
});

const confirm = async () => fireEvent.click(within(await screen.findByTestId('stepup-modal')).getByRole('button', { name: 'Confirm step-up' }));
const fill = (seats: string, floor: string, note?: string) => {
  fireEvent.change(screen.getByLabelText(/agreed seats/i), { target: { value: seats } });
  fireEvent.change(screen.getByLabelText(/monthly floor/i), { target: { value: floor } });
  if (note !== undefined) fireEvent.change(screen.getByLabelText(/note/i), { target: { value: note } });
};

describe('SupportFloorModal', () => {
  it('sets the agreed floor through a step-up: seats, the price in cents, the trimmed note', async () => {
    const onSaved = jest.fn<AnyFn>();
    const onClose = jest.fn<AnyFn>();
    render(<SupportFloorModal subscription={SUB} onClose={onClose} onSaved={onSaved} />);
    fill('2500', '8000.00', '  MSA 2026 ');
    fireEvent.click(screen.getByRole('button', { name: 'Save floor' }));
    expect(within(await screen.findByTestId('stepup-modal')).getByText(/org-acme/)).toBeInTheDocument();
    await confirm();
    await waitFor(() => expect(api.setSupportFloor).toHaveBeenCalledWith('sub-1', { seats: 2500, floorCents: 800000, note: 'MSA 2026' }, 'tok'));
    await waitFor(() => expect(pageToast.success).toHaveBeenCalledWith(expect.stringMatching(/\$8,000\.00.*2,?500 seats/)));
    expect(onSaved).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('rounds a price to whole cents and omits an empty note', async () => {
    render(<SupportFloorModal subscription={SUB} onClose={() => {}} onSaved={() => {}} />);
    fill('10', '19.995', '  ');
    fireEvent.click(screen.getByRole('button', { name: 'Save floor' }));
    await confirm();
    await waitFor(() => expect(api.setSupportFloor).toHaveBeenCalledWith('sub-1', { seats: 10, floorCents: 2000 }, 'tok'));
  });

  it('a zero floor at zero seats is allowed (both are non-negative integers)', async () => {
    render(<SupportFloorModal subscription={SUB} onClose={() => {}} onSaved={() => {}} />);
    fill('0', '0');
    fireEvent.click(screen.getByRole('button', { name: 'Save floor' }));
    await confirm();
    await waitFor(() => expect(api.setSupportFloor).toHaveBeenCalledWith('sub-1', { seats: 0, floorCents: 0 }, 'tok'));
  });

  it.each([
    ['', '100', /seat count this price was agreed at/i],
    ['-1', '100', /seat count this price was agreed at/i],
    ['2.5', '100', /seat count this price was agreed at/i],
    ['10', '', /floor of 0 or more/i],
    ['10', '-5', /floor of 0 or more/i],
    ['10', 'abc', /floor of 0 or more/i],
  ])('refuses seats %p / floor %p before any step-up', async (seats, floor, message) => {
    render(<SupportFloorModal subscription={SUB} onClose={() => {}} onSaved={() => {}} />);
    fill(seats, floor);
    fireEvent.click(screen.getByRole('button', { name: 'Save floor' }));
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.queryByTestId('stepup-modal')).toBeNull();
  });

  it('Clear floor sends floorCents null and says the account is back on the ramp', async () => {
    api.setSupportFloor.mockResolvedValue({ success: true, data: { supportFloorOverride: null } });
    render(<SupportFloorModal subscription={{ ...(SUB as object), supportFloorOverride: AGREEMENT } as never} onClose={() => {}} onSaved={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear floor' }));
    expect(within(await screen.findByTestId('stepup-modal')).getByText(/clear the negotiated support floor/i)).toBeInTheDocument();
    await confirm();
    await waitFor(() => expect(api.setSupportFloor).toHaveBeenCalledWith('sub-1', { floorCents: null }, 'tok'));
    await waitFor(() => expect(pageToast.success).toHaveBeenCalledWith(expect.stringMatching(/computed ramp/i)));
  });

  it.each([
    [400, 'seats is required — the seat count this price was agreed at'],
    [404, 'Subscription not found'],
  ])('a %s stays open with the message', async (status, message) => {
    api.setSupportFloor.mockRejectedValue(new ApiError(message, status));
    const onClose = jest.fn<AnyFn>();
    render(<SupportFloorModal subscription={SUB} onClose={onClose} onSaved={() => {}} />);
    fill('10', '100');
    fireEvent.click(screen.getByRole('button', { name: 'Save floor' }));
    await confirm();
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(pageToast.success).not.toHaveBeenCalled();
  });
});

describe('SupportFloorModal: the agreement on file', () => {
  const withAgreement = { ...(SUB as object), supportFloorOverride: AGREEMENT } as never;

  it('says when no agreement is on file, starts empty, and holds back Clear (nothing to clear)', () => {
    render(<SupportFloorModal subscription={{ ...(SUB as object), supportFloorOverride: null } as never} onClose={() => {}} onSaved={() => {}} />);
    expect(screen.getByText(/no agreement on file/i)).toBeInTheDocument();
    expect((screen.getByLabelText(/agreed seats/i) as HTMLInputElement).value).toBe('');
    expect((screen.getByRole('button', { name: 'Clear floor' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the current agreement and prefills the form from it', () => {
    render(<SupportFloorModal subscription={withAgreement} onClose={() => {}} onSaved={() => {}} />);
    const current = screen.getByText(/current agreement/i).closest('div') as HTMLElement;
    expect(current.textContent).toMatch(/\$8,000\.00 a month at 2,500 seats/);
    expect(current.textContent).toMatch(/MSA 2026/);
    expect(current.textContent).toMatch(/op/);
    expect((screen.getByLabelText(/agreed seats/i) as HTMLInputElement).value).toBe('2500');
    expect((screen.getByLabelText(/monthly floor/i) as HTMLInputElement).value).toBe('8000.00');
    expect((screen.getByLabelText(/note/i) as HTMLInputElement).value).toBe('MSA 2026');
    expect((screen.getByRole('button', { name: 'Clear floor' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('saving the prefilled agreement unchanged re-sends it as is', async () => {
    render(<SupportFloorModal subscription={withAgreement} onClose={() => {}} onSaved={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save floor' }));
    await confirm();
    await waitFor(() => expect(api.setSupportFloor).toHaveBeenCalledWith('sub-1', { seats: 2500, floorCents: 800000, note: 'MSA 2026' }, 'tok'));
  });
});

describe('Billing admin: the Support floor row action', () => {
  it('is offered to a holder of subscriptions:manage and opens the editor with the agreement the list read', async () => {
    api.listAdminSubscriptions.mockResolvedValue({ success: true, data: { subscriptions: [{ ...(SUB as object), supportFloorOverride: AGREEMENT }], total: 1, limit: 25, offset: 0 } });
    render(<BillingAdminPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Support floor' }));
    expect(((await screen.findByLabelText(/agreed seats/i)) as HTMLInputElement).value).toBe('2500');
  });

  it('is not offered without subscriptions:manage', async () => {
    mockAuthGuard({ user: { id: 'op', organizationId: 'system' }, can: (p: string) => p === 'subscriptions:read' || p === 'billing:operate' });
    render(<BillingAdminPage />);
    await screen.findByText('org-acme');
    expect(screen.queryByRole('button', { name: 'Support floor' })).toBeNull();
  });
});
