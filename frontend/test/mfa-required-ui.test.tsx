// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The member-facing half of required MFA (#8): the banner that warns BEFORE the
 * deadline, and the dialog that explains a `401 MFA_REQUIRED` instead of letting
 * it land as a bare "Unauthorized".
 *
 * Both exist for the same reason: an assurance refusal is not an expired
 * session, so the app must neither refresh nor sign the person out — the session
 * they are holding is the one they need in order to enrol. The tests pin the
 * three states a person can be in (covered, warned, refused) and the two
 * different next steps (enrol, or sign in again with the factor they have).
 */

import { render, screen, act, waitFor } from '@testing-library/react';

const getProfile = jest.fn();
const logout = jest.fn();
const push = jest.fn();

jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: { getProfile: (...a: unknown[]) => getProfile(...a) },
}));

let mockUser: Record<string, unknown> | null = null;
jest.mock('@/hooks/useAuth', () => ({
  __esModule: true,
  useAuth: () => ({ user: mockUser, logout }),
}));

jest.mock('next/router', () => ({ __esModule: true, useRouter: () => ({ push }) }));

import { MfaRequiredBanner } from '@/components/ui/MfaRequiredBanner';
import { MfaRequiredDialog } from '@/components/ui/MfaRequiredDialog';

beforeEach(() => {
  jest.clearAllMocks();
  mockUser = null;
  getProfile.mockResolvedValue({ data: { user: { authFactors: { hasPassword: true, passkeyCount: 0, hasTotp: false, providers: [] } } } });
});

const IN_TEN_DAYS = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();

describe('MfaRequiredBanner', () => {
  it('shows nothing for an org with no requirement', async () => {
    mockUser = { id: 'u1' };
    await act(async () => { render(<MfaRequiredBanner />); });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows nothing when the session ALREADY satisfies the requirement', async () => {
    // Nagging someone who has complied is how banners get ignored.
    mockUser = { id: 'u1', mfaPolicy: { requireMfa: true, enforced: true, aal: 2 } };
    await act(async () => { render(<MfaRequiredBanner />); });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('warns with the deadline and a day count while the grace period runs', async () => {
    mockUser = { id: 'u1', mfaPolicy: { requireMfa: true, enforced: false, graceUntil: IN_TEN_DAYS, aal: 1 } };
    await act(async () => { render(<MfaRequiredBanner />); });
    const banner = screen.getByRole('status');
    expect(banner.textContent).toContain('in 10 days');
    // A date, not a feeling.
    expect(banner.textContent).toContain(new Date(IN_TEN_DAYS).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }));
    expect(screen.getByRole('link', { name: /set it up now/i })).toHaveAttribute('href', '/dashboard/security?tab=factors#passkeys');
  });

  it('says the session will stop working once the requirement is in force', async () => {
    mockUser = { id: 'u1', mfaPolicy: { requireMfa: true, enforced: true, aal: 1 } };
    await act(async () => { render(<MfaRequiredBanner />); });
    expect(screen.getByRole('status').textContent).toMatch(/stop working the next time it is renewed/i);
  });

  it('after an approved MFA reset, gives the person their OWN enrolment deadline', async () => {
    const IN_TWO_DAYS = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
    mockUser = { id: 'u1', mfaPolicy: { requireMfa: true, enforced: true, resetGraceUntil: IN_TWO_DAYS, aal: 1 } };
    await act(async () => { render(<MfaRequiredBanner />); });
    const text = screen.getByRole('status').textContent ?? '';
    expect(text).toMatch(/was reset by your organization/i);
    expect(text).toContain(new Date(IN_TWO_DAYS).toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' }));
    // Not the "your session is dying" copy — they are inside their grace.
    expect(text).not.toMatch(/stop working the next time/i);
  });

  it('cannot be dismissed — the worst case is being unable to sign in at all', async () => {
    mockUser = { id: 'u1', mfaPolicy: { requireMfa: true, enforced: true, aal: 1 } };
    await act(async () => { render(<MfaRequiredBanner />); });
    expect(screen.queryByRole('button', { name: /dismiss/i })).toBeNull();
  });
});

describe('MfaRequiredDialog', () => {
  it('offers ENROLMENT first when the account has no factor', async () => {
    render(<MfaRequiredDialog code="MFA_REQUIRED" message="Two-factor authentication is required" onClose={jest.fn()} />);
    await waitFor(() => expect(getProfile).toHaveBeenCalled());
    const setUp = await screen.findByRole('button', { name: /set up two-factor/i });
    await act(async () => { setUp.click(); });
    expect(push).toHaveBeenCalledWith('/dashboard/security?tab=factors#passkeys');
    // Enrolment is the primary route, but signing in again is still offered.
    expect(screen.queryByRole('button', { name: /sign in again/i })).not.toBeNull();
  });

  it('points a person who HAS a factor at signing in again, not at enrolment', async () => {
    getProfile.mockResolvedValue({ data: { user: { authFactors: { hasPassword: true, passkeyCount: 1, hasTotp: false, providers: [] } } } });
    render(<MfaRequiredDialog code="MFA_REQUIRED" message="Two-factor authentication is required" onClose={jest.fn()} />);
    expect(await screen.findByRole('button', { name: /manage factors/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /set up two-factor/i })).toBeNull();
  });

  it('treats REAUTH_REQUIRED as "sign in again", with no enrolment prompt at all', async () => {
    render(<MfaRequiredDialog code="REAUTH_REQUIRED" message="This action requires a recent sign-in" onClose={jest.fn()} />);
    expect(await screen.findByText(/needs a recent sign-in/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /set up two-factor|manage factors/i })).toBeNull();
  });

  it('never signs the person out on its own — the session is fine for everything else', async () => {
    const onClose = jest.fn();
    render(<MfaRequiredDialog code="MFA_REQUIRED" message="msg" onClose={onClose} />);
    const notNow = await screen.findByRole('button', { name: /not now/i });
    await act(async () => { notNow.click(); });
    expect(logout).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('signs out only when the person asks to sign in again', async () => {
    render(<MfaRequiredDialog code="MFA_REQUIRED" message="msg" onClose={jest.fn()} />);
    const again = await screen.findByRole('button', { name: /sign in again/i });
    await act(async () => { again.click(); });
    expect(logout).toHaveBeenCalled();
  });

  it('offers both routes when the profile read fails rather than guessing', async () => {
    getProfile.mockRejectedValue(new Error('offline'));
    render(<MfaRequiredDialog code="MFA_REQUIRED" message="msg" onClose={jest.fn()} />);
    expect(await screen.findByRole('button', { name: /manage factors/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /sign in again/i })).toBeTruthy();
  });
});
