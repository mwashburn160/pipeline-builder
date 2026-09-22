// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The passkey panel (Settings → Security → Passkeys).
 *
 * The properties worth pinning are the ones a person's ability to sign in
 * depends on: adding and removing go through step-up (never a bare click), the
 * server's "this is your only way in" refusal is shown rather than re-derived,
 * an impersonated (read-only) session offers no writes at all, and a browser
 * with no WebAuthn gets no panel instead of buttons that can only fail.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';

const listPasskeys = jest.fn<AnyFn>();
const renamePasskey = jest.fn<AnyFn>();
const deletePasskey = jest.fn<AnyFn>();
const toastError = jest.fn<AnyFn>();
const toastSuccess = jest.fn<AnyFn>();
const beginPasskeyRegistration = jest.fn<AnyFn>();
const finishPasskeyRegistration = jest.fn<AnyFn>();
const PENDING = { ceremonyId: 'c1', options: { challenge: 'x' } };
const getRecoveryCodeStatus = jest.fn<AnyFn>();
const getTotpStatus = jest.fn<AnyFn>();
const regenerateRecoveryCodes = jest.fn<AnyFn>();
let webauthnSupported = true;

jest.mock('@/lib/api', () => ({
  __esModule: true,
  ApiError: class ApiError extends Error { statusCode = 0; },
  default: {
    listPasskeys: (...a: unknown[]) => listPasskeys(...a),
    renamePasskey: (...a: unknown[]) => renamePasskey(...a),
    deletePasskey: (...a: unknown[]) => deletePasskey(...a),
    getRecoveryCodeStatus: (...a: unknown[]) => getRecoveryCodeStatus(...a),
    getTotpStatus: (...a: unknown[]) => getTotpStatus(...a),
    regenerateRecoveryCodes: (...a: unknown[]) => regenerateRecoveryCodes(...a),
  },
}));
jest.mock('@/lib/passkeys', () => ({
  __esModule: true,
  browserSupportsWebAuthn: () => webauthnSupported,
  beginPasskeyRegistration: (...a: unknown[]) => beginPasskeyRegistration(...a),
  finishPasskeyRegistration: (...a: unknown[]) => finishPasskeyRegistration(...a),
}));
// One STABLE object: the real `useToast` memoizes, and `useLoadable`'s `reload`
// depends on it — a fresh object per render would re-run the load effect forever.
const toast = { success: toastSuccess, error: toastError, warning: jest.fn<AnyFn>(), info: jest.fn<AnyFn>() };
jest.mock('@/components/ui/Toast', () => ({ __esModule: true, useToast: () => toast }));
// Step-up has its own suite; here it only needs to hand a token back so the
// gated call can be asserted.
jest.mock('@/components/admin/StepUpModal', () => ({
  __esModule: true,
  StepUpModal: ({ onConfirmed }: { onConfirmed: (t: string) => void }) => (
    <button data-testid="stepup-modal" onClick={() => onConfirmed('step-up-token')}>confirm</button>
  ),
}));
// Enrolling/removing/renaming a factor changes `user.authFactors`, which the
// posture strip above this panel reads — so the panel refreshes the profile.
const refreshUser = jest.fn<AnyFn>(async () => undefined);
jest.mock('@/hooks/useAuth', () => ({ __esModule: true, useAuth: () => ({ refreshUser }) }));

import { PasskeySection } from '../src/components/settings/PasskeySection';
import { clearQueryCache } from '../src/lib/query-cache';

const passkey = (over: Record<string, unknown> = {}) => ({
  id: 'pk1',
  name: 'MacBook Touch ID',
  createdAt: new Date(Date.now() - 86_400_000).toISOString(),
  lastUsedAt: null,
  backedUp: true,
  transports: ['internal'],
  ...over,
});

const renderSection = async (readOnly = false) => {
  await act(async () => { render(<PasskeySection readOnly={readOnly} />); });
};

beforeEach(() => {
  jest.clearAllMocks();
  // The TOTP status is read through the shared cache, which outlives a test.
  clearQueryCache();
  webauthnSupported = true;
  listPasskeys.mockResolvedValue({ success: true, data: { passkeys: [passkey()] } });
  beginPasskeyRegistration.mockResolvedValue(PENDING);
  finishPasskeyRegistration.mockResolvedValue({ passkey: passkey({ id: 'pk2', name: 'New key' }) });
  getRecoveryCodeStatus.mockResolvedValue({ success: true, data: { recoveryCodes: { remaining: 8, total: 10, generatedAt: null } } });
  getTotpStatus.mockResolvedValue({ success: true, data: { totp: { enabled: false } } });
  regenerateRecoveryCodes.mockResolvedValue({ success: true, data: { recoveryCodes: ['NEWAA-AAAAA', 'NEWBB-BBBBB'] } });
  renamePasskey.mockResolvedValue({ success: true, data: { passkey: passkey({ name: 'Phone' }) } });
  deletePasskey.mockResolvedValue({ success: true, data: { removed: true, passkey: passkey() } });
});

describe('PasskeySection', () => {
  it('lists the account\'s passkeys with their sync state and last use', async () => {
    listPasskeys.mockResolvedValue({
      success: true,
      data: { passkeys: [passkey(), passkey({ id: 'pk2', name: 'YubiKey', backedUp: false, lastUsedAt: new Date().toISOString() })] },
    });
    await renderSection();
    expect(screen.getByText('MacBook Touch ID')).toBeInTheDocument();
    expect(screen.getByText('YubiKey')).toBeInTheDocument();
    // Only the synced one carries the badge.
    expect(screen.getAllByText('synced')).toHaveLength(1);
    expect(screen.getByText('never')).toBeInTheDocument();
  });

  it('renders nothing when the browser has no WebAuthn', async () => {
    webauthnSupported = false;
    const { container } = render(<PasskeySection readOnly={false} />);
    await act(async () => { await Promise.resolve(); });
    expect(container).toBeEmptyDOMElement();
  });

  it('requires a name before it will start a ceremony', async () => {
    await renderSection();
    fireEvent.click(screen.getByRole('button', { name: /add passkey/i }));
    expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/name/i));
    expect(screen.queryByTestId('stepup-modal')).not.toBeInTheDocument();
  });

  it('adds a passkey only after step-up, forwarding the token — and runs the ceremony from its OWN click', async () => {
    await renderSection();
    fireEvent.change(screen.getByPlaceholderText(/MacBook Touch ID/i), { target: { value: 'Work laptop' } });
    fireEvent.click(screen.getByRole('button', { name: /add passkey/i }));

    // No ceremony yet — the modal comes first.
    expect(beginPasskeyRegistration).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByTestId('stepup-modal')); });
    await waitFor(() => expect(beginPasskeyRegistration).toHaveBeenCalledWith('step-up-token'));
    // The browser ceremony waits for a fresh gesture (Safari refuses one that
    // follows the step-up's async work).
    expect(finishPasskeyRegistration).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: /^create passkey$/i })); });
    expect(finishPasskeyRegistration).toHaveBeenCalledWith(PENDING, 'Work laptop');
    expect(toastSuccess).toHaveBeenCalledWith('Passkey added');
  });

  it('says what happened when the browser refuses the ceremony, and lets it be retried', async () => {
    finishPasskeyRegistration.mockRejectedValueOnce(Object.assign(new Error('not allowed'), { name: 'NotAllowedError' }));
    await renderSection();
    fireEvent.change(screen.getByPlaceholderText(/MacBook Touch ID/i), { target: { value: 'Work laptop' } });
    fireEvent.click(screen.getByRole('button', { name: /add passkey/i }));
    await act(async () => { fireEvent.click(screen.getByTestId('stepup-modal')); });
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: /^create passkey$/i })); });
    expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/didn.t create the passkey/i));
    // Still offered — the same challenge, one more try.
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^create passkey$/i })); });
    expect(finishPasskeyRegistration).toHaveBeenCalledTimes(2);
    expect(toastSuccess).toHaveBeenCalledWith('Passkey added');
  });

  it('explains a duplicate authenticator in the browser\'s own terms', async () => {
    finishPasskeyRegistration.mockRejectedValue(Object.assign(new Error('boom'), { name: 'InvalidStateError' }));
    await renderSection();
    fireEvent.change(screen.getByPlaceholderText(/MacBook Touch ID/i), { target: { value: 'Again' } });
    fireEvent.click(screen.getByRole('button', { name: /add passkey/i }));
    await act(async () => { fireEvent.click(screen.getByTestId('stepup-modal')); });
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: /^create passkey$/i })); });
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('This passkey is already registered'));
  });

  it('renames in place', async () => {
    await renderSection();
    fireEvent.click(screen.getByRole('button', { name: /rename/i }));
    fireEvent.change(screen.getByLabelText('Passkey name'), { target: { value: 'Phone' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /save name/i })); });
    await waitFor(() => expect(renamePasskey).toHaveBeenCalledWith('pk1', 'Phone'));
  });

  it('removes from ONE dialog that both asks and steps up', async () => {
    await renderSection();
    fireEvent.click(screen.getByRole('button', { name: /remove/i }));
    // The step-up dialog IS the confirmation — nothing is sent until it is
    // satisfied, and there is no second modal in front of it.
    expect(deletePasskey).not.toHaveBeenCalled();
    expect(screen.getByTestId('stepup-modal')).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByTestId('stepup-modal')); });
    await waitFor(() => expect(deletePasskey).toHaveBeenCalledWith('pk1', 'step-up-token'));
  });

  it('shows the server\'s last-sign-in-method refusal rather than a generic error', async () => {
    deletePasskey.mockRejectedValue(new Error('This is the only way you can sign in. Set a password or add another passkey first.'));
    await renderSection();
    fireEvent.click(screen.getByRole('button', { name: /remove/i }));
    await act(async () => { fireEvent.click(screen.getByTestId('stepup-modal')); });
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(expect.stringContaining('only way you can sign in')));
  });

  it('offers no writes in a read-only (impersonated) session', async () => {
    await renderSection(true);
    // `readOnly` buttons are rendered but inert — clicking must start nothing.
    fireEvent.change(screen.getByPlaceholderText(/MacBook Touch ID/i), { target: { value: 'Nope' } });
    fireEvent.click(screen.getByRole('button', { name: /add passkey/i }));
    fireEvent.click(screen.getByRole('button', { name: /remove/i }));
    expect(screen.queryByTestId('stepup-modal')).not.toBeInTheDocument();
    expect(beginPasskeyRegistration).not.toHaveBeenCalled();
    expect(deletePasskey).not.toHaveBeenCalled();
  });

  it('surfaces a load failure instead of implying the account has no passkeys', async () => {
    listPasskeys.mockRejectedValue(new Error('network down'));
    await renderSection();
    expect(screen.queryByText(/no passkeys yet/i)).not.toBeInTheDocument();
    expect(screen.getByText(/network down/i)).toBeInTheDocument();
  });
});

describe('PasskeySection — keeping the posture strip honest', () => {
  // The strip at the top of the page reports `user.authFactors.passkeyCount`,
  // so a change here that doesn't refresh the profile leaves it saying "None".
  const addOne = async () => {
    await renderSection();
    fireEvent.change(screen.getByRole('textbox', { name: /name/i }), { target: { value: 'Laptop' } });
    fireEvent.click(screen.getByRole('button', { name: /add passkey/i }));
    await act(async () => { fireEvent.click(screen.getByTestId('stepup-modal')); });
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: /^create passkey$/i })); });
  };

  it('refreshes the profile after adding a passkey', async () => {
    await addOne();
    await waitFor(() => expect(refreshUser).toHaveBeenCalled());
  });

  it('refreshes the profile after removing one', async () => {
    await renderSection();
    fireEvent.click(screen.getByRole('button', { name: /remove/i }));
    await act(async () => { fireEvent.click(screen.getByTestId('stepup-modal')); });
    await waitFor(() => expect(refreshUser).toHaveBeenCalled());
  });

  it('refreshes the profile after a rename', async () => {
    await renderSection();
    fireEvent.click(screen.getByRole('button', { name: /rename/i }));
    fireEvent.change(screen.getByLabelText('Passkey name'), { target: { value: 'Phone' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /save name/i })); });
    await waitFor(() => expect(refreshUser).toHaveBeenCalled());
  });
});

describe('PasskeySection — the account\'s recovery codes', () => {
  it('shows the codes once when the new passkey is the account\'s first factor', async () => {
    finishPasskeyRegistration.mockResolvedValue({ passkey: passkey({ id: 'pk2' }), recoveryCodes: ['AAAAA-BBBBB', 'CCCCC-DDDDD'] });
    await renderSection();
    fireEvent.change(screen.getByPlaceholderText(/MacBook Touch ID/i), { target: { value: 'First key' } });
    fireEvent.click(screen.getByRole('button', { name: /add passkey/i }));
    await act(async () => { fireEvent.click(screen.getByTestId('stepup-modal')); });
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: /^create passkey$/i })); });

    const list = await screen.findByRole('list', { name: /recovery codes/i });
    expect(list).toHaveTextContent('AAAAA-BBBBB');
    expect(list).toHaveTextContent('CCCCC-DDDDD');
  });

  it('shows how many codes are left for a passkey-only account, and replaces them behind step-up', async () => {
    await renderSection();
    expect(await screen.findByText(/8 of 10/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /new recovery codes/i }));
    await act(async () => { fireEvent.click(screen.getByTestId('stepup-modal')); });

    expect(regenerateRecoveryCodes).toHaveBeenCalledWith('step-up-token');
    expect(await screen.findByRole('list', { name: /recovery codes/i })).toHaveTextContent('NEWAA-AAAAA');
  });

  it('leaves the codes to the authenticator-app panel when the account has one (one set, one place)', async () => {
    getTotpStatus.mockResolvedValue({ success: true, data: { totp: { enabled: true } } });
    await renderSection();
    await waitFor(() => expect(getTotpStatus).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /new recovery codes/i })).not.toBeInTheDocument();
  });
});
