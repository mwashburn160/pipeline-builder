// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * StepUpModal's authenticator-app option.
 *
 * It is offered whenever `authFactors.hasTotp` says the account has one, and it
 * sits AFTER the passkey and BEFORE the password — descending order of how hard
 * each factor is to steal. The field is not digit-constrained, because a
 * recovery code is accepted at the same endpoint.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';

const getProfile = jest.fn<AnyFn>();
const stepUpVerify = jest.fn<AnyFn>();
const stepUpWithTotp = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  ApiError: class ApiError extends Error { statusCode = 0; },
  default: {
    getProfile: (...a: unknown[]) => getProfile(...a),
    stepUpVerify: (...a: unknown[]) => stepUpVerify(...a),
    stepUpWithTotp: (...a: unknown[]) => stepUpWithTotp(...a),
  },
}));
jest.mock('@/lib/passkeys', () => ({ __esModule: true, stepUpWithPasskey: jest.fn<AnyFn>() }));
jest.mock('@/lib/step-up-reauth', () => ({ __esModule: true, runProviderReauth: jest.fn<AnyFn>() }));

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

const codeField = () => screen.getByLabelText('Authentication code');

beforeEach(() => {
  jest.clearAllMocks();
  stepUpVerify.mockResolvedValue({ success: true, data: { stepUpToken: 'pw-token' } });
  stepUpWithTotp.mockResolvedValue({ success: true, data: { stepUpToken: 'totp-token', via: 'totp' } });
});

describe('StepUpModal — which factors it offers', () => {
  it('offers the code field when the account has an authenticator', async () => {
    await renderModal(factors({ hasTotp: true }));
    expect(codeField()).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Password')).not.toBeInTheDocument();
  });

  it('does not offer it when the account has none', async () => {
    await renderModal(factors({ hasPassword: true }));
    expect(screen.queryByLabelText('Authentication code')).not.toBeInTheDocument();
  });

  it('offers it alongside a passkey and a password', async () => {
    await renderModal(factors({ hasPassword: true, hasTotp: true, passkeyCount: 1 }));
    expect(screen.getByRole('button', { name: /use a passkey/i })).toBeInTheDocument();
    expect(codeField()).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Password')).toBeInTheDocument();
  });

  it('stops calling an authenticator account a dead end', async () => {
    await renderModal(factors({ hasTotp: true }));
    expect(screen.queryByText(/no way to confirm sensitive actions/i)).not.toBeInTheDocument();
  });
});

describe('StepUpModal — the authenticator path', () => {
  it('hands the step-up token from a verified code to onConfirmed', async () => {
    const onConfirmed = await renderModal(factors({ hasTotp: true }));
    fireEvent.change(codeField(), { target: { value: '123456' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /verify/i })); });

    expect(stepUpWithTotp).toHaveBeenCalledWith('123456');
    await waitFor(() => expect(onConfirmed).toHaveBeenCalledWith('totp-token'));
  });

  it('accepts a recovery code at the same field', async () => {
    stepUpWithTotp.mockResolvedValue({ success: true, data: { stepUpToken: 'rec-token', via: 'recovery' } });
    const onConfirmed = await renderModal(factors({ hasTotp: true }));
    fireEvent.change(codeField(), { target: { value: 'ABCDE-FGHIJ' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /verify/i })); });

    expect(stepUpWithTotp).toHaveBeenCalledWith('ABCDE-FGHIJ');
    await waitFor(() => expect(onConfirmed).toHaveBeenCalledWith('rec-token'));
  });

  it('shows the server\'s wording for a rejected code and stays open', async () => {
    stepUpWithTotp.mockRejectedValue(new Error('That code isn\'t right. Check your authenticator app.'));
    const onConfirmed = await renderModal(factors({ hasTotp: true }));
    fireEvent.change(codeField(), { target: { value: '000000' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /verify/i })); });

    expect(await screen.findByText(/that code isn't right/i)).toBeInTheDocument();
    expect(onConfirmed).not.toHaveBeenCalled();
    expect(codeField()).toBeEnabled();
  });

  it('will not submit an empty code', async () => {
    await renderModal(factors({ hasTotp: true }));
    expect(screen.getByRole('button', { name: /verify/i })).toBeDisabled();
    expect(stepUpWithTotp).not.toHaveBeenCalled();
  });

  it('leaves the password path working when both are offered', async () => {
    const onConfirmed = await renderModal(factors({ hasPassword: true, hasTotp: true }));
    fireEvent.change(screen.getByPlaceholderText('Password'), { target: { value: 'hunter2' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^confirm$/i })); });

    await waitFor(() => expect(onConfirmed).toHaveBeenCalledWith('pw-token'));
    expect(stepUpWithTotp).not.toHaveBeenCalled();
  });
});
