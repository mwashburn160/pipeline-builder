// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ImpersonationBanner, formatCountdown } from '../src/components/ui/ImpersonationBanner';

const endImpersonation = jest.fn();
const stopImpersonation = jest.fn();
let accessToken: string | null = null;
let requestId: string | null = 'req-123';

jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    isImpersonating: () => true,
    getAccessToken: () => accessToken,
    getImpersonationRequestId: () => requestId,
    endImpersonation: (...a: unknown[]) => endImpersonation(...a),
    stopImpersonation: (...a: unknown[]) => stopImpersonation(...a),
  },
  base64UrlDecode: (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
}));

function token(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'ES256' })}.${b64(claims)}.sig`;
}

const NOW = new Date('2026-09-19T12:00:00Z').getTime();

describe('ImpersonationBanner', () => {
  beforeEach(() => {
    endImpersonation.mockReset();
    stopImpersonation.mockReset();
    requestId = 'req-123';
    accessToken = token({
      sub: 'target-user', username: 'Dana Target', email: 'dana@acme.test',
      organizationName: 'Acme', impersonationReadOnly: true, exp: Math.floor(NOW / 1000) + 125,
    });
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });
  afterEach(() => jest.useRealTimers());

  it('names the target person, their email and org, not a raw id', () => {
    render(<ImpersonationBanner />);
    expect(screen.getByText('Viewing as Dana Target')).toBeInTheDocument();
    expect(screen.getByText('(dana@acme.test)')).toBeInTheDocument();
    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(screen.queryByText('target-user')).not.toBeInTheDocument();
    expect(screen.getByText(/read-only/i)).toBeInTheDocument();
    expect(screen.getByText('req-123')).toBeInTheDocument();
  });

  it('falls back to the user id only when the token carries no name or email', () => {
    accessToken = token({ sub: 'target-user', impersonationReadOnly: true });
    requestId = null;
    render(<ImpersonationBanner />);
    expect(screen.getByText('Viewing as target-user')).toBeInTheDocument();
    expect(screen.queryByTestId('impersonation-countdown')).not.toBeInTheDocument();
  });

  it('counts down live to the token expiry, then says it expired', () => {
    render(<ImpersonationBanner />);
    const countdown = () => screen.getByTestId('impersonation-countdown');
    expect(countdown()).toHaveTextContent('Ends in 2:05');
    act(() => { jest.advanceTimersByTime(5000); });
    expect(countdown()).toHaveTextContent('Ends in 2:00');
    act(() => { jest.advanceTimersByTime(120_000); });
    expect(countdown()).toHaveTextContent('Session expired');
  });

  it('ends the session on the SERVER, not just in this browser', async () => {
    jest.useRealTimers();
    endImpersonation.mockResolvedValue(undefined);
    render(<ImpersonationBanner />);

    fireEvent.click(screen.getByRole('button', { name: /stop impersonating/i }));

    await waitFor(() => expect(endImpersonation).toHaveBeenCalled());
    // The browser-only stop would leave the session valid until its TTL.
    expect(stopImpersonation).not.toHaveBeenCalled();
  });

  it('shows progress while ending, so a slow revoke isn\'t mistaken for a dead button', async () => {
    jest.useRealTimers();
    endImpersonation.mockReturnValue(new Promise(() => { /* pending */ }));
    render(<ImpersonationBanner />);

    fireEvent.click(screen.getByRole('button', { name: /stop impersonating/i }));

    expect(await screen.findByText(/ending session/i)).toBeInTheDocument();
  });
});

describe('formatCountdown', () => {
  it('formats minutes and hours, never negative', () => {
    expect(formatCountdown(65_000)).toBe('1:05');
    expect(formatCountdown(3_725_000)).toBe('1:02:05');
    expect(formatCountdown(-5)).toBe('0:00');
  });
});
