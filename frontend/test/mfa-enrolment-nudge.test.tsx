// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The PASSWORD-ONLY PROMPT — the banner for everyone `MfaRequiredBanner` never
 * speaks to, and the Security-page card that takes "don't ask again" back.
 *
 * The owner's first instinct here was a per-user "enable/disable MFA" toggle
 * defaulting to off. It was rejected on purpose, and these tests are what keeps
 * it rejected: whether an account is protected is DERIVED from `authFactors`,
 * and the only thing this feature stores is whether we are still asking. So
 * there is no switch to assert — what is asserted is the ASK: exactly when it
 * appears, that "no" sticks, and that enrolment is the one thing that ends it.
 *
 * The matrix below is the whole showing rule, one row per reason to stay quiet.
 */

import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
import type { User } from '@/types';

const snoozeMfaPrompt = jest.fn(async () => ({ success: true, data: { snoozedUntil: 'x', snoozeDays: 7 } }));
const declineMfaPrompt = jest.fn(async () => ({ success: true, data: { declinedAt: 'x' } }));
const restoreMfaPrompt = jest.fn(async () => ({ success: true, data: { cleared: true } }));
const isImpersonating = jest.fn(() => false);
const getAccessToken = jest.fn(() => null as string | null);

jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    snoozeMfaPrompt: (...a: unknown[]) => snoozeMfaPrompt(...(a as [])),
    declineMfaPrompt: (...a: unknown[]) => declineMfaPrompt(...(a as [])),
    restoreMfaPrompt: (...a: unknown[]) => restoreMfaPrompt(...(a as [])),
    isImpersonating: () => isImpersonating(),
    getAccessToken: () => getAccessToken(),
  },
  // `@/lib/jwt` imports this NAMED export from the api module, and the whole
  // module is replaced here — without it `decodeJwt` throws and every session
  // would look like an ordinary one. Same decode, on Buffer.
  base64UrlDecode: (value: string) => Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
}));

const refreshUser = jest.fn(async () => undefined);
let mockUser: Partial<User> | null = null;
jest.mock('@/hooks/useAuth', () => ({
  __esModule: true,
  useAuth: () => ({ user: mockUser, refreshUser }),
}));

const toastSuccess = jest.fn();
const toastError = jest.fn();
jest.mock('@/components/ui/Toast', () => ({
  __esModule: true,
  useToast: () => ({ success: toastSuccess, error: toastError, warning: jest.fn(), info: jest.fn() }),
}));

import { MfaEnrolmentNudge } from '@/components/ui/MfaEnrolmentNudge';
import { MfaPromptPreference } from '@/components/settings/MfaPromptPreference';

/** A password-only account: the one the prompt exists for. */
const PASSWORD_ONLY: Partial<User> = {
  id: 'u1',
  authFactors: { hasPassword: true, passkeyCount: 0, hasTotp: false, providers: [] },
};

const IN_THREE_DAYS = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
const YESTERDAY = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

/** A JWT whose payload carries `mfaEnrollmentPending` (header/sig are ignored). */
function enrolmentPendingToken(): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'ES256' })}.${b64({ sub: 'u1', mfaEnrollmentPending: true })}.sig`;
}

async function renderNudge(user: Partial<User> | null) {
  mockUser = user;
  await act(async () => { render(<MfaEnrolmentNudge />); });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUser = null;
  isImpersonating.mockReturnValue(false);
  getAccessToken.mockReturnValue(null);
});

describe('MfaEnrolmentNudge — when it speaks', () => {
  it('asks a password-only account to protect itself, and points at the passkey section', async () => {
    await renderNudge(PASSWORD_ONLY);
    const banner = screen.getByRole('status', { name: /protect your account/i });
    expect(banner.textContent).toMatch(/protected by a password alone/i);
    // Passkey first: strongest and fastest, and the section it lands on carries
    // the authenticator app and the recovery codes beneath it.
    expect(screen.getByRole('link', { name: /protect my account/i }))
      .toHaveAttribute('href', '/dashboard/security?tab=factors#passkeys');
  });

  it('announces politely, not assertively — this is an opportunity, not a deadline', async () => {
    await renderNudge(PASSWORD_ONLY);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('says nothing to an account that already holds a passkey', async () => {
    await renderNudge({ ...PASSWORD_ONLY, authFactors: { hasPassword: true, passkeyCount: 1, hasTotp: false, providers: [] } });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('says nothing to an account with an authenticator app', async () => {
    await renderNudge({ ...PASSWORD_ONLY, authFactors: { hasPassword: true, passkeyCount: 0, hasTotp: true, providers: [] } });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('says nothing when the factors are unknown — never nag on a guess', async () => {
    await renderNudge({ id: 'u1' });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('stands down while the ORG policy banner has the floor', async () => {
    // Two stacked MFA banners is how both get ignored, and that one carries a
    // deadline this one does not.
    await renderNudge({ ...PASSWORD_ONLY, mfaPolicy: { requireMfa: true, enforced: false, graceUntil: IN_THREE_DAYS, aal: 1 } });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('stays quiet during a live snooze', async () => {
    await renderNudge({ ...PASSWORD_ONLY, mfaNudge: { snoozedUntil: IN_THREE_DAYS } });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('comes back once the snooze has run out', async () => {
    await renderNudge({ ...PASSWORD_ONLY, mfaNudge: { snoozedUntil: YESTERDAY } });
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('stays quiet after "don\'t ask again"', async () => {
    await renderNudge({ ...PASSWORD_ONLY, mfaNudge: { declinedAt: YESTERDAY } });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('never nags an operator viewing someone else\'s account', async () => {
    // They cannot enrol for that person, and must not be able to answer for
    // them either.
    isImpersonating.mockReturnValue(true);
    await renderNudge(PASSWORD_ONLY);
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('MfaEnrolmentNudge — taking no for an answer', () => {
  it('"Not now" records a snooze server-side and re-reads the profile', async () => {
    await renderNudge(PASSWORD_ONLY);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /not now/i })); });
    expect(snoozeMfaPrompt).toHaveBeenCalled();
    // Persisted, not remembered in this tab: a prompt that returns at the next
    // sign-in is what trains people to dismiss without reading.
    await waitFor(() => expect(refreshUser).toHaveBeenCalledWith({ force: true }));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('"Don\'t ask again" records a decline', async () => {
    await renderNudge(PASSWORD_ONLY);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /don.t ask again/i })); });
    expect(declineMfaPrompt).toHaveBeenCalled();
    await waitFor(() => expect(refreshUser).toHaveBeenCalledWith({ force: true }));
  });

  it('spells the decline out rather than hiding it behind a close icon', async () => {
    await renderNudge(PASSWORD_ONLY);
    // An X reads as "hide this once"; this choice lasts until it is reversed.
    expect(screen.queryByRole('button', { name: /^(close|dismiss)$/i })).toBeNull();
    expect(screen.getByRole('button', { name: /don.t ask again/i })).toBeInTheDocument();
  });

  it('is a banner, not a modal — nothing is trapped and nothing is blocked', async () => {
    await renderNudge(PASSWORD_ONLY);
    expect(screen.queryByRole('dialog')).toBeNull();
    // Every control is reachable and named.
    for (const el of [
      screen.getByRole('link', { name: /protect my account/i }),
      screen.getByRole('button', { name: /not now/i }),
      screen.getByRole('button', { name: /don.t ask again/i }),
    ]) expect(el).toBeVisible();
  });
});

describe('MfaEnrolmentNudge — the bootstrap administrator', () => {
  it('prompts them first, since they are exactly who should enrol first', async () => {
    getAccessToken.mockReturnValue(enrolmentPendingToken());
    await renderNudge(PASSWORD_ONLY);
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /protect my account/i })).toBeInTheDocument();
  });

  it('offers them no way to postpone, and says why — matching the exception\'s own messaging', async () => {
    // Their session may reach enrolment, sign-out and the setup routes and
    // nothing else, so a "not now" button would be a promise it cannot keep.
    getAccessToken.mockReturnValue(enrolmentPendingToken());
    await renderNudge(PASSWORD_ONLY);
    expect(screen.queryByRole('button', { name: /not now/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /don.t ask again/i })).toBeNull();
    expect(screen.getByRole('status').textContent).toMatch(/this session can only finish setting one up/i);
    // And it does not claim MFA is "off" for them — there is no such flag.
    expect(screen.getByRole('status').textContent).not.toMatch(/disabled|turned off/i);
  });
});

describe('MfaPromptPreference — the way back', () => {
  const onChanged = jest.fn(async () => undefined);

  it('shows nothing when nothing is suppressed', () => {
    render(<MfaPromptPreference readOnly={false} onChanged={onChanged} />);
    expect(screen.queryByText(/reminders to add a second factor/i)).toBeNull();
  });

  it('states a decline and offers to undo it', async () => {
    render(<MfaPromptPreference nudge={{ declinedAt: YESTERDAY }} readOnly={false} onChanged={onChanged} />);
    expect(screen.getByText(/not to be reminded again/i)).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /remind me again/i })); });
    expect(restoreMfaPrompt).toHaveBeenCalled();
    // The page re-reads the profile, so the banner comes back on the next view.
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('states a snooze with its deadline', () => {
    render(<MfaPromptPreference nudge={{ snoozedUntil: IN_THREE_DAYS }} readOnly={false} onChanged={onChanged} />);
    expect(screen.getByText(/reminders are paused until/i)).toBeInTheDocument();
  });

  it('never claims to control whether MFA is on — only whether we remind', () => {
    render(<MfaPromptPreference nudge={{ declinedAt: YESTERDAY }} readOnly={false} onChanged={onChanged} />);
    expect(screen.getByText(/only controls whether we remind you/i)).toBeInTheDocument();
    expect(screen.queryByRole('switch')).toBeNull();
  });
});
