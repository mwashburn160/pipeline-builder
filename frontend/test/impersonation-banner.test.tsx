// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ImpersonationBanner } from '../src/components/ui/ImpersonationBanner';

const endImpersonation = jest.fn();
const stopImpersonation = jest.fn();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    isImpersonating: () => true,
    getImpersonatedUserId: () => 'target-user',
    endImpersonation: (...a: unknown[]) => endImpersonation(...a),
    stopImpersonation: (...a: unknown[]) => stopImpersonation(...a),
  },
}));

describe('ImpersonationBanner', () => {
  beforeEach(() => { endImpersonation.mockReset(); stopImpersonation.mockReset(); });

  it('ends the session on the SERVER, not just in this browser', async () => {
    endImpersonation.mockResolvedValue(undefined);
    render(<ImpersonationBanner />);

    fireEvent.click(screen.getByRole('button', { name: /stop impersonating/i }));

    await waitFor(() => expect(endImpersonation).toHaveBeenCalled());
    // The browser-only stop would leave the session valid until its TTL.
    expect(stopImpersonation).not.toHaveBeenCalled();
  });

  it('shows progress while ending, so a slow revoke isn\'t mistaken for a dead button', async () => {
    endImpersonation.mockReturnValue(new Promise(() => { /* pending */ }));
    render(<ImpersonationBanner />);

    fireEvent.click(screen.getByRole('button', { name: /stop impersonating/i }));

    expect(await screen.findByText(/ending session/i)).toBeInTheDocument();
  });
});
