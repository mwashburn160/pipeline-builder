// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Settings → Organization → the security policy panels: the org password
 * minimum and the approved-authenticator (AAGUID) allowlist. Both write through
 * step-up; both say what they can and cannot do; the allowlist names models from
 * the FIDO Metadata Service and lists members whose passkeys it would not accept.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PasswordPolicySettings } from '../src/components/settings/PasswordPolicySettings';
import { AuthenticatorPolicySettings, normalizeAaguidInput } from '../src/components/settings/AuthenticatorPolicySettings';
import { SessionPolicySettings, parseSessionDays } from '../src/components/settings/SessionPolicySettings';
import type { OrgAuthenticatorPolicy, OrgPasswordPolicy, OrgSessionPolicy } from '../src/types';

const getPasswordPolicy = jest.fn<AnyFn>();
const updatePasswordPolicy = jest.fn<AnyFn>();
const getAuthenticatorPolicy = jest.fn<AnyFn>();
const updateAuthenticatorPolicy = jest.fn<AnyFn>();
const getSessionPolicy = jest.fn<AnyFn>();
const updateSessionPolicy = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getPasswordPolicy: (...a: unknown[]) => getPasswordPolicy(...a),
    updatePasswordPolicy: (...a: unknown[]) => updatePasswordPolicy(...a),
    getAuthenticatorPolicy: (...a: unknown[]) => getAuthenticatorPolicy(...a),
    updateAuthenticatorPolicy: (...a: unknown[]) => updateAuthenticatorPolicy(...a),
    getSessionPolicy: (...a: unknown[]) => getSessionPolicy(...a),
    updateSessionPolicy: (...a: unknown[]) => updateSessionPolicy(...a),
  },
}));
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule(() => ({ success: jest.fn<AnyFn>(), error: jest.fn<AnyFn>(), warning: jest.fn<AnyFn>(), info: jest.fn<AnyFn>() })));
jest.mock('@/components/admin/StepUpModal', () => ({
  __esModule: true,
  StepUpModal: ({ onConfirmed, action }: { onConfirmed: (t: string) => void; action: string }) => (
    <button data-testid="stepup-modal" onClick={() => onConfirmed('step-up-token')}>{action}</button>
  ),
}));

const YUBIKEY = 'cb69481e-8ff7-4039-93ec-0a2729a154a8';
const TITAN = '42b4fb4a-2866-43b2-9bf7-6c6669c2e5d3';
const ICLOUD = 'fbfc3007-154e-4ecc-8c0b-6e020557d7bd';

beforeEach(() => { jest.clearAllMocks(); });

describe('PasswordPolicySettings', () => {
  const policy = (over: Partial<OrgPasswordPolicy> = {}): OrgPasswordPolicy => ({
    minLength: 8, own: null, platformMinLength: 8, maxLength: 128, ...over,
  });

  it('saves a raised minimum through step-up, and says existing passwords are caught at next sign-in', async () => {
    getPasswordPolicy.mockResolvedValue({ success: true, data: policy() });
    updatePasswordPolicy.mockResolvedValue({ success: true, data: policy({ minLength: 14, own: 14 }) });
    render(<PasswordPolicySettings orgId="org-1" readOnly={false} />);
    const input = await screen.findByLabelText('Minimum length (characters)');
    expect(screen.getByText(/only their hashes are stored/)).toBeInTheDocument();

    fireEvent.change(input, { target: { value: '14' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.click(await screen.findByTestId('stepup-modal'));
    await waitFor(() => expect(updatePasswordPolicy).toHaveBeenCalledWith('org-1', { minLength: 14 }, 'step-up-token'));
  });

  it('refuses a value outside the platform range, and warns that lowering needs a second factor', async () => {
    getPasswordPolicy.mockResolvedValue({ success: true, data: policy({ minLength: 16, own: 16 }) });
    render(<PasswordPolicySettings orgId="org-1" readOnly={false} />);
    const input = await screen.findByLabelText('Minimum length (characters)');

    fireEvent.change(input, { target: { value: '4' } });
    expect(screen.getByText(/Enter a whole number from 8 to 128/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    fireEvent.change(input, { target: { value: '12' } });
    expect(screen.getByText(/Lowering the minimum weakens/)).toBeInTheDocument();
  });

  it('shows a stricter parent minimum', async () => {
    getPasswordPolicy.mockResolvedValue({ success: true, data: policy({ minLength: 20, inheritedFrom: 'root', inheritedFromName: 'Acme' }) });
    render(<PasswordPolicySettings orgId="org-1" readOnly={false} />);
    expect(await screen.findByText('Acme')).toBeInTheDocument();
  });
});

describe('AuthenticatorPolicySettings', () => {
  const policy = (over: Partial<OrgAuthenticatorPolicy> = {}): OrgAuthenticatorPolicy => ({
    own: [],
    effective: null,
    inheritedFrom: [],
    mds: { available: true, models: [{ aaguid: YUBIKEY, model: 'YubiKey 5 Series' }, { aaguid: TITAN, model: 'Google Titan' }] },
    compliance: { members: 2, passkeys: 2, modelsInUse: [{ aaguid: ICLOUD, count: 1, model: 'iCloud Keychain' }], nonCompliant: [] },
    ...over,
  });

  it('builds the list from an MDS search and saves it through step-up', async () => {
    getAuthenticatorPolicy.mockResolvedValue({ success: true, data: policy() });
    updateAuthenticatorPolicy.mockResolvedValue({ success: true, data: policy() });
    render(<AuthenticatorPolicySettings orgId="org-1" readOnly={false} />);

    fireEvent.change(await screen.findByPlaceholderText('Search models…'), { target: { value: 'yubi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add YubiKey 5 Series' }));
    expect(screen.getByText('YubiKey 5 Series')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.click(await screen.findByTestId('stepup-modal'));
    await waitFor(() => expect(updateAuthenticatorPolicy).toHaveBeenCalledWith('org-1', { allowedAaguids: [YUBIKEY] }, 'step-up-token'));
  });

  it('adds a raw AAGUID, and refuses one that is not an AAGUID', async () => {
    getAuthenticatorPolicy.mockResolvedValue({ success: true, data: policy() });
    render(<AuthenticatorPolicySettings orgId="org-1" readOnly={false} />);
    const raw = await screen.findByLabelText('Or add by AAGUID');
    fireEvent.change(raw, { target: { value: 'not-one' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByText(/not an authenticator AAGUID/)).toBeInTheDocument();

    fireEvent.change(raw, { target: { value: TITAN.toUpperCase() } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByText(TITAN)).toBeInTheDocument();
  });

  it('warns about members whose passkeys the list in force would not accept', async () => {
    getAuthenticatorPolicy.mockResolvedValue({
      success: true,
      data: policy({
        own: [{ aaguid: YUBIKEY, model: 'YubiKey 5 Series' }],
        effective: [{ aaguid: YUBIKEY, model: 'YubiKey 5 Series' }],
        compliance: {
          members: 2, passkeys: 2, modelsInUse: [],
          nonCompliant: [{
            userId: 'u2', username: 'sam', email: 'sam@example.com', hasAuthenticatorApp: false,
            passkeys: [{ id: 'c2', name: 'Phone', aaguid: ICLOUD, model: 'iCloud Keychain' }],
          }],
        },
      }),
    });
    render(<AuthenticatorPolicySettings orgId="org-1" readOnly={false} />);
    expect(await screen.findByText('sam@example.com')).toBeInTheDocument();
    expect(screen.getByText(/Phone \(iCloud Keychain\)/)).toBeInTheDocument();
    expect(screen.getByText(/no authenticator app/)).toBeInTheDocument();
  });

  it('says so when the FIDO Metadata Service is unavailable', async () => {
    getAuthenticatorPolicy.mockResolvedValue({ success: true, data: policy({ mds: { available: false, models: [] } }) });
    render(<AuthenticatorPolicySettings orgId="org-1" readOnly={false} />);
    expect(await screen.findByText(/Metadata Service isn.t available/)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Search models…')).not.toBeInTheDocument();
  });

  it('normalizeAaguidInput mirrors the server', () => {
    expect(normalizeAaguidInput(` ${YUBIKEY.toUpperCase()} `)).toBe(YUBIKEY);
    expect(normalizeAaguidInput('00000000-0000-0000-0000-000000000000')).toBeNull();
    expect(normalizeAaguidInput('nope')).toBeNull();
  });
});

describe('SessionPolicySettings', () => {
  const policy = (over: Partial<OrgSessionPolicy> = {}): OrgSessionPolicy => ({
    maxAgeDays: 30,
    idleTimeoutDays: 7,
    own: { maxAgeDays: null, idleTimeoutDays: null },
    platform: { maxAgeDays: 30, idleTimeoutDays: 7 },
    enforcement: 'interactive-sessions-at-next-refresh',
    ...over,
  });

  it('parses a draft: empty clears, whole days 1–365 only', () => {
    expect(parseSessionDays('')).toEqual({ value: null, invalid: false });
    expect(parseSessionDays(' 14 ')).toEqual({ value: 14, invalid: false });
    expect(parseSessionDays('0').invalid).toBe(true);
    expect(parseSessionDays('366').invalid).toBe(true);
    expect(parseSessionDays('1.5').invalid).toBe(true);
  });

  it('shows the platform defaults and what is in force, and saves only the changed field through step-up', async () => {
    getSessionPolicy.mockResolvedValue({ success: true, data: policy() });
    updateSessionPolicy.mockResolvedValue({ success: true, message: 'Session policy updated', data: policy({ idleTimeoutDays: 2, own: { maxAgeDays: null, idleTimeoutDays: 2 } }) });
    render(<SessionPolicySettings orgId="org-1" readOnly={false} />);

    const idle = await screen.findByLabelText('Idle timeout (days)');
    expect(screen.getByText(/Platform default: 30 days\. In force now: 30 days\./)).toBeInTheDocument();
    expect(screen.getByText(/Platform default: 7 days\. In force now: 7 days\./)).toBeInTheDocument();
    expect(screen.getByText(/Access keys and service accounts keep their own expiry/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    fireEvent.change(idle, { target: { value: '2' } });
    expect(screen.queryByText(/Lengthening sessions/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const modal = await screen.findByTestId('stepup-modal');
    expect(modal).toHaveTextContent('Sign out sessions idle for 2 days');
    fireEvent.click(modal);
    await waitFor(() => expect(updateSessionPolicy).toHaveBeenCalledWith('org-1', { idleTimeoutDays: 2 }, 'step-up-token'));
    await waitFor(() => expect(getSessionPolicy).toHaveBeenCalledTimes(2));
  });

  it('refuses an out-of-range value, and warns that lengthening (raise or clear) needs a second factor', async () => {
    getSessionPolicy.mockResolvedValue({ success: true, data: policy({ maxAgeDays: 10, own: { maxAgeDays: 10, idleTimeoutDays: null } }) });
    updateSessionPolicy.mockResolvedValue({ success: true, data: policy() });
    render(<SessionPolicySettings orgId="org-1" readOnly={false} />);
    const maxAge = await screen.findByLabelText('Maximum session age (days)');
    await waitFor(() => expect(maxAge).toHaveValue(10));

    fireEvent.change(maxAge, { target: { value: '400' } });
    expect(screen.getByText(/Enter a whole number of days from 1 to 365/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    fireEvent.change(maxAge, { target: { value: '20' } });
    expect(screen.getByText(/Lengthening sessions weakens/)).toBeInTheDocument();

    fireEvent.change(maxAge, { target: { value: '' } });
    expect(screen.getByText(/Lengthening sessions weakens/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const modal = await screen.findByTestId('stepup-modal');
    expect(modal).toHaveTextContent('Clear the maximum session age');
    fireEvent.click(modal);
    await waitFor(() => expect(updateSessionPolicy).toHaveBeenCalledWith('org-1', { maxAgeDays: null }, 'step-up-token'));
  });

  it('shows the server\'s refusal (e.g. lengthening on a single-factor session)', async () => {
    getSessionPolicy.mockResolvedValue({ success: true, data: policy({ own: { maxAgeDays: 5, idleTimeoutDays: null }, maxAgeDays: 5 }) });
    updateSessionPolicy.mockRejectedValue(new Error('This change needs a session opened with a second factor'));
    render(<SessionPolicySettings orgId="org-1" readOnly={false} />);
    fireEvent.change(await screen.findByLabelText('Maximum session age (days)'), { target: { value: '9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.click(await screen.findByTestId('stepup-modal'));
    expect(await screen.findByText('This change needs a session opened with a second factor')).toBeInTheDocument();
  });

  it('names a stricter parent, and disables everything when read-only', async () => {
    getSessionPolicy.mockResolvedValue({
      success: true,
      data: policy({ idleTimeoutDays: 1, idleTimeoutInheritedFrom: 'root', idleTimeoutInheritedFromName: 'Acme' }),
    });
    render(<SessionPolicySettings orgId="org-1" readOnly />);
    expect(await screen.findByText(/A parent organization sets a stricter limit/)).toBeInTheDocument();
    expect(screen.getByText(/In force now: 1 day \(set by Acme\)/)).toBeInTheDocument();
    expect(screen.getByLabelText('Idle timeout (days)')).toBeDisabled();
    expect(screen.getByLabelText('Maximum session age (days)')).toBeDisabled();
  });

  it('offers a retry when the policy cannot be read', async () => {
    // An envelope that carries no policy counts as a failed read.
    getSessionPolicy.mockResolvedValueOnce({ success: true }).mockResolvedValue({ success: true, data: policy() });
    render(<SessionPolicySettings orgId="org-1" readOnly={false} />);
    fireEvent.click(await screen.findByRole('button', { name: /retry/i }));
    expect(await screen.findByLabelText('Idle timeout (days)')).toBeInTheDocument();
  });
});
