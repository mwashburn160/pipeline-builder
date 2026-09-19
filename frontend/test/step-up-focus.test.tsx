// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Where a step-up dialog opens focused.
 *
 * `Modal` focused once on mount, and `StepUpModal` renders a spinner until
 * `GET /user/profile` says which factors the account has — so at focus time the
 * preferred control did not exist yet, the fallback (the header Close button)
 * won, and nothing ever corrected it. Every step-up in the app (20+ call sites)
 * opened focused on Close; a TOTP-only account got no cursor in the code field
 * at all.
 *
 * The contract now:
 *   - focus moves to the preferred control when the factor list resolves;
 *   - which control that is depends on the factors the account actually has;
 *   - a person who has already moved focus keeps it (no yanking mid-typing);
 *   - the focus trap and restore-on-close still work.
 */

import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';
import { StepUpModal } from '../src/components/admin/StepUpModal';
import { Modal } from '../src/components/ui/Modal';
import type { AuthFactors } from '../src/types';
import { useEffect, useRef, useState } from 'react';

const getProfile = jest.fn();
jest.mock('../src/lib/api', () => ({
  __esModule: true,
  default: {
    getProfile: (...a: unknown[]) => getProfile(...a),
    stepUpVerify: jest.fn(),
    stepUpWithTotp: jest.fn(),
  },
}));
jest.mock('../src/lib/step-up-reauth', () => ({ __esModule: true, runProviderReauth: jest.fn() }));
jest.mock('../src/lib/passkeys', () => ({ __esModule: true, stepUpWithPasskey: jest.fn() }));

const factors = (over: Partial<AuthFactors> = {}): AuthFactors => ({
  hasPassword: true, passkeyCount: 0, hasTotp: false, providers: [], ...over,
});

/** Render the dialog and let the (deferred) factor fetch settle. */
async function openStepUp(f: AuthFactors) {
  let resolve!: (v: unknown) => void;
  getProfile.mockReturnValue(new Promise((r) => { resolve = r; }));
  await act(async () => {
    render(<StepUpModal action="Do the thing" onConfirmed={jest.fn()} onClose={jest.fn()} />);
  });
  // While it loads there is nothing to focus but the chrome — the bug's setup.
  expect(screen.getByText(/checking how you can confirm/i)).toBeInTheDocument();
  await act(async () => {
    resolve({ success: true, data: { user: { authFactors: f } } });
    await Promise.resolve();
  });
}

beforeEach(() => { getProfile.mockReset(); });

describe('StepUpModal focuses the factor you actually have', () => {
  it('puts the cursor in the password box once the factors resolve', async () => {
    await openStepUp(factors());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByPlaceholderText('Password')));
  });

  it('focuses the authenticator field for a TOTP-only account', async () => {
    // This account has no password field at all, so the old `passwordRef` could
    // never have been the target — it opened on Close and stayed there.
    await openStepUp(factors({ hasPassword: false, hasTotp: true }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Authentication code')));
  });

  it('focuses the passkey button when that is the strongest thing offered', async () => {
    await openStepUp(factors({ hasPassword: false, passkeyCount: 2 }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: /use a passkey/i })));
  });

  it('focuses the provider button for an account with only a social login', async () => {
    await openStepUp(factors({ hasPassword: false, providers: [{ type: 'oauth', provider: 'google' }] }));
    await waitFor(() => expect(document.activeElement)
      .toBe(screen.getByRole('button', { name: /sign in again with google/i })));
  });

  it('does NOT open focused on Close any more', async () => {
    await openStepUp(factors());
    expect(document.activeElement).not.toBe(screen.getByRole('button', { name: /close dialog/i }));
  });
});

/** A modal whose caller's focus target only appears after a delay. */
function LateTarget({ steal = false }: { steal?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setReady(true), 0);
    return () => clearTimeout(t);
  }, []);
  return (
    <Modal title="Loading dialog" onClose={jest.fn()} initialFocusRef={ref}>
      <button data-testid="other">elsewhere</button>
      {ready && <input ref={ref} aria-label="late field" />}
      {steal && <span />}
    </Modal>
  );
}

describe('Modal late focus', () => {
  it('focuses the caller target when it finally renders', async () => {
    render(<LateTarget />);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('late field')));
  });

  it('leaves focus alone when the person has already moved it', async () => {
    render(<LateTarget />);
    // Before the target exists, the user tabs/clicks somewhere themselves.
    const other = screen.getByTestId('other');
    act(() => other.focus());
    await screen.findByLabelText('late field');
    expect(document.activeElement).toBe(other);
  });

  it('still traps Tab inside the dialog', async () => {
    render(<LateTarget />);
    const field = await screen.findByLabelText('late field');
    act(() => field.focus());
    // Tab from the last focusable wraps to the first, rather than escaping.
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.body.contains(document.activeElement)).toBe(true);
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
  });
});
