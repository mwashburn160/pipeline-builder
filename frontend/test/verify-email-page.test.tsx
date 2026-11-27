// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `/auth/verify-email?token=…`: the single-use token is verified exactly once
 * (not again on a re-render / strict-mode re-run), and every outcome — success,
 * a refused or expired token, a network failure, no token at all — lands on a
 * clear terminal state.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { mockRouter } from './helpers/pageMocks';
import { apiFn, resetApiMock } from './helpers/apiMock';

jest.mock('@/lib/api', () => require('./helpers/apiMock').apiMockModule());
jest.mock('next/router', () => require('./helpers/pageMocks').routerModule());
jest.mock('next/head', () => require('./helpers/pageMocks').headModule());

import VerifyEmailPage from '../pages/auth/verify-email';

beforeEach(() => { resetApiMock(); });

describe('verify-email page', () => {
  it('verifies the token once and shows success with the server message', async () => {
    mockRouter({ query: { token: 'tok-1' } });
    apiFn('verifyEmail').mockResolvedValue({ success: true, message: 'Thanks — verified.' });
    const { rerender } = render(<StrictMode><VerifyEmailPage /></StrictMode>);
    expect(screen.getByText('Verifying your email…')).toBeInTheDocument();
    expect(await screen.findByText('Email verified')).toBeInTheDocument();
    expect(screen.getByText('Thanks — verified.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to dashboard' })).toHaveAttribute('href', '/dashboard');
    rerender(<StrictMode><VerifyEmailPage /></StrictMode>);
    expect(apiFn('verifyEmail')).toHaveBeenCalledTimes(1);
    expect(apiFn('verifyEmail')).toHaveBeenCalledWith('tok-1');
  });

  it('a success without a message uses the default copy', async () => {
    mockRouter({ query: { token: 'tok-1' } });
    apiFn('verifyEmail').mockResolvedValue({ success: true });
    render(<VerifyEmailPage />);
    expect(await screen.findByText('Your email has been verified.')).toBeInTheDocument();
  });

  it('a refused token and a thrown request are failures with a resend link', async () => {
    mockRouter({ query: { token: 'old' } });
    apiFn('verifyEmail').mockResolvedValueOnce({ success: false });
    const { unmount } = render(<VerifyEmailPage />);
    expect(await screen.findByText('This verification link is invalid or has expired.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Resend from settings' })).toHaveAttribute('href', '/dashboard/settings?tab=profile');
    unmount();
    apiFn('verifyEmail').mockRejectedValueOnce(new Error('Token already used'));
    render(<VerifyEmailPage />);
    expect(await screen.findByText(/Token already used/)).toBeInTheDocument();
    expect(screen.getByText('Verification failed')).toBeInTheDocument();
  });

  it('no token in the link fails without calling the API; it waits for the router', async () => {
    mockRouter({ query: {}, isReady: false });
    const { rerender } = render(<VerifyEmailPage />);
    expect(screen.getByText('Verifying your email…')).toBeInTheDocument();
    mockRouter({ query: { token: ['a', 'b'] }, isReady: true });
    rerender(<VerifyEmailPage />);
    expect(await screen.findByText('No verification token was provided in the link.')).toBeInTheDocument();
    expect(apiFn('verifyEmail')).not.toHaveBeenCalled();
  });
});
