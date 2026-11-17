// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The registration form validates the optional organization name against the
 * platform's `registerSchema` (min 2, max 100) before submitting, instead of
 * sending a 1-character name the server answers with a generic validation error.
 */

import { it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import RegisterPage from '../pages/auth/register';

jest.mock('next/router', () => require('./helpers/pageMocks').routerModule(() => ({ isReady: true, query: {}, push: jest.fn() })));
jest.mock('next/head', () => require('./helpers/pageMocks').headModule());
jest.mock('framer-motion', () => require('./helpers/pageMocks').motionModule());

const mockRegister = jest.fn<AnyFn>();
jest.mock('@/hooks/useAuth', () => require('./helpers/pageMocks').authModule(() => ({
  user: null, isInitialized: true, isSubmitting: false, register: mockRegister,
})));
jest.mock('@/hooks/useFeatures', () => ({ __esModule: true, useFeatures: () => ({ isEnabled: () => false }) }));
jest.mock('@/hooks/usePlans', () => ({ __esModule: true, usePlans: () => ({ plans: [] }) }));
jest.mock('@/lib/api', () => {
  const api = { listOAuthProviders: () => Promise.resolve({ data: { providers: [] } }) };
  return { __esModule: true, default: api, api };
});

beforeEach(() => {
  jest.clearAllMocks();
  mockRegister.mockResolvedValue(undefined);
});

async function fill(org: string) {
  // Inside act so the OAuth-provider read settles before the assertions.
  await act(async () => { render(<RegisterPage />); });
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'newbie' } });
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'new@example.com' } });
  fireEvent.change(screen.getByLabelText('Organization name'), { target: { value: org } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'Passw0rdPassw0rd' } });
  fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'Passw0rdPassw0rd' } });
}

it('blocks a 1-character organization name with a clear message', async () => {
  await fill(' A ');
  fireEvent.click(screen.getByRole('button', { name: /create account/i }));
  expect((await screen.findAllByText('Organization name must be at least 2 characters')).length).toBeGreaterThan(0);
  expect(mockRegister).not.toHaveBeenCalled();
});

it('flags it on blur too', async () => {
  await fill('A');
  fireEvent.blur(screen.getByLabelText('Organization name'));
  expect(screen.getByText('Organization name must be at least 2 characters')).toBeInTheDocument();
});

it('sends a valid name trimmed', async () => {
  await fill('  Acme  ');
  fireEvent.click(screen.getByRole('button', { name: /create account/i }));
  await waitFor(() => expect(mockRegister).toHaveBeenCalledWith('newbie', 'new@example.com', 'Passw0rdPassw0rd', 'Acme', undefined));
});

it('a blank organization name is fine (the field is optional)', async () => {
  await fill('   ');
  fireEvent.click(screen.getByRole('button', { name: /create account/i }));
  await waitFor(() => expect(mockRegister).toHaveBeenCalledWith('newbie', 'new@example.com', 'Passw0rdPassw0rd', undefined, undefined));
});
