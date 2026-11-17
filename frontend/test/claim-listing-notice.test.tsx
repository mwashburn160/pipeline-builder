// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Claiming a community listing files a publish request, which the plugin
 * service admits only on `publishers:manage`. Every other signed-in viewer
 * sees the button LOCKED with the reason rather than a form that can only fail.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { render, screen, fireEvent } from '@testing-library/react';

jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());
jest.mock('@/lib/api', () => ({ __esModule: true, default: {} }));

import { ClaimListingNotice } from '@/components/public-directory/ClaimListingNotice';

describe('ClaimListingNotice', () => {
  it('offers the claim to a publishers:manage holder', () => {
    render(<ClaimListingNotice listingName="trivy" signedIn canClaim loginHref="/login" />);
    const claim = screen.getByRole('button', { name: /claim this listing/i });
    expect(claim).toBeEnabled();
    fireEvent.click(claim);
    expect(screen.getAllByText(/Claim this listing/).length).toBeGreaterThan(1);
  });

  it('locks it, with the reason, for anyone else', () => {
    render(<ClaimListingNotice listingName="trivy" signedIn canClaim={false} loginHref="/login" />);
    const claim = screen.getByRole('button', { name: /claim this listing/i });
    expect(claim).toHaveAttribute('aria-disabled', 'true');
    expect(claim).toHaveAccessibleDescription(/publishers:manage/);
  });
});
