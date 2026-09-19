// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * AddonGrid discoverability: a feature bundle surfaces the human label of the
 * feature(s) it unlocks (flag → FEATURE_METADATA label), and a `?highlight=`
 * deep-link emphasizes the matching bundle card.
 */

import { render, screen, fireEvent } from '@testing-library/react';
import { AddonGrid } from '../src/components/billing/AddonGrid';
import type { Bundle } from '../src/types';

// scrollIntoView isn't implemented in jsdom.
beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = jest.fn();
});

const doraBundle = {
  id: 'bundle-dora',
  name: 'Advanced Reporting (DORA)',
  description: 'DORA delivery analytics for your org.',
  grants: {},
  features: ['advanced_reporting'],
  prices: { monthly: 2900, annual: 29000 },
  stackable: false,
  availableForTiers: [],
} as unknown as Bundle;

const seatBundle = {
  id: 'bundle-seats',
  name: 'Seat Pack',
  description: 'Extra seats.',
  grants: { seats: 5 },
  prices: { monthly: 1000, annual: 10000 },
  stackable: true,
  availableForTiers: [],
} as unknown as Bundle;

const baseProps = {
  billingInterval: 'monthly' as const,
  bundleSelfService: true,
  actionLoading: false,
  previewLoading: false,
  addonQty: () => 0,
  requestAddonChange: jest.fn(),
};

describe('AddonGrid — feature discoverability', () => {
  it('shows the unlocked-feature label on a feature bundle', () => {
    render(<AddonGrid {...baseProps} bundles={[doraBundle]} />);
    // Flag mapped to its catalog label.
    expect(screen.getByText('Advanced Reporting')).toBeInTheDocument();
    expect(screen.getByText(/unlocks/i)).toBeInTheDocument();
  });

  it('omits the unlocks row for a capacity bundle with no features', () => {
    render(<AddonGrid {...baseProps} bundles={[seatBundle]} />);
    expect(screen.queryByText(/unlocks/i)).not.toBeInTheDocument();
  });

  it('scrolls the matching bundle into view when highlighted', () => {
    render(<AddonGrid {...baseProps} bundles={[seatBundle, doraBundle]} highlightFeature="advanced_reporting" />);
    expect(window.HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it('highlights a featureless capacity pack by its bundle id (e.g. dora_history_pack)', () => {
    // A retention / DORA-History pack grants no feature flag, so it must be
    // reachable via `?highlight=<bundle id>` — the retention card + Extend CTA
    // deep-link on the id, not a feature.
    const historyPack = {
      id: 'dora_history_pack', name: 'DORA History Pack', description: 'Longer DORA retention.',
      grants: { doraRetentionDays: 365 }, prices: { monthly: 1900, annual: 19000 },
      stackable: false, availableForTiers: [],
    } as unknown as Bundle;
    render(<AddonGrid {...baseProps} bundles={[seatBundle, historyPack]} highlightFeature="dora_history_pack" />);
    expect(window.HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
  });
});

describe('AddonGrid — SeatEntry (typed per-seat entry with volume tiers)', () => {
  const seat = {
    id: 'seat', name: 'Member Seat', description: 'One seat.',
    grants: { seats: 1 }, prices: { monthly: 1999, annual: 19990 }, stackable: true,
    availableForTiers: [],
    volumeTiers: [{ minQuantity: 5, discountPercent: 10 }, { minQuantity: 15, discountPercent: 20 }],
  } as unknown as Bundle;

  it('renders a typed number input + volume-tier hint (not the ±1 stepper)', () => {
    render(<AddonGrid {...baseProps} bundles={[seat]} addonQty={() => 0} />);
    expect(screen.getByRole('spinbutton', { name: /number of member seats/i })).toBeInTheDocument();
    expect(screen.getByText(/5\+: 10% off/i)).toBeInTheDocument();
  });

  it('commits the typed ABSOLUTE count', () => {
    const requestAddonChange = jest.fn();
    render(<AddonGrid {...baseProps} requestAddonChange={requestAddonChange} bundles={[seat]} addonQty={() => 3} />);
    const input = screen.getByRole('spinbutton', { name: /number of member seats/i });
    fireEvent.change(input, { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: /update/i }));
    expect(requestAddonChange).toHaveBeenCalledWith('seat', 'Member Seat', 7);
  });

  it('does NOT treat a cleared field as "set to 0" (no destructive removal)', () => {
    const requestAddonChange = jest.fn();
    render(<AddonGrid {...baseProps} requestAddonChange={requestAddonChange} bundles={[seat]} addonQty={() => 10} />);
    const input = screen.getByRole('spinbutton', { name: /number of member seats/i });
    fireEvent.change(input, { target: { value: '' } });
    const btn = screen.getByRole('button', { name: /update/i });
    expect(btn).toBeDisabled();
    fireEvent.click(btn); // no-op even if clicked
    expect(requestAddonChange).not.toHaveBeenCalled();
  });

  it('disables the seat input + button while a change is staged in the preview modal (changePending)', () => {
    // fe#10: after the preview resolves, actionLoading/previewLoading are both
    // false — without changePending the input re-enables behind the open modal, so
    // a stray Enter could fire a SECOND requestAddonChange and swap the staged
    // change. The `disabled` (which the browser enforces against typing/Enter) is
    // the fix, so assert both controls are disabled.
    render(<AddonGrid {...baseProps} changePending bundles={[seat]} addonQty={() => 3} />);
    expect(screen.getByRole('spinbutton', { name: /number of member seats/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /update/i })).toBeDisabled();
  });

  it('leaves the seat controls enabled when no change is pending', () => {
    render(<AddonGrid {...baseProps} bundles={[seat]} addonQty={() => 3} />);
    expect(screen.getByRole('spinbutton', { name: /number of member seats/i })).not.toBeDisabled();
  });
});

describe('AddonGrid — unsubscribed preview', () => {
  // The bundles endpoint can't tier-filter without a subscription, so the preview
  // lists the whole catalog — including packs a given plan doesn't sell.
  const teamOnly = {
    id: 'seat', name: 'Member Seat', description: '1 additional member seat.',
    grants: { seats: 1 }, prices: { monthly: 1999, annual: 19990 }, stackable: true,
    availableForTiers: ['team', 'enterprise'],
  } as unknown as Bundle;
  const anyPlan = {
    id: 'plugin_pack', name: 'Plugin Pack (+25)', description: '25 additional plugins.',
    grants: { plugins: 25 }, prices: { monthly: 1000, annual: 10000 }, stackable: true,
    availableForTiers: ['developer', 'pro', 'team', 'enterprise'],
  } as unknown as Bundle;
  const proOnly = {
    id: 'sso', name: 'SSO / IdP', description: 'SSO + up to 5 IdP configs.',
    grants: {}, prices: { monthly: 4000, annual: 40000 }, stackable: false,
    availableForTiers: ['pro'],
  } as unknown as Bundle;

  it('offers a real subscribe CTA instead of dead text', () => {
    const onSubscribeIntent = jest.fn();
    render(<AddonGrid {...baseProps} subscribed={false} onSubscribeIntent={onSubscribeIntent} bundles={[anyPlan]} />);
    fireEvent.click(screen.getByRole('button', { name: /subscribe to add/i }));
    expect(onSubscribeIntent).toHaveBeenCalledWith(anyPlan);
  });

  it('falls back to plain text when no CTA handler is wired', () => {
    render(<AddonGrid {...baseProps} subscribed={false} bundles={[anyPlan]} />);
    expect(screen.queryByRole('button', { name: /subscribe to add/i })).not.toBeInTheDocument();
    expect(screen.getByText('Subscribe to add')).toBeInTheDocument();
  });

  it('names the plans each pack is sold on, so it cannot vanish after subscribing', () => {
    render(<AddonGrid {...baseProps} subscribed={false} bundles={[teamOnly, anyPlan, proOnly]} />);
    expect(screen.getByText('On Team and Enterprise')).toBeInTheDocument();
    expect(screen.getByText('On Pro')).toBeInTheDocument();
    expect(screen.getByText('On every plan')).toBeInTheDocument();
  });

  it('leads with the packs the cheapest plan can buy', () => {
    render(<AddonGrid {...baseProps} subscribed={false} bundles={[teamOnly, proOnly, anyPlan]} />);
    const names = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(names).toEqual(['Plugin Pack (+25)', 'SSO / IdP', 'Member Seat']);
  });

  it('keeps the catalog order (no tier re-sort) once subscribed', () => {
    render(<AddonGrid {...baseProps} subscribed bundles={[teamOnly, proOnly, anyPlan]} />);
    const names = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(names).toEqual(['Member Seat', 'SSO / IdP', 'Plugin Pack (+25)']);
    expect(screen.queryByText(/^On /)).not.toBeInTheDocument();
  });

  it('links a marketplace-managed account to where it can actually manage packs', () => {
    render(<AddonGrid {...baseProps} subscribed bundleSelfService={false} bundles={[anyPlan]} addonQty={() => 0} />);
    const link = screen.getByRole('link', { name: /manage in aws marketplace/i });
    expect(link).toHaveAttribute('href', 'https://aws.amazon.com/marketplace/library');
  });

  it('still reports an owned quantity on a marketplace-managed account', () => {
    render(<AddonGrid {...baseProps} subscribed bundleSelfService={false} bundles={[anyPlan]} addonQty={() => 2} />);
    expect(screen.getByText('2 active')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /marketplace/i })).not.toBeInTheDocument();
  });
});

describe('AddonGrid — PackQuantityEntry (every stackable pack)', () => {
  // A plain capacity pack: stackable, no volume tiers. It used to render a bare
  // ±1 stepper that showed neither the resulting total nor a pack's cap.
  const pluginPack = {
    id: 'plugin_pack', name: 'Plugin Pack (+25)', description: '25 additional plugins.',
    grants: { plugins: 25 }, prices: { monthly: 1000, annual: 10000 }, stackable: true,
    availableForTiers: [],
  } as unknown as Bundle;
  // Retention packs are capped server-side (`maxQuantity`), which the ±1 stepper
  // let a buyer click straight past into a 400.
  const cappedPack = { ...pluginPack, id: 'retention_pack', name: 'Standard Retention Pack (+90d)', maxQuantity: 7 } as unknown as Bundle;

  it('renders typed entry instead of the ±1 stepper', () => {
    render(<AddonGrid {...baseProps} bundles={[pluginPack]} addonQty={() => 0} />);
    expect(screen.getByRole('spinbutton', { name: /number of plugin packs/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add one/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /remove one/i })).not.toBeInTheDocument();
  });

  it('shows the resulting quantity, delta, and what it costs', () => {
    render(<AddonGrid {...baseProps} bundles={[pluginPack]} addonQty={() => 1} />);
    fireEvent.change(screen.getByRole('spinbutton', { name: /number of plugin packs/i }), { target: { value: '3' } });
    expect(screen.getByText(/1 → 3 \(\+2\).*\$30\.00\/mo/)).toBeInTheDocument();
  });

  it('commits the typed ABSOLUTE count', () => {
    const requestAddonChange = jest.fn();
    render(<AddonGrid {...baseProps} requestAddonChange={requestAddonChange} bundles={[pluginPack]} addonQty={() => 0} />);
    fireEvent.change(screen.getByRole('spinbutton', { name: /number of plugin packs/i }), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: /^add$/i }));
    expect(requestAddonChange).toHaveBeenCalledWith('plugin_pack', 'Plugin Pack (+25)', 2);
  });

  it('refuses a quantity above the pack cap instead of letting the server 400 it', () => {
    const requestAddonChange = jest.fn();
    render(<AddonGrid {...baseProps} requestAddonChange={requestAddonChange} bundles={[cappedPack]} addonQty={() => 1} />);
    fireEvent.change(screen.getByRole('spinbutton', { name: /number of standard retention packs/i }), { target: { value: '9' } });
    expect(screen.getByText(/capped at 7/i)).toBeInTheDocument();
    const btn = screen.getByRole('button', { name: /update/i });
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(requestAddonChange).not.toHaveBeenCalled();
  });

  it('asks in-app before a destructive reduction, and honours a cancel', () => {
    const requestAddonChange = jest.fn();
    render(<AddonGrid {...baseProps} requestAddonChange={requestAddonChange} bundles={[pluginPack]} addonQty={() => 4} />);
    fireEvent.change(screen.getByRole('spinbutton', { name: /number of plugin packs/i }), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: /update/i }));

    // A styled dialog, not window.confirm — it states the change and the risk.
    expect(screen.getByRole('dialog')).toHaveTextContent(/reduce plugin packs\?/i);
    expect(screen.getByText(/removes the extra capacity/i)).toBeInTheDocument();
    expect(requestAddonChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(requestAddonChange).not.toHaveBeenCalled();
  });

  it('commits the reduction once confirmed', () => {
    const requestAddonChange = jest.fn();
    render(<AddonGrid {...baseProps} requestAddonChange={requestAddonChange} bundles={[pluginPack]} addonQty={() => 4} />);
    fireEvent.change(screen.getByRole('spinbutton', { name: /number of plugin packs/i }), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: /update/i }));
    fireEvent.click(screen.getByRole('button', { name: /reduce to 0/i }));
    expect(requestAddonChange).toHaveBeenCalledWith('plugin_pack', 'Plugin Pack (+25)', 0);
  });

  it('commits a small change with no dialog at all', () => {
    const requestAddonChange = jest.fn();
    render(<AddonGrid {...baseProps} requestAddonChange={requestAddonChange} bundles={[pluginPack]} addonQty={() => 1} />);
    fireEvent.change(screen.getByRole('spinbutton', { name: /number of plugin packs/i }), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: /update/i }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(requestAddonChange).toHaveBeenCalledWith('plugin_pack', 'Plugin Pack (+25)', 2);
  });
});

describe('AddonGrid — combo "pair to save" nudge', () => {
  const tuaBundle = {
    id: 'bundle-tua', name: 'Team Usage Analytics', description: 'Per-team usage.',
    grants: {}, features: ['team_usage_analytics'], prices: { monthly: 3000, annual: 30000 },
    stackable: false, availableForTiers: [],
  } as unknown as Bundle;
  const combo = {
    id: 'analytics_suite', name: 'Analytics Suite',
    bundleIds: ['bundle-dora', 'bundle-tua'], savings: { monthly: 2000, annual: 20000 },
  };

  it('nudges on the UN-owned member when the other member is already owned', () => {
    // TUA owned (qty 1), DORA not → the DORA card prompts to complete the suite.
    render(
      <AddonGrid
        {...baseProps}
        bundles={[doraBundle, tuaBundle]}
        addonQty={(id) => (id === 'bundle-tua' ? 1 : 0)}
        comboDiscounts={[combo]}
      />,
    );
    expect(screen.getByText(/Completes the Analytics Suite — save \$20\.00\/mo/i)).toBeInTheDocument();
  });

  it('does not nudge when neither member is owned', () => {
    render(<AddonGrid {...baseProps} bundles={[doraBundle, tuaBundle]} addonQty={() => 0} comboDiscounts={[combo]} />);
    expect(screen.queryByText(/Completes the/i)).not.toBeInTheDocument();
  });

  it('does not nudge a member that is already owned (combo already complete)', () => {
    render(<AddonGrid {...baseProps} bundles={[doraBundle, tuaBundle]} addonQty={() => 1} comboDiscounts={[combo]} />);
    expect(screen.queryByText(/Completes the/i)).not.toBeInTheDocument();
  });

  it('is quantity-aware: fires below a member minimum, clears once met', () => {
    // Seat Pack combo needs qty ≥ 2; TUA owned. seat card at qty 1 → still nudged.
    const seatCombo = { id: 'seaty', name: 'Seat Combo', bundleIds: ['bundle-seats', 'bundle-tua'], minQuantities: { 'bundle-seats': 2 }, savings: { monthly: 1500, annual: 15000 } };
    const props = { ...baseProps, bundles: [seatBundle, tuaBundle], comboDiscounts: [seatCombo] };
    const { rerender } = render(<AddonGrid {...props} addonQty={(id) => (id === 'bundle-tua' ? 1 : 1)} />);
    expect(screen.getByText(/Completes the Seat Combo/i)).toBeInTheDocument();
    rerender(<AddonGrid {...props} addonQty={() => 2} />); // seats now meet min → no nudge
    expect(screen.queryByText(/Completes the Seat Combo/i)).not.toBeInTheDocument();
  });

  it('shows only the higher-savings combo when a card completes two', () => {
    // The DORA card completes both combos (TUA + seats owned); show the bigger one.
    const small = { id: 'small', name: 'Small', bundleIds: ['bundle-dora', 'bundle-tua'], savings: { monthly: 1000, annual: 10000 } };
    const big = { id: 'big', name: 'Big', bundleIds: ['bundle-dora', 'bundle-seats'], savings: { monthly: 2500, annual: 25000 } };
    render(
      <AddonGrid
        {...baseProps}
        bundles={[doraBundle, tuaBundle, seatBundle]}
        addonQty={(id) => (id === 'bundle-dora' ? 0 : 1)}
        comboDiscounts={[small, big]}
      />,
    );
    expect(screen.getByText(/Completes the Big — save \$25\.00\/mo/i)).toBeInTheDocument();
    expect(screen.queryByText(/Completes the Small/i)).not.toBeInTheDocument();
  });
});

describe('AddonGrid — unmet prerequisites', () => {
  const historyPack = {
    id: 'dora_history_pack',
    name: 'DORA History Pack (+365d)',
    description: '365 additional days of DORA history',
    grants: { doraRetentionDays: 365 },
    prices: { monthly: 3000, annual: 30000 },
    stackable: true,
    maxQuantity: 1,
    availableForTiers: [],
    requiresFeatures: ['advanced_reporting'],
    unmetRequirement: {
      bundleIds: [],
      features: ['advanced_reporting'],
      message: "DORA History Pack (+365d) requires Advanced Reporting, which your plan doesn't include yet",
    },
  } as unknown as Bundle;

  it('disables the add, says why, and links to the add-on that provides the feature', () => {
    const requestAddonChange = jest.fn();
    render(<AddonGrid {...baseProps} requestAddonChange={requestAddonChange} bundles={[doraBundle, historyPack]} />);
    const card = screen.getByTestId('addon-blocked-dora_history_pack');
    expect(card).toHaveTextContent(/requires Advanced Reporting/);
    // No quantity entry is offered for the blocked pack.
    expect(screen.queryByRole('spinbutton', { name: /DORA History Packs/i })).not.toBeInTheDocument();
    const add = card.querySelector('button')!;
    expect(add).toBeDisabled();
    fireEvent.click(add);
    expect(requestAddonChange).not.toHaveBeenCalled();
    const link = screen.getByRole('link', { name: /Add Advanced Reporting \(DORA\) first/ });
    expect(link.getAttribute('href')).toContain('highlight=bundle-dora');
  });

  it('points at the Plans tab when nothing on sale provides the prerequisite', () => {
    render(<AddonGrid {...baseProps} bundles={[historyPack]} />);
    const link = screen.getByRole('link', { name: /Upgrade your plan/ });
    expect(link.getAttribute('href')).toContain('tab=plans');
  });

  it('keeps a HELD pack manageable even if its prerequisite is unmet (so it can be removed)', () => {
    render(<AddonGrid {...baseProps} bundles={[historyPack]} addonQty={() => 1} />);
    expect(screen.queryByTestId('addon-blocked-dora_history_pack')).not.toBeInTheDocument();
  });
});
