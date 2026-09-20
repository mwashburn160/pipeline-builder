// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The authenticator-app panel (Settings → Security → Authenticator app).
 *
 * The properties worth pinning are the ones a person's ability to sign in
 * depends on: enrolling, disabling and re-keying all go through step-up (never a
 * bare click), the secret and the recovery codes are shown once and the person
 * has to acknowledge them, the server's "this is your only way in" refusal is
 * SHOWN rather than re-derived here, a failed status read never renders as
 * "two-factor is off", and an impersonated (read-only) session offers no writes.
 */

import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';

const getTotpStatus = jest.fn();
const enrolTotp = jest.fn();
const activateTotp = jest.fn();
const disableTotp = jest.fn();
const regenerateRecoveryCodes = jest.fn();
const toastError = jest.fn();
const toastSuccess = jest.fn();

jest.mock('@/lib/api', () => ({
  __esModule: true,
  ApiError: class ApiError extends Error { statusCode = 0; },
  default: {
    getTotpStatus: (...a: unknown[]) => getTotpStatus(...a),
    enrolTotp: (...a: unknown[]) => enrolTotp(...a),
    activateTotp: (...a: unknown[]) => activateTotp(...a),
    disableTotp: (...a: unknown[]) => disableTotp(...a),
    regenerateRecoveryCodes: (...a: unknown[]) => regenerateRecoveryCodes(...a),
  },
}));

// One STABLE object: `useLoadable`'s `reload` depends on the toast, and a fresh
// object per render would re-run the load effect forever.
const toast = { success: toastSuccess, error: toastError, warning: jest.fn(), info: jest.fn() };
jest.mock('@/components/ui/Toast', () => ({ __esModule: true, useToast: () => toast }));

// Step-up has its own suite; here it only needs to hand a token back so the
// gated call can be asserted, and to record WHICH action opened it.
let lastStepUpAction = '';
// The single dialog carries the heading and the consequence, so both are
// recorded — that copy is now the ONLY warning before the factor is taken.
let lastStepUpTitle = '';
jest.mock('@/components/admin/StepUpModal', () => ({
  __esModule: true,
  StepUpModal: ({ action, title, details, onConfirmed }: { action: string; title?: string; details?: React.ReactNode; onConfirmed: (t: string) => void }) => {
    lastStepUpAction = action;
    lastStepUpTitle = title ?? '';
    return (
      <div>
        <div data-testid="stepup-details">{details}</div>
        <button data-testid="stepup-modal" onClick={() => onConfirmed('step-up-token')}>confirm</button>
      </div>
    );
  },
}));

// The QR encoder is loaded with a dynamic import and draws a canvas-free SVG;
// nothing here is about QR encoding, and jsdom would only pay for it.
jest.mock('@/components/settings/TotpQrCode', () => ({
  __esModule: true,
  TotpQrCode: ({ value }: { value: string }) => <div data-testid="qr">{value}</div>,
}));

// Turning the factor on or off changes `user.authFactors`, which the posture
// strip above this panel reads off the profile — so the panel refreshes it.
const refreshUser = jest.fn(async () => undefined);
jest.mock('@/hooks/useAuth', () => ({ __esModule: true, useAuth: () => ({ refreshUser }) }));

import { TotpSection } from '../src/components/settings/TotpSection';
import { clearQueryCache } from '../src/lib/query-cache';

const status = (over: Record<string, unknown> = {}) => ({
  enabled: false, pending: false, activatedAt: null, lastUsedAt: null,
  recoveryCodesRemaining: 0, recoveryCodesTotal: 0, recoveryGeneratedAt: null, lockedUntil: null,
  ...over,
});

const enabled = (over: Record<string, unknown> = {}) => status({
  enabled: true,
  activatedAt: new Date(Date.now() - 86_400_000).toISOString(),
  recoveryCodesRemaining: 10,
  recoveryCodesTotal: 10,
  ...over,
});

const renderSection = async (totp: Record<string, unknown>, readOnly = false) => {
  getTotpStatus.mockResolvedValue({ success: true, data: { totp } });
  await act(async () => { render(<TotpSection readOnly={readOnly} />); });
};

const codes = ['AAAAA-BBBBB', 'CCCCC-DDDDD'];

beforeEach(() => {
  jest.clearAllMocks();
  // The status is read through the shared cache, which outlives a test.
  clearQueryCache();
  lastStepUpAction = '';
  lastStepUpTitle = '';
  enrolTotp.mockResolvedValue({ success: true, data: { secret: 'JBSWY3DPEHPK3PXP', otpauthUri: 'otpauth://totp/x' } });
  activateTotp.mockResolvedValue({ success: true, data: { recoveryCodes: codes } });
  disableTotp.mockResolvedValue({ success: true, data: { disabled: true } });
  regenerateRecoveryCodes.mockResolvedValue({ success: true, data: { recoveryCodes: codes } });
  // jsdom has no object-URL support for the recovery-code download.
  global.URL.createObjectURL = jest.fn(() => 'blob:codes');
  global.URL.revokeObjectURL = jest.fn();
});

describe('TotpSection — turning it on', () => {
  it('gates enrolment behind step-up, then shows the QR and the typed key', async () => {
    await renderSection(status());

    fireEvent.click(screen.getByRole('button', { name: /set up authenticator app/i }));
    expect(lastStepUpAction).toMatch(/set up an authenticator app/i);
    // Nothing is minted on the bare click.
    expect(enrolTotp).not.toHaveBeenCalled();

    await act(async () => { fireEvent.click(screen.getByTestId('stepup-modal')); });

    expect(enrolTotp).toHaveBeenCalledWith('step-up-token');
    expect(screen.getByTestId('qr')).toHaveTextContent('otpauth://totp/x');
    // The manual key, for an app that can't scan.
    expect(screen.getByText('JBSWY3DPEHPK3PXP')).toBeInTheDocument();
  });

  it('confirms with a code and shows the recovery codes once', async () => {
    await renderSection(status());
    fireEvent.click(screen.getByRole('button', { name: /set up authenticator app/i }));
    await act(async () => { fireEvent.click(screen.getByTestId('stepup-modal')); });

    fireEvent.change(screen.getByPlaceholderText('123456'), { target: { value: '123456' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /turn on/i })); });

    expect(activateTotp).toHaveBeenCalledWith('123456');
    expect(await screen.findByText('AAAAA-BBBBB')).toBeInTheDocument();
    expect(screen.getByText('CCCCC-DDDDD')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /download/i })).toHaveAttribute('download');
    // They stay on screen until the person says they saved them.
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /saved them/i })); });
    expect(screen.queryByText('AAAAA-BBBBB')).not.toBeInTheDocument();
  });

  it('shows the server\'s wording for a rejected code and keeps the form up', async () => {
    activateTotp.mockRejectedValue(new Error('Too many incorrect codes. Try again in a few minutes.'));
    await renderSection(status());
    fireEvent.click(screen.getByRole('button', { name: /set up authenticator app/i }));
    await act(async () => { fireEvent.click(screen.getByTestId('stepup-modal')); });

    fireEvent.change(screen.getByPlaceholderText('123456'), { target: { value: '000000' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /turn on/i })); });

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Too many incorrect codes. Try again in a few minutes.'));
    expect(screen.getByPlaceholderText('123456')).toBeInTheDocument();
  });

  it('abandoning setup leaves nothing on screen', async () => {
    await renderSection(status());
    fireEvent.click(screen.getByRole('button', { name: /set up authenticator app/i }));
    await act(async () => { fireEvent.click(screen.getByTestId('stepup-modal')); });

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /cancel/i })); });
    expect(screen.queryByText('JBSWY3DPEHPK3PXP')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /set up authenticator app/i })).toBeInTheDocument();
  });

  it('says so when an earlier setup was never confirmed', async () => {
    await renderSection(status({ pending: true }));
    expect(screen.getByText(/setup was never finished/i)).toBeInTheDocument();
  });
});

describe('TotpSection — once it is on', () => {
  it('shows the state and how many recovery codes are left', async () => {
    await renderSection(enabled({ recoveryCodesRemaining: 7 }));
    expect(screen.getByText('On')).toBeInTheDocument();
    expect(screen.getByText('7 of 10')).toBeInTheDocument();
  });

  it('warns loudly when the recovery codes have run out', async () => {
    await renderSection(enabled({ recoveryCodesRemaining: 0 }));
    expect(screen.getByText(/no recovery codes left/i)).toBeInTheDocument();
  });

  it('warns when they are running low', async () => {
    await renderSection(enabled({ recoveryCodesRemaining: 2 }));
    expect(screen.getByText(/running low on recovery codes/i)).toBeInTheDocument();
  });

  it('surfaces a lockout', async () => {
    await renderSection(enabled({ lockedUntil: new Date(Date.now() + 600_000).toISOString() }));
    expect(screen.getByText(/temporarily locked/i)).toBeInTheDocument();
  });

  it('turns it off from ONE dialog that both asks and steps up', async () => {
    await renderSection(enabled());

    fireEvent.click(screen.getByRole('button', { name: /turn off/i }));
    // The step-up dialog IS the confirmation: it names the action and says what
    // it costs, instead of a confirm modal in front of a second modal.
    expect(lastStepUpTitle).toMatch(/turn off two-factor authentication\?/i);
    expect(screen.getByTestId('stepup-details')).toHaveTextContent(/recovery codes/i);
    expect(disableTotp).not.toHaveBeenCalled();

    await act(async () => { fireEvent.click(screen.getByTestId('stepup-modal')); });

    expect(disableTotp).toHaveBeenCalledWith('step-up-token');
    expect(toastSuccess).toHaveBeenCalledWith('Two-factor authentication is off');
  });

  it('shows the server\'s last-sign-in-method refusal rather than re-deriving it', async () => {
    disableTotp.mockRejectedValue(new Error('This is the only way you can sign in. Set a password or add a passkey first.'));
    await renderSection(enabled());

    fireEvent.click(screen.getByRole('button', { name: /turn off/i }));
    await act(async () => { fireEvent.click(screen.getByTestId('stepup-modal')); });

    await waitFor(() => expect(toastError)
      .toHaveBeenCalledWith('This is the only way you can sign in. Set a password or add a passkey first.'));
  });

  it('warns what regeneration costs, steps up, and shows the new sheet', async () => {
    await renderSection(enabled());

    fireEvent.click(screen.getByRole('button', { name: /new recovery codes/i }));
    expect(screen.getByTestId('stepup-details')).toHaveTextContent(/every code you have written down stops working/i);

    await act(async () => { fireEvent.click(screen.getByTestId('stepup-modal')); });

    expect(regenerateRecoveryCodes).toHaveBeenCalledWith('step-up-token');
    expect(await screen.findByText('AAAAA-BBBBB')).toBeInTheDocument();
    expect(screen.getByText(/your new recovery codes/i)).toBeInTheDocument();
  });
});

describe('TotpSection — keeping the posture strip honest', () => {
  // The strip at the top of the page derives passkey/authenticator/org-2FA
  // state from `user.authFactors`, so a factor change that doesn't refresh the
  // profile leaves it saying "Off" — and, because it gates the recovery-code
  // item on `hasTotp`, that item never appears at all.
  it('refreshes the profile after turning two-factor ON', async () => {
    await renderSection(status());
    fireEvent.click(screen.getByRole('button', { name: /set up authenticator app/i }));
    await act(async () => { fireEvent.click(screen.getByTestId('stepup-modal')); });
    fireEvent.change(screen.getByPlaceholderText('123456'), { target: { value: '123456' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /turn on/i })); });
    await waitFor(() => expect(refreshUser).toHaveBeenCalled());
  });

  it('refreshes the profile after turning it OFF', async () => {
    await renderSection(enabled());
    fireEvent.click(screen.getByRole('button', { name: /turn off/i }));
    await act(async () => { fireEvent.click(screen.getByTestId('stepup-modal')); });
    await waitFor(() => expect(refreshUser).toHaveBeenCalled());
  });

  it('refreshes the profile after replacing the recovery codes', async () => {
    await renderSection(enabled());
    fireEvent.click(screen.getByRole('button', { name: /new recovery codes/i }));
    await act(async () => { fireEvent.click(screen.getByTestId('stepup-modal')); });
    await waitFor(() => expect(refreshUser).toHaveBeenCalled());
  });

  it('does not refresh it for merely starting an enrolment', async () => {
    await renderSection(status());
    fireEvent.click(screen.getByRole('button', { name: /set up authenticator app/i }));
    await act(async () => { fireEvent.click(screen.getByTestId('stepup-modal')); });
    expect(refreshUser).not.toHaveBeenCalled();
  });
});

describe('TotpSection — read-only and failure', () => {
  it('offers no writes during a read-only impersonation', async () => {
    await renderSection(enabled(), true);
    expect(screen.getByRole('button', { name: /turn off/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /new recovery codes/i })).toBeDisabled();
  });

  it('a failed status read shows a retry, NOT a false "two-factor is off"', async () => {
    getTotpStatus.mockRejectedValue(new Error('network down'));
    await act(async () => { render(<TotpSection readOnly={false} />); });

    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /set up authenticator app/i })).not.toBeInTheDocument();
  });

  it('shows no recovery-code sheet when the account already had one (a passkey came first)', async () => {
    activateTotp.mockResolvedValue({ success: true, data: { recoveryCodes: [] } });
    await renderSection(status());
    fireEvent.click(screen.getByRole('button', { name: /set up authenticator app/i }));
    await act(async () => { fireEvent.click(screen.getByTestId('stepup-modal')); });
    fireEvent.change(screen.getByPlaceholderText('123456'), { target: { value: '123456' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /turn on/i })); });
    expect(activateTotp).toHaveBeenCalledWith('123456');
    expect(screen.queryByRole('list', { name: /recovery codes/i })).not.toBeInTheDocument();
  });
});
