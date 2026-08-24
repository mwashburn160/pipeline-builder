// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * AIProviderConfig step-up gating. Writing a provider API key (add/update/remove)
 * persists a per-org SECRET, so the PUT is step-up-gated server-side. The component
 * must NOT call the write API on the raw click — it opens a StepUpModal first and
 * only forwards the fresh token to `updateOrgAIConfig` once the user re-confirms.
 */

import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';

// StepUpModal → a stub that immediately confirms with a known token, so we can
// assert the token is threaded through to the write call.
jest.mock('@/components/admin/StepUpModal', () => ({
  __esModule: true,
  StepUpModal: ({ onConfirmed }: { onConfirmed: (t: string) => void }) => (
    <button data-testid="stepup-confirm" onClick={() => onConfirmed('stepup-tok')}>confirm</button>
  ),
}));

const getOrgAIConfig = jest.fn();
const updateOrgAIConfig = jest.fn();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getOrgAIConfig: (...a: unknown[]) => getOrgAIConfig(...a),
    updateOrgAIConfig: (...a: unknown[]) => updateOrgAIConfig(...a),
  },
  ApiError: class ApiError extends Error { statusCode = 0; },
}));

import { AIProviderConfig } from '../src/components/settings/AIProviderConfig';

beforeEach(() => {
  jest.clearAllMocks();
  getOrgAIConfig.mockResolvedValue({ data: { providers: {} } });
  updateOrgAIConfig.mockResolvedValue({ data: { providers: { openai: { configured: true, hint: '…abc' } } } });
});

describe('AIProviderConfig — step-up on secret write', () => {
  it('opens StepUpModal on Add and forwards the token to updateOrgAIConfig', async () => {
    await act(async () => { render(<AIProviderConfig canEdit />); });

    // Choose a provider + enter a key.
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'openai' } });
    fireEvent.change(screen.getByPlaceholderText(/enter api key/i), { target: { value: 'sk-secret' } });

    // Clicking Add must NOT write yet — it opens the step-up modal.
    fireEvent.click(screen.getByRole('button', { name: /^add$/i }));
    expect(updateOrgAIConfig).not.toHaveBeenCalled();
    expect(screen.getByTestId('stepup-confirm')).toBeInTheDocument();

    // Confirming step-up forwards the fresh token to the gated PUT.
    await act(async () => { fireEvent.click(screen.getByTestId('stepup-confirm')); });
    await waitFor(() => {
      expect(updateOrgAIConfig).toHaveBeenCalledWith({ openai: 'sk-secret' }, 'stepup-tok');
    });
  });

  it('does not write when the step-up modal is dismissed', async () => {
    await act(async () => { render(<AIProviderConfig canEdit />); });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'openai' } });
    fireEvent.change(screen.getByPlaceholderText(/enter api key/i), { target: { value: 'sk-secret' } });
    fireEvent.click(screen.getByRole('button', { name: /^add$/i }));
    // Modal shown, but never confirmed → no write.
    expect(screen.getByTestId('stepup-confirm')).toBeInTheDocument();
    expect(updateOrgAIConfig).not.toHaveBeenCalled();
  });
});
