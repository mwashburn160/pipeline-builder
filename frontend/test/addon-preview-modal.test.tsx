// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * AddonPreviewModal — the preview-and-confirm dialog for an add-on change. Beyond
 * the itemized price it must warn, before commit, when the change ends a combo
 * discount (drives the Team Growth / Analytics Suite "you'll lose −$20/mo" note).
 */

import { render, screen } from '@testing-library/react';
import { AddonPreviewModal } from '../src/components/billing/AddonPreviewModal';
import type { AddonResult } from '../src/types';

const baseProps = {
  pendingAddon: { bundleId: 'seat_pack', name: 'Seat Pack', quantity: 0 },
  previewLoading: false,
  paymentRequired: false,
  actionLoading: false,
  portalLoading: false,
  onClose: jest.fn(),
  onCancel: jest.fn(),
  onConfirmAddonChange: jest.fn(),
  onOpenBillingPortal: jest.fn(),
};

const preview = (over: Partial<AddonResult> = {}): AddonResult => ({
  addons: [],
  effectiveLimits: {},
  priceBreakdown: { interval: 'monthly', items: [{ label: 'Pro', quantity: 1, cents: 4900 }], totalCents: 4900 },
  ...over,
});

describe('AddonPreviewModal — combo removal warning', () => {
  it('warns that a removal ends an active combo discount', () => {
    render(
      <AddonPreviewModal
        {...baseProps}
        addonPreview={preview({ lostCombos: [{ comboId: 'team_growth', name: 'Team Growth Bundle', creditCents: 2000 }] })}
      />,
    );
    expect(screen.getByText(/Ends your Team Growth Bundle discount — \$20\.00\/mo off/i)).toBeInTheDocument();
  });

  it('shows no warning when the change ends no combo', () => {
    render(<AddonPreviewModal {...baseProps} addonPreview={preview({ lostCombos: [] })} />);
    expect(screen.queryByText(/Ends your/i)).not.toBeInTheDocument();
  });
});
