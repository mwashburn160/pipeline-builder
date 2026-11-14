// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Forgot password, end to end in the UI:
 * - `/auth/forgot-password` posts `POST /auth/password/reset-request` and shows
 *   the platform's one non-enumerating sentence whatever the account state;
 * - `/auth/reset-password?token=…` posts `POST /auth/password/reset` and maps
 *   each refusal to what the person can do next.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ApiError } from '../src/lib/api/errors';

let query: Record<string, string> = {};
let isReady = true;
jest.mock('next/router', () => require('./helpers/pageMocks').routerModule(() => ({ isReady, query, pathname: '/auth/reset-password' })));

const requestPasswordReset = jest.fn<AnyFn>();
const resetPassword = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    requestPasswordReset: (...a: unknown[]) => requestPasswordReset(...a),
    resetPassword: (...a: unknown[]) => resetPassword(...a),
  },
}));

import ForgotPasswordPage from '../pages/auth/forgot-password';
import ResetPasswordPage from '../pages/auth/reset-password';

const TOKEN = 'a'.repeat(64);
const GOOD = 'NewPassw0rd';

beforeEach(() => {
  jest.clearAllMocks();
  query = {};
  isReady = true;
  requestPasswordReset.mockResolvedValue({ success: true, message: 'ignored' });
  resetPassword.mockResolvedValue({ success: true, data: { accessKeysRevoked: 0 } });
});

describe('forgot-password page', () => {
  it('posts the email and shows the non-enumerating answer', async () => {
    render(<ForgotPasswordPage />);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: ' jane@acme.com ' } });
    fireEvent.click(screen.getByRole('button', { name: /send reset link/i }));
    await waitFor(() => expect(requestPasswordReset).toHaveBeenCalledWith('jane@acme.com'));
    expect(await screen.findByText(/If an account with that email can reset its password/i)).toBeInTheDocument();
  });

  it('prefills the address the sign-in card passed along', async () => {
    query = { email: 'jane@acme.com' };
    render(<ForgotPasswordPage />);
    await waitFor(() => expect(screen.getByLabelText('Email')).toHaveValue('jane@acme.com'));
  });

  it('says to wait on a 429', async () => {
    requestPasswordReset.mockRejectedValue(new ApiError('Too many requests', 429, 'RATE_LIMIT_EXCEEDED'));
    render(<ForgotPasswordPage />);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'jane@acme.com' } });
    fireEvent.click(screen.getByRole('button', { name: /send reset link/i }));
    expect(await screen.findByText(/Too many reset requests/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send reset link/i })).toBeInTheDocument();
  });

  it('shows any other failure (e.g. unreachable server)', async () => {
    requestPasswordReset.mockRejectedValue(new ApiError('Could not reach the server', 0, 'NETWORK_ERROR'));
    render(<ForgotPasswordPage />);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'jane@acme.com' } });
    fireEvent.click(screen.getByRole('button', { name: /send reset link/i }));
    expect(await screen.findByText(/Could not reach the server/i)).toBeInTheDocument();
  });
});

const fill = (pw: string, confirm = pw) => {
  fireEvent.change(screen.getByLabelText('New password'), { target: { value: pw } });
  fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: confirm } });
  fireEvent.click(screen.getByRole('button', { name: /reset password/i }));
};

describe('reset-password page', () => {
  it('treats a missing or malformed token as a dead link without calling the API', () => {
    query = { token: 'not-a-token' };
    render(<ResetPasswordPage />);
    expect(screen.getByText(/invalid or has expired/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /request a new link/i })).toHaveAttribute('href', '/auth/forgot-password');
    expect(resetPassword).not.toHaveBeenCalled();
  });

  it('waits for the router before judging the token', () => {
    isReady = false;
    render(<ResetPasswordPage />);
    expect(screen.queryByText(/invalid or has expired/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('New password')).not.toBeInTheDocument();
  });

  it('checks length and match before posting', () => {
    query = { token: TOKEN };
    render(<ResetPasswordPage />);
    fill('short');
    expect(screen.getByText('Use at least 8 characters.')).toBeInTheDocument();
    fill(GOOD, `${GOOD}x`);
    expect(screen.getByText(/do not match/i)).toBeInTheDocument();
    expect(resetPassword).not.toHaveBeenCalled();
  });

  it('resets and says how many access keys were revoked', async () => {
    query = { token: TOKEN };
    resetPassword.mockResolvedValue({ success: true, data: { accessKeysRevoked: 2 } });
    render(<ResetPasswordPage />);
    fill(GOOD);
    await waitFor(() => expect(resetPassword).toHaveBeenCalledWith(TOKEN, GOOD));
    expect(await screen.findByText('Password reset')).toBeInTheDocument();
    expect(screen.getByText(/signed out everywhere and 2 access keys were revoked/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^sign in$/i })).toHaveAttribute('href', '/');
  });

  it('the success line is singular for one key, and plain with none', async () => {
    query = { token: TOKEN };
    resetPassword.mockResolvedValue({ success: true, data: { accessKeysRevoked: 1 } });
    const { unmount } = render(<ResetPasswordPage />);
    fill(GOOD);
    expect(await screen.findByText(/1 access key was revoked/i)).toBeInTheDocument();
    unmount();

    resetPassword.mockResolvedValue({ success: true, data: {} });
    render(<ResetPasswordPage />);
    fill(GOOD);
    expect(await screen.findByText(/^You were signed out everywhere\.$/i)).toBeInTheDocument();
  });

  it('PASSWORD_RESET_TOKEN_INVALID → offer a new link', async () => {
    query = { token: TOKEN };
    resetPassword.mockRejectedValue(new ApiError('This reset link is invalid or has expired. Request a new one.', 400, 'PASSWORD_RESET_TOKEN_INVALID'));
    render(<ResetPasswordPage />);
    fill(GOOD);
    expect(await screen.findByRole('link', { name: /request a new link/i })).toBeInTheDocument();
  });

  it('SSO_REQUIRED → point at single sign-on', async () => {
    query = { token: TOKEN };
    resetPassword.mockRejectedValue(new ApiError('Your organization requires single sign-on (SSO).', 403, 'SSO_REQUIRED'));
    render(<ResetPasswordPage />);
    fill(GOOD);
    expect(await screen.findByText(/Your organization requires SSO/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /go to sign in/i })).toHaveAttribute('href', '/');
  });

  it.each([
    ['PASSWORD_UNCHANGED', 'Choose a password different from your current one'],
    ['PASSWORD_TOO_SHORT_FOR_ORG', 'Your organization requires at least 14 characters'],
    ['PASSWORD_BREACHED', 'That password has appeared in a data breach'],
  ])('%s keeps the form (the link is still good) and shows why', async (code, message) => {
    query = { token: TOKEN };
    resetPassword.mockRejectedValue(new ApiError(message, 400, code));
    render(<ResetPasswordPage />);
    fill(GOOD);
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByLabelText('New password')).toBeInTheDocument();
  });
});
