// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The recovery-code count is never stated before it is known. The panel read
 * its "0 of 0" placeholder while loading and after a failed read — telling a
 * passkey-only account it had no way back in, on the panel meant to prevent it.
 */

import { it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, act } from '@testing-library/react';

const getRecoveryCodeStatus = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getRecoveryCodeStatus: (...a: unknown[]) => getRecoveryCodeStatus(...a),
    getTotpStatus: async () => ({ success: true, data: { totp: { enabled: false } } }),
  },
}));
const toast = { success: jest.fn<AnyFn>(), error: jest.fn<AnyFn>(), warning: jest.fn<AnyFn>(), info: jest.fn<AnyFn>() };
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule(() => toast));
jest.mock('@/hooks/useAuth', () => require('./helpers/pageMocks').authModule(() => ({ refreshUser: jest.fn<AnyFn>() })));
jest.mock('@/components/admin/StepUpModal', () => ({ __esModule: true, StepUpModal: () => null }));

import { AccountRecoveryCodes } from '../src/components/settings/RecoveryCodes';
import { clearQueryCache } from '../src/lib/query-cache';

beforeEach(() => { jest.clearAllMocks(); clearQueryCache(); });

it('shows no count while loading', async () => {
  getRecoveryCodeStatus.mockReturnValue(new Promise(() => undefined));
  await act(async () => { render(<AccountRecoveryCodes readOnly={false} />); });
  expect(screen.queryByText(/0 of 0/)).not.toBeInTheDocument();
  expect(screen.queryByText(/no recovery codes left/i)).not.toBeInTheDocument();
});

it('offers a retry, not a zero, when the count fails to load', async () => {
  getRecoveryCodeStatus.mockRejectedValue(new Error('status down'));
  await act(async () => { render(<AccountRecoveryCodes readOnly={false} />); });
  expect(await screen.findByRole('button', { name: /retry/i })).toBeInTheDocument();
  expect(screen.queryByText(/0 of 0/)).not.toBeInTheDocument();
});

it('states the count once it is known', async () => {
  getRecoveryCodeStatus.mockResolvedValue({ success: true, data: { recoveryCodes: { remaining: 3, total: 10, generatedAt: null } } });
  await act(async () => { render(<AccountRecoveryCodes readOnly={false} />); });
  expect(await screen.findByText('3 of 10')).toBeInTheDocument();
});
