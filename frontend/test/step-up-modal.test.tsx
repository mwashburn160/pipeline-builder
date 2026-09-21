// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for StepUpModal — the re-verify dialog that gates every destructive
 * sysadmin action. The contract:
 *   - Reads the account's factors from GET /user/profile and offers ONLY those:
 *     a password field for accounts that have one, a "Sign in again with X"
 *     button per linked provider (the only step-up a Google/GitHub/SSO account
 *     has), and an explanation when the account has neither.
 *   - Password: posts to /api/auth/step-up and forwards the token to onConfirmed.
 *   - Provider: runs the popup re-auth and forwards the token it returns.
 *   - On failure, shows the message and stays open; Cancel aborts.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { StepUpModal } from '../src/components/admin/StepUpModal';
import type { AuthFactors } from '../src/types';

const stepUpVerify = jest.fn<AnyFn>();
const getProfile = jest.fn<AnyFn>();
jest.mock('../src/lib/api', () => ({
  __esModule: true,
  default: {
    stepUpVerify: (...args: unknown[]) => stepUpVerify(...args),
    getProfile: (...args: unknown[]) => getProfile(...args),
  },
}));

const runProviderReauth = jest.fn<AnyFn>();
jest.mock('../src/lib/step-up-reauth', () => ({
  __esModule: true,
  runProviderReauth: (...args: unknown[]) => runProviderReauth(...args),
}));

const factors = (over: Partial<AuthFactors> = {}): AuthFactors => ({
  hasPassword: true, passkeyCount: 0, hasTotp: false, providers: [], ...over,
});

/** Render and let the factor fetch settle. */
async function renderModal(props: Partial<Parameters<typeof StepUpModal>[0]> = {}) {
  const onConfirmed = props.onConfirmed ?? jest.fn<AnyFn>();
  const onClose = props.onClose ?? jest.fn<AnyFn>();
  await act(async () => {
    render(<StepUpModal action={props.action ?? 'X'} onConfirmed={onConfirmed} onClose={onClose} />);
  });
  return { onConfirmed, onClose };
}

beforeEach(() => {
  stepUpVerify.mockReset();
  runProviderReauth.mockReset();
  getProfile.mockReset();
  getProfile.mockResolvedValue({ success: true, data: { user: { authFactors: factors() } } });
});

describe('StepUpModal', () => {
  it('renders the action label so the user sees what they are gating', async () => {
    await renderModal({ action: 'Delete organization acme' });
    expect(screen.getByText(/Delete organization acme/)).toBeInTheDocument();
  });

  it('disables Confirm while the password field is empty', async () => {
    await renderModal();
    expect(screen.getByRole('button', { name: /^confirm$/i })).toBeDisabled();
  });

  it('calls onConfirmed with the step-up token on success', async () => {
    stepUpVerify.mockResolvedValue({
      success: true,
      data: { ok: true, stepUpToken: 'jwt.token.value', expiresAt: 1700000000 },
    });
    const { onConfirmed, onClose } = await renderModal({ onConfirmed: jest.fn<AnyFn>().mockResolvedValue(undefined) });

    fireEvent.change(screen.getByPlaceholderText(/password/i), { target: { value: 'hunter2' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^confirm$/i }));
    });

    expect(stepUpVerify).toHaveBeenCalledWith('hunter2');
    expect(onConfirmed).toHaveBeenCalledWith('jwt.token.value');
    expect(onClose).toHaveBeenCalled();
  });

  it('surfaces the backend error message and does NOT invoke onConfirmed', async () => {
    stepUpVerify.mockResolvedValue({ success: false, message: 'Invalid password' });
    const { onConfirmed, onClose } = await renderModal();

    fireEvent.change(screen.getByPlaceholderText(/password/i), { target: { value: 'wrong' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^confirm$/i }));
    });

    await waitFor(() => {
      expect(screen.getByText('Invalid password')).toBeInTheDocument();
    });
    expect(onConfirmed).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('invokes onClose when Cancel is clicked', async () => {
    const { onClose } = await renderModal();
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it('catches exceptions thrown by api.stepUpVerify and shows them', async () => {
    stepUpVerify.mockRejectedValue(new Error('network down'));
    await renderModal();
    fireEvent.change(screen.getByPlaceholderText(/password/i), { target: { value: 'p' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^confirm$/i }));
    });
    await waitFor(() => {
      expect(screen.getByText('network down')).toBeInTheDocument();
    });
  });

  it('falls back to the password field when the profile cannot be read', async () => {
    getProfile.mockRejectedValue(new Error('offline'));
    await renderModal();
    expect(screen.getByPlaceholderText(/password/i)).toBeInTheDocument();
  });
});

describe('StepUpModal — factor choices', () => {
  it('offers only the linked provider for a passwordless (social) account', async () => {
    getProfile.mockResolvedValue({
      success: true,
      data: { user: { authFactors: factors({ hasPassword: false, providers: [{ type: 'oauth', provider: 'google' }] }) } },
    });
    await renderModal();

    expect(screen.queryByPlaceholderText(/password/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^confirm$/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in again with google/i })).toBeInTheDocument();
  });

  it('offers both the password and each provider when the account has both', async () => {
    getProfile.mockResolvedValue({
      success: true,
      data: {
        user: {
          authFactors: factors({
            providers: [
              { type: 'oauth', provider: 'github' },
              { type: 'sso', provider: 'generic-oidc', orgId: 'org1', orgName: 'Acme' },
            ],
          }),
        },
      },
    });
    await renderModal();

    expect(screen.getByPlaceholderText(/password/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in again with github/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in again with acme single sign-on/i })).toBeInTheDocument();
  });

  it('explains itself when the account has no factor at all', async () => {
    getProfile.mockResolvedValue({
      success: true,
      data: { user: { authFactors: factors({ hasPassword: false }) } },
    });
    await renderModal();

    expect(screen.getByText(/no way to confirm sensitive actions/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sign in again/i })).not.toBeInTheDocument();
  });

  it('forwards the token from a provider re-auth to onConfirmed', async () => {
    getProfile.mockResolvedValue({
      success: true,
      data: { user: { authFactors: factors({ hasPassword: false, providers: [{ type: 'oauth', provider: 'google' }] }) } },
    });
    runProviderReauth.mockResolvedValue('reauth.stepup.token');
    const { onConfirmed, onClose } = await renderModal({ onConfirmed: jest.fn<AnyFn>().mockResolvedValue(undefined) });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /sign in again with google/i }));
    });

    expect(runProviderReauth).toHaveBeenCalledWith({ type: 'oauth', provider: 'google' }, expect.anything());
    expect(onConfirmed).toHaveBeenCalledWith('reauth.stepup.token');
    expect(onClose).toHaveBeenCalled();
  });

  it('shows a failed provider re-auth and stays open', async () => {
    getProfile.mockResolvedValue({
      success: true,
      data: { user: { authFactors: factors({ hasPassword: false, providers: [{ type: 'sso', provider: 'generic-oidc', orgId: 'org1' }] }) } },
    });
    runProviderReauth.mockRejectedValue(new Error('Allow pop-ups for this site to confirm with your sign-in provider.'));
    const { onConfirmed, onClose } = await renderModal();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /sign in again with single sign-on/i }));
    });

    await waitFor(() => expect(screen.getByText(/allow pop-ups/i)).toBeInTheDocument());
    expect(onConfirmed).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('aborts an in-flight provider re-auth when the dialog is cancelled', async () => {
    getProfile.mockResolvedValue({
      success: true,
      data: { user: { authFactors: factors({ hasPassword: false, providers: [{ type: 'oauth', provider: 'google' }] }) } },
    });
    let signal: AbortSignal | undefined;
    runProviderReauth.mockImplementation((_opt: unknown, s: AbortSignal) => {
      signal = s;
      return new Promise(() => { /* never settles until aborted */ });
    });
    const { onClose } = await renderModal();

    fireEvent.click(screen.getByRole('button', { name: /sign in again with google/i }));
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(signal?.aborted).toBe(true);
    expect(onClose).toHaveBeenCalled();
  });
});
