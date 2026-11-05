// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The push surfaces of docs/plans/sales-agent.md — F4, F6 and F7.
 *
 * Three claims are worth a test rather than a comment:
 *
 *  - **two verbs, not one.** "No" and "not now" hit different routes, because
 *    before this redemption was the only action and "never saw it" and "said
 *    no" were the same row — the single most valuable distinction the outcome
 *    log measures.
 *  - **the copy shown is the copy as SENT**, read back from the record rather
 *    than re-rendered, so a card cannot restate last month's offer at this
 *    month's price.
 *  - **the basket is one call.** A loop over the single-add route leaves a
 *    half-bought basket reachable, which is worse than either end state.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const getOffer = jest.fn<AnyFn>();
const declineOffer = jest.fn<AnyFn>();
const dismissOffer = jest.fn<AnyFn>();
const addAddonBasket = jest.fn<AnyFn>();

jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getOffer: (...a: unknown[]) => getOffer(...a),
    declineOffer: (...a: unknown[]) => declineOffer(...a),
    dismissOffer: (...a: unknown[]) => dismissOffer(...a),
    addAddonBasket: (...a: unknown[]) => addAddonBasket(...a),
  },
}));

const toastError = jest.fn<AnyFn>();
jest.mock('@/components/ui/Toast', () => ({
  __esModule: true,
  useToast: () => ({ success: jest.fn(), error: toastError, info: jest.fn(), warning: jest.fn() }),
}));

import { OfferCard, readableSignal } from '../src/components/billing/OfferCard';
import { OfferBasketModal } from '../src/components/billing/OfferBasketModal';

type Offer = Parameters<typeof OfferBasketModal>[0]['offer'];
type Bundle = Parameters<typeof OfferBasketModal>[0]['bundles'][number];

const PACK = {
  id: 'pipeline_pack', name: 'Pipeline Pack', description: '', grants: { pipelines: 10 },
  prices: { monthly: 1199, annual: 11_990 }, stackable: true,
  availableForTiers: ['pro'],
} as Bundle;
const PLUGIN_PACK = { ...PACK, id: 'plugin_pack', name: 'Plugin Pack', prices: { monthly: 999, annual: 9_990 } } as Bundle;

function offer(over: Partial<Offer> = {}): Offer {
  return {
    id: 'offer-1',
    offerType: 'pack',
    targetTier: null,
    targetBundles: [],
    subject: 'You are close to your pipelines limit',
    body: 'You are at 9 of 10 pipelines.\n\nPipeline Pack adds 10 for $11.99 per month.',
    rationale: ['sustained_pressure', 'pressure:pipelines'],
    status: 'sent',
    sentAt: '2026-11-01T00:00:00.000Z',
    expiresAt: '2026-12-01T00:00:00.000Z',
    dismissedAt: null,
    ...over,
  } as Offer;
}

beforeEach(() => {
  getOffer.mockReset(); declineOffer.mockReset(); dismissOffer.mockReset();
  addAddonBasket.mockReset(); toastError.mockReset();
});

describe('F4 — the card an account did not go looking for', () => {
  it('renders the copy AS SENT, not a re-render of today\'s catalogue', async () => {
    getOffer.mockResolvedValue({ data: { offer: offer() } });
    render(<OfferCard canRespond />);
    expect(await screen.findByText(/close to your pipelines limit/i)).toBeInTheDocument();
    expect(screen.getByText(/Pipeline Pack adds 10 for \$11\.99 per month/)).toBeInTheDocument();
  });

  it('renders NOTHING when there is no live offer — the normal state of an account', async () => {
    getOffer.mockResolvedValue({ data: { offer: null } });
    const { container } = render(<OfferCard canRespond />);
    await waitFor(() => expect(getOffer).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing, and does not throw, when the read fails', async () => {
    getOffer.mockRejectedValue(new Error('503'));
    const { container } = render(<OfferCard canRespond />);
    await waitFor(() => expect(getOffer).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the signals, because the rationale IS the argument', async () => {
    getOffer.mockResolvedValue({ data: { offer: offer() } });
    render(<OfferCard canRespond />);
    expect(await screen.findByText(/sustained use near a limit/i)).toBeInTheDocument();
  });

  it('DECLINE and DISMISS are different verbs on different routes', async () => {
    getOffer.mockResolvedValue({ data: { offer: offer() } });
    declineOffer.mockResolvedValue({ data: {} });
    render(<OfferCard canRespond />);
    await userEvent.click(await screen.findByRole('button', { name: /no thanks/i }));
    await waitFor(() => expect(declineOffer).toHaveBeenCalledWith('offer-1'));
    expect(dismissOffer).not.toHaveBeenCalled();
  });

  it('dismiss hides the card without declining it', async () => {
    getOffer.mockResolvedValue({ data: { offer: offer() } });
    dismissOffer.mockResolvedValue({ data: {} });
    render(<OfferCard canRespond />);
    await userEvent.click(await screen.findByRole('button', { name: /not now/i }));
    await waitFor(() => expect(dismissOffer).toHaveBeenCalledWith('offer-1'));
    expect(declineOffer).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByTestId('offer-card')).not.toBeInTheDocument());
  });

  it('keeps the card visible when the verb FAILS — a silent no-op would read as done', async () => {
    getOffer.mockResolvedValue({ data: { offer: offer() } });
    dismissOffer.mockRejectedValue(new Error('500'));
    render(<OfferCard canRespond />);
    await userEvent.click(await screen.findByRole('button', { name: /not now/i }));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(screen.getByTestId('offer-card')).toBeInTheDocument();
  });

  it('shows the offer but NOT the verbs to a viewer who cannot act', async () => {
    // billing:read should see what was suggested about their own account; the
    // routes enforce billing:manage, so rendering the buttons would 403.
    getOffer.mockResolvedValue({ data: { offer: offer() } });
    render(<OfferCard canRespond={false} />);
    expect(await screen.findByTestId('offer-card')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /no thanks/i })).not.toBeInTheDocument();
    expect(screen.getByText(/contact an organization admin/i)).toBeInTheDocument();
  });

  it('offers no basket button when there is nothing to price it with', async () => {
    getOffer.mockResolvedValue({ data: { offer: offer({ targetBundles: [{ bundleId: 'pipeline_pack', quantity: 1 }] }) } });
    render(<OfferCard canRespond />);
    await screen.findByTestId('offer-card');
    // No subscriptionId and no bundles: a "buy" button that cannot price itself
    // is worse than no button.
    expect(screen.queryByRole('button', { name: /add it/i })).not.toBeInTheDocument();
  });

  it('never offers a basket for an UPGRADE — that is a plan change, not a purchase', async () => {
    getOffer.mockResolvedValue({
      data: { offer: offer({ offerType: 'upgrade', targetBundles: [{ bundleId: 'pipeline_pack', quantity: 1 }] }) },
    });
    render(<OfferCard canRespond subscriptionId="sub1" bundles={[PACK]} />);
    await screen.findByTestId('offer-card');
    expect(screen.queryByRole('button', { name: /add it/i })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /compare plans/i })).toBeInTheDocument();
  });

  it('maps unknown rationale tokens to nothing rather than leaking internals', () => {
    expect(readableSignal('pressure:pipelines')).toBe('');
    expect(readableSignal('some_future_signal')).toBe('');
    expect(readableSignal('crossover')).toContain('next plan');
  });
});

describe('F6 — the basket, applied as one change', () => {
  const composed = offer({
    offerType: 'compose',
    targetBundles: [{ bundleId: 'pipeline_pack', quantity: 2 }, { bundleId: 'plugin_pack', quantity: 1 }],
  });

  it('shows a COMBINED total, because the offer was sized as a whole', () => {
    render(
      <OfferBasketModal
        offer={composed}
        subscriptionId="sub1"
        bundles={[PACK, PLUGIN_PACK]}
        interval="monthly"
        onClose={jest.fn()}
        onApplied={jest.fn()}
      />,
    );
    // 2 × $11.99 + 1 × $9.99
    expect(screen.getByTestId('offer-basket-total')).toHaveTextContent('$33.97');
  });

  it('sends ONE call with every item', async () => {
    addAddonBasket.mockResolvedValue({ data: {} });
    const onApplied = jest.fn();
    render(
      <OfferBasketModal
        offer={composed}
        subscriptionId="sub1"
        bundles={[PACK, PLUGIN_PACK]}
        interval="monthly"
        onClose={jest.fn()}
        onApplied={onApplied}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /add 2 add-ons/i }));
    await waitFor(() => expect(addAddonBasket).toHaveBeenCalledTimes(1));
    expect(addAddonBasket).toHaveBeenCalledWith('sub1', [
      { bundleId: 'pipeline_pack', quantity: 2 },
      { bundleId: 'plugin_pack', quantity: 1 },
    ]);
    await waitFor(() => expect(onApplied).toHaveBeenCalled());
  });

  it('drops an item the account\'s catalogue does not carry rather than pricing it as unknown', () => {
    render(
      <OfferBasketModal
        offer={composed}
        subscriptionId="sub1"
        bundles={[PACK]}
        interval="monthly"
        onClose={jest.fn()}
        onApplied={jest.fn()}
      />,
    );
    expect(screen.getByTestId('offer-basket-total')).toHaveTextContent('$23.98');
    expect(screen.queryByText('Plugin Pack')).not.toBeInTheDocument();
  });

  it('says plainly that NOTHING was applied when the call fails', async () => {
    addAddonBasket.mockRejectedValue(new Error('409'));
    render(
      <OfferBasketModal
        offer={composed}
        subscriptionId="sub1"
        bundles={[PACK, PLUGIN_PACK]}
        interval="monthly"
        onClose={jest.fn()}
        onApplied={jest.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /add 2 add-ons/i }));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
  });

  it('prices at the YEAR when the subscription is annual', () => {
    render(
      <OfferBasketModal
        offer={offer({ offerType: 'compose', targetBundles: [{ bundleId: 'pipeline_pack', quantity: 1 }] })}
        subscriptionId="sub1"
        bundles={[PACK]}
        interval="annual"
        onClose={jest.fn()}
        onApplied={jest.fn()}
      />,
    );
    expect(screen.getByTestId('offer-basket-total')).toHaveTextContent('$119.90');
    expect(screen.getByTestId('offer-basket-total')).toHaveTextContent('per year');
  });

  it('offers nothing to buy when the whole basket is unavailable on this plan', () => {
    render(
      <OfferBasketModal
        offer={composed}
        subscriptionId="sub1"
        bundles={[]}
        interval="monthly"
        onClose={jest.fn()}
        onApplied={jest.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /nothing to add/i })).toBeInTheDocument();
    expect(screen.getByText(/none of the suggested add-ons are available/i)).toBeInTheDocument();
  });
});
