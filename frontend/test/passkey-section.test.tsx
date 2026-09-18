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

import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react';

const listPasskeys = jest.fn();
const renamePasskey = jest.fn();
const deletePasskey = jest.fn();
const toastError = jest.fn();
const toastSuccess = jest.fn();
const registerPasskey = jest.fn();
let webauthnSupported = true;

jest.mock('@/lib/api', () => ({
  __esModule: true,
  ApiError: class ApiError extends Error { statusCode = 0; },
  default: {
    listPasskeys: (...a: unknown[]) => listPasskeys(...a),
    renamePasskey: (...a: unknown[]) => renamePasskey(...a),
    deletePasskey: (...a: unknown[]) => deletePasskey(...a),
  },
}));
jest.mock('@/lib/passkeys', () => ({
  __esModule: true,
  browserSupportsWebAuthn: () => webauthnSupported,
  registerPasskey: (...a: unknown[]) => registerPasskey(...a),
}));
// One STABLE object: the real `useToast` memoizes, and `useLoadable`'s `reload`
// depends on it — a fresh object per render would re-run the load effect forever.
const toast = { success: toastSuccess, error: toastError, warning: jest.fn(), info: jest.fn() };
jest.mock('@/components/ui/Toast', () => ({ __esModule: true, useToast: () => toast }));
// Step-up has its own suite; here it only needs to hand a token back so the
// gated call can be asserted.
jest.mock('@/components/admin/StepUpModal', () => ({
  __esModule: true,
  StepUpModal: ({ onConfirmed }: { onConfirmed: (t: string) => void }) => (
    <button data-testid="stepup-modal" onClick={() => onConfirmed('step-up-token')}>confirm</button>
  ),
}));

import { PasskeySection } from '../src/components/settings/PasskeySection';

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
  webauthnSupported = true;
  listPasskeys.mockResolvedValue({ success: true, data: { passkeys: [passkey()] } });
  registerPasskey.mockResolvedValue(passkey({ id: 'pk2', name: 'New key' }));
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

  it('adds a passkey only after step-up, forwarding the token', async () => {
    await renderSection();
    fireEvent.change(screen.getByPlaceholderText(/MacBook Touch ID/i), { target: { value: 'Work laptop' } });
    fireEvent.click(screen.getByRole('button', { name: /add passkey/i }));

    // No ceremony yet — the modal comes first.
    expect(registerPasskey).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByTestId('stepup-modal')); });
    await waitFor(() => expect(registerPasskey).toHaveBeenCalledWith('Work laptop', 'step-up-token'));
    expect(toastSuccess).toHaveBeenCalledWith('Passkey added');
  });

  it('stays silent when the person dismisses the registration prompt', async () => {
    registerPasskey.mockRejectedValue(Object.assign(new Error('not allowed'), { name: 'NotAllowedError' }));
    await renderSection();
    fireEvent.change(screen.getByPlaceholderText(/MacBook Touch ID/i), { target: { value: 'Work laptop' } });
    fireEvent.click(screen.getByRole('button', { name: /add passkey/i }));
    await act(async () => { fireEvent.click(screen.getByTestId('stepup-modal')); });
    await waitFor(() => expect(registerPasskey).toHaveBeenCalled());
    expect(toastError).not.toHaveBeenCalled();
  });

  it('explains a duplicate authenticator in the browser\'s own terms', async () => {
    registerPasskey.mockRejectedValue(Object.assign(new Error('boom'), { name: 'InvalidStateError' }));
    await renderSection();
    fireEvent.change(screen.getByPlaceholderText(/MacBook Touch ID/i), { target: { value: 'Again' } });
    fireEvent.click(screen.getByRole('button', { name: /add passkey/i }));
    await act(async () => { fireEvent.click(screen.getByTestId('stepup-modal')); });
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('This passkey is already registered'));
  });

  it('renames in place', async () => {
    await renderSection();
    fireEvent.click(screen.getByRole('button', { name: /rename/i }));
    fireEvent.change(screen.getByLabelText('Passkey name'), { target: { value: 'Phone' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /save name/i })); });
    await waitFor(() => expect(renamePasskey).toHaveBeenCalledWith('pk1', 'Phone'));
  });

  it('removes only after confirming AND stepping up', async () => {
    await renderSection();
    fireEvent.click(screen.getByRole('button', { name: /remove/i }));
    // Confirm dialog first; still no delete.
    expect(deletePasskey).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog');
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: /^remove$/i })); });
    expect(deletePasskey).not.toHaveBeenCalled();
    // Then step-up.
    await act(async () => { fireEvent.click(screen.getByTestId('stepup-modal')); });
    await waitFor(() => expect(deletePasskey).toHaveBeenCalledWith('pk1', 'step-up-token'));
  });

  it('shows the server\'s last-sign-in-method refusal rather than a generic error', async () => {
    deletePasskey.mockRejectedValue(new Error('This is the only way you can sign in. Set a password or add another passkey first.'));
    await renderSection();
    fireEvent.click(screen.getByRole('button', { name: /remove/i }));
    const dialog = screen.getByRole('dialog');
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: /^remove$/i })); });
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
    expect(registerPasskey).not.toHaveBeenCalled();
    expect(deletePasskey).not.toHaveBeenCalled();
  });

  it('surfaces a load failure instead of implying the account has no passkeys', async () => {
    listPasskeys.mockRejectedValue(new Error('network down'));
    await renderSection();
    expect(screen.queryByText(/no passkeys yet/i)).not.toBeInTheDocument();
    expect(screen.getByText(/network down/i)).toBeInTheDocument();
  });
});
