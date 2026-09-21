// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * StepUpModal offers exactly the factors the account actually has, read from
 * `GET /user/profile`'s `authFactors` — and offers a passkey FIRST when there is
 * one, because it is the strongest option here and takes a touch rather than a
 * typed secret.
 *
 * The other half of the contract is what happens when a ceremony ends without a
 * credential: the browser reports a dismissed prompt as `NotAllowedError`, which
 * is a CANCEL. It must leave the modal open and silent, never show a red banner.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';

const getProfile = jest.fn<AnyFn>();
const stepUpVerify = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  ApiError: class ApiError extends Error { statusCode = 0; },
  default: {
    getProfile: (...a: unknown[]) => getProfile(...a),
    stepUpVerify: (...a: unknown[]) => stepUpVerify(...a),
  },
}));

const stepUpWithPasskey = jest.fn<AnyFn>();
jest.mock('@/lib/passkeys', () => ({
  __esModule: true,
  stepUpWithPasskey: (...a: unknown[]) => stepUpWithPasskey(...a),
}));

const runProviderReauth = jest.fn<AnyFn>();
jest.mock('@/lib/step-up-reauth', () => ({
  __esModule: true,
  runProviderReauth: (...a: unknown[]) => runProviderReauth(...a),
}));

import { StepUpModal } from '../src/components/admin/StepUpModal';

const factors = (over: Record<string, unknown> = {}) => ({
  hasPassword: false, passkeyCount: 0, hasTotp: false, providers: [], ...over,
});

const renderModal = async (authFactors: Record<string, unknown>, onConfirmed = jest.fn<AnyFn>()) => {
  getProfile.mockResolvedValue({ data: { user: { authFactors } } });
  await act(async () => {
    render(<StepUpModal action="Delete the org" onConfirmed={onConfirmed} onClose={jest.fn<AnyFn>()} />);
  });
  return onConfirmed;
};

beforeEach(() => {
  jest.clearAllMocks();
  stepUpVerify.mockResolvedValue({ success: true, data: { stepUpToken: 'pw-token' } });
  stepUpWithPasskey.mockResolvedValue('passkey-token');
});

describe('StepUpModal — which factors it offers', () => {
  it('offers only the password when that is all the account has', async () => {
    await renderModal(factors({ hasPassword: true }));
    expect(screen.getByPlaceholderText('Password')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /use a passkey/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sign in again with/i })).not.toBeInTheDocument();
  });

  it('offers a passkey when the account has one, alongside the password', async () => {
    await renderModal(factors({ hasPassword: true, passkeyCount: 2 }));
    expect(screen.getByRole('button', { name: /use a passkey/i })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Password')).toBeInTheDocument();
  });

  it('offers only the passkey for a passwordless account that has one', async () => {
    await renderModal(factors({ passkeyCount: 1 }));
    expect(screen.getByRole('button', { name: /use a passkey/i })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Password')).not.toBeInTheDocument();
  });

  it('offers provider re-auth for an account with neither a password nor a passkey', async () => {
    await renderModal(factors({ providers: [{ type: 'oauth', provider: 'google' }] }));
    expect(screen.getByRole('button', { name: /sign in again with google/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /use a passkey/i })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Password')).not.toBeInTheDocument();
  });

  it('points an account with NO factor at the passkey settings instead of a dead end', async () => {
    await renderModal(factors());
    expect(screen.getByText(/no way to confirm sensitive actions/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /security/i }))
      .toHaveAttribute('href', '/dashboard/security?tab=factors#passkeys');
  });
});

describe('StepUpModal — the passkey path', () => {
  it('hands the step-up token from the passkey ceremony to onConfirmed', async () => {
    const onConfirmed = await renderModal(factors({ passkeyCount: 1 }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /use a passkey/i })); });
    await waitFor(() => expect(onConfirmed).toHaveBeenCalledWith('passkey-token'));
  });

  it('stays silent when the person dismisses the browser prompt', async () => {
    stepUpWithPasskey.mockRejectedValue(Object.assign(new Error('The operation was not allowed'), { name: 'NotAllowedError' }));
    const onConfirmed = await renderModal(factors({ passkeyCount: 1 }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /use a passkey/i })); });
    await waitFor(() => expect(stepUpWithPasskey).toHaveBeenCalled());
    expect(onConfirmed).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // The modal is still usable — a cancel is not a failed attempt.
    expect(screen.getByRole('button', { name: /use a passkey/i })).toBeEnabled();
  });

  it('shows a real failure', async () => {
    stepUpWithPasskey.mockRejectedValue(new Error('Server said no'));
    await renderModal(factors({ passkeyCount: 1 }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /use a passkey/i })); });
    expect(await screen.findByText('Server said no')).toBeInTheDocument();
  });

  it('still confirms with the password when both are available', async () => {
    const onConfirmed = await renderModal(factors({ hasPassword: true, passkeyCount: 1 }));
    fireEvent.change(screen.getByPlaceholderText('Password'), { target: { value: 'hunter2' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^confirm$/i })); });
    await waitFor(() => expect(onConfirmed).toHaveBeenCalledWith('pw-token'));
    expect(stepUpWithPasskey).not.toHaveBeenCalled();
  });
});
