// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A step-up-gated ecosystem action with a REQUIRED reason checks the reason
 * before the step-up, not after: the old order spent the single-use token (and
 * the person's passkey touch or code) on a request that could only be refused.
 */

import { it, expect, jest } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const stepUpVerify = jest.fn<AnyFn>(async () => ({ success: true, data: { stepUpToken: 'tok' } }));
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getProfile: async () => ({ success: true, data: { user: { authFactors: { hasPassword: true, passkeyCount: 0, hasTotp: false, providers: [] } } } }),
    stepUpVerify: (...a: unknown[]) => stepUpVerify(...a),
  },
}));

import { EcosystemActionDialog } from '../src/components/ecosystem/EcosystemActionDialog';

it('disables every way to confirm until the required reason is filled in', async () => {
  const onSubmit = jest.fn<AnyFn>(async () => undefined);
  render(<EcosystemActionDialog title="Withdraw?" action="Withdraw it" reasonLabel="Reason" reasonRequired stepUp onSubmit={onSubmit} onClose={() => undefined} />);
  const password = await screen.findByPlaceholderText('Password');
  fireEvent.change(password, { target: { value: 'hunter2' } });
  expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled();
  expect(screen.getByTestId('step-up-blocked')).toHaveTextContent('Enter reason first.');

  fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: 'Superseded' } });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
  await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('Superseded', 'tok'));
  expect(stepUpVerify).toHaveBeenCalledTimes(1);
});
