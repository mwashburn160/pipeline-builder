// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for StepUpModal — the password reverify dialog that gates every
 * destructive sysadmin action. The contract:
 *   - Posts the password to /api/auth/step-up.
 *   - On success, forwards the returned step-up token to onConfirmed.
 *   - On failure, shows the backend error message and stays open.
 */

import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { StepUpModal } from '../src/components/admin/StepUpModal';

const stepUpVerify = jest.fn();
jest.mock('../src/lib/api', () => ({
  __esModule: true,
  default: { stepUpVerify: (...args: unknown[]) => stepUpVerify(...args) },
}));

beforeEach(() => {
  stepUpVerify.mockReset();
});

describe('StepUpModal', () => {
  it('renders the action label so the user sees what they are gating', () => {
    render(<StepUpModal action="Delete organization acme" onConfirmed={jest.fn()} onClose={jest.fn()} />);
    expect(screen.getByText(/Delete organization acme/)).toBeInTheDocument();
  });

  it('disables Confirm while the password field is empty', () => {
    render(<StepUpModal action="Do thing" onConfirmed={jest.fn()} onClose={jest.fn()} />);
    const confirm = screen.getByRole('button', { name: /^confirm$/i });
    expect(confirm).toBeDisabled();
  });

  it('calls onConfirmed with the step-up token on success', async () => {
    stepUpVerify.mockResolvedValue({
      success: true,
      data: { ok: true, stepUpToken: 'jwt.token.value', expiresAt: 1700000000 },
    });
    const onConfirmed = jest.fn().mockResolvedValue(undefined);
    const onClose = jest.fn();
    render(<StepUpModal action="X" onConfirmed={onConfirmed} onClose={onClose} />);

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
    const onConfirmed = jest.fn();
    const onClose = jest.fn();
    render(<StepUpModal action="X" onConfirmed={onConfirmed} onClose={onClose} />);

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

  it('invokes onClose when Cancel is clicked', () => {
    const onClose = jest.fn();
    render(<StepUpModal action="X" onConfirmed={jest.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it('catches exceptions thrown by api.stepUpVerify and shows them', async () => {
    stepUpVerify.mockRejectedValue(new Error('network down'));
    render(<StepUpModal action="X" onConfirmed={jest.fn()} onClose={jest.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/password/i), { target: { value: 'p' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^confirm$/i }));
    });
    await waitFor(() => {
      expect(screen.getByText('network down')).toBeInTheDocument();
    });
  });
});
