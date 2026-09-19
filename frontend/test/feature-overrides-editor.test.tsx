// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for FeatureOverridesEditor — the per-user feature-flag editor.
 *
 * Contract: each row reflects the current state (inherit/on/off), the
 * Save button only enables when state diverges from initial, and on
 * Save the *diff* is computed correctly (inherit means "remove the
 * override key", not "send false").
 */

import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { FeatureOverridesEditor } from '../src/components/admin/FeatureOverridesEditor';

const updateUserFeatures = jest.fn();
jest.mock('../src/lib/api', () => ({
  __esModule: true,
  default: { updateUserFeatures: (...args: unknown[]) => updateUserFeatures(...args) },
}));

// Minimal StepUpModal: one button that "confirms the password" with a fixed token.
jest.mock('../src/components/admin/StepUpModal', () => ({
  __esModule: true,
  StepUpModal: ({ onConfirmed }: { onConfirmed: (t: string) => void }) => (
    <button type="button" onClick={() => onConfirmed('step-up-token')}>Confirm password</button>
  ),
}));

beforeEach(() => {
  updateUserFeatures.mockReset();
});

/** Click Save, then confirm the password check. */
async function saveWithStepUp() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /save overrides/i }));
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /confirm password/i }));
  });
}

describe('FeatureOverridesEditor', () => {
  it('renders one row per feature flag', () => {
    render(<FeatureOverridesEditor userId="u1" initial={{}} onSaved={jest.fn()} />);
    // ALL_FEATURE_FLAGS has 5 entries — one row each.
    expect(screen.getByLabelText(/Override Priority Support/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Override AI Generation/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Override Bulk Operations/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Override Custom Integrations/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Override Custom Integrations/i)).toBeInTheDocument();
  });

  it('disables Save when state is identical to initial', () => {
    render(<FeatureOverridesEditor userId="u1" initial={{ ai_generation: true }} onSaved={jest.fn()} />);
    expect(screen.getByRole('button', { name: /save overrides/i })).toBeDisabled();
  });

  it('reflects initial values in the selects', () => {
    render(
      <FeatureOverridesEditor
        userId="u1"
        initial={{ ai_generation: true, custom_integrations: false }}
        onSaved={jest.fn()}
      />,
    );
    expect((screen.getByLabelText(/Override AI Generation/i) as HTMLSelectElement).value).toBe('on');
    expect((screen.getByLabelText(/Override Custom Integrations/i) as HTMLSelectElement).value).toBe('off');
    expect((screen.getByLabelText(/Override Priority Support/i) as HTMLSelectElement).value).toBe('inherit');
  });

  it('enables Save once a row is changed', () => {
    render(<FeatureOverridesEditor userId="u1" initial={{}} onSaved={jest.fn()} />);
    fireEvent.change(screen.getByLabelText(/Override AI Generation/i), { target: { value: 'on' } });
    expect(screen.getByRole('button', { name: /save overrides/i })).toBeEnabled();
  });

  it('sends only the explicit overrides (inherit rows are dropped from the payload)', async () => {
    updateUserFeatures.mockResolvedValue({ success: true });
    const onSaved = jest.fn();
    render(<FeatureOverridesEditor userId="user-42" initial={{}} onSaved={onSaved} />);

    fireEvent.change(screen.getByLabelText(/Override AI Generation/i), { target: { value: 'on' } });
    fireEvent.change(screen.getByLabelText(/Override Custom Integrations/i), { target: { value: 'off' } });
    // Priority Support stays at inherit — must not appear in the payload.

    // Nothing is sent until the password check is confirmed.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /save overrides/i }));
    });
    expect(updateUserFeatures).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /confirm password/i }));
    });

    expect(updateUserFeatures).toHaveBeenCalledWith('user-42', {
      ai_generation: true,
      custom_integrations: false,
    }, 'step-up-token');
    expect(onSaved).toHaveBeenCalled();
  });

  it('removes an override by switching it back to inherit', async () => {
    updateUserFeatures.mockResolvedValue({ success: true });
    render(<FeatureOverridesEditor userId="u1" initial={{ ai_generation: true }} onSaved={jest.fn()} />);

    fireEvent.change(screen.getByLabelText(/Override AI Generation/i), { target: { value: 'inherit' } });
    await saveWithStepUp();

    // The inherit transition produces an empty payload — the key is dropped.
    expect(updateUserFeatures).toHaveBeenCalledWith('u1', {}, 'step-up-token');
  });

  it('shows the backend error message on a failed save', async () => {
    updateUserFeatures.mockResolvedValue({ success: false, message: 'Invalid override' });
    render(<FeatureOverridesEditor userId="u1" initial={{}} onSaved={jest.fn()} />);

    fireEvent.change(screen.getByLabelText(/Override Bulk Operations/i), { target: { value: 'on' } });
    await saveWithStepUp();

    await waitFor(() => {
      expect(screen.getByText('Invalid override')).toBeInTheDocument();
    });
  });
});
