// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ShieldPlus } from 'lucide-react';
import api from '@/lib/api';
import { useAuth } from '@/hooks/useAuth';
import { decodeJwt } from '@/lib/jwt';
import { PASSKEY_ENROLMENT_HREF } from '@/lib/security-links';
import type { User } from '@/types';

/**
 * "This account is protected by a password alone" — the prompt for everyone
 * `MfaRequiredBanner` never speaks to.
 *
 * That banner fires on an org POLICY deadline, so a member of an org that does
 * not mandate MFA is never asked to protect their own account: the platform
 * knew the account was password-only and said nothing. This asks, once, in the
 * same place and the same shape, and takes no for an answer.
 *
 * There is NO "enable MFA" switch behind it, deliberately. Being protected is
 * derived from the factors the account holds (`user.authFactors`), so a boolean
 * setting would be a second source of truth able to contradict reality and to
 * collide with the org policy. Enrolling is the enable; removing the last
 * factor is the disable. The link therefore leads into the real enrolment —
 * passkey first (strongest and fastest), the authenticator app beneath it, and
 * recovery codes issued by whichever of them comes first — rather than flipping
 * anything here.
 *
 * SHOWN ONLY WHEN ALL OF:
 *   - the profile reports factors and there is none (no passkey, no confirmed
 *     authenticator). Unknown factors mean silence: never nag on a guess;
 *   - the org's MFA banner is NOT showing. `MfaRequiredBanner` renders whenever
 *     `user.mfaPolicy` is present and the session is below `aal: 2` — and an
 *     account with no factor cannot be at `aal: 2` — so the presence of
 *     `mfaPolicy` alone is exactly "that banner has the floor". Two stacked MFA
 *     banners is how both get ignored;
 *   - nothing is suppressing it: no live snooze, no decline (`user.mfaNudge`,
 *     which the server sends only while a suppression is in force);
 *   - the session is not a read-only impersonation. An operator looking at
 *     someone else's account cannot enrol for them, and must not be able to
 *     snooze or decline on their behalf either.
 *
 * A BANNER, NOT A MODAL: nothing is trapped, nothing is blocked. It announces
 * politely (`role="status"`) because it is an opportunity, not an emergency —
 * `MfaRequiredBanner`'s deadline is the emergency — and it is fully keyboard
 * reachable, with the region and every control named.
 *
 * THE BOOTSTRAP ADMIN sees it first and with no way out, which is correct: the
 * install's only admin (`helpers/bootstrap-admin.ts`) holds a single-factor
 * session that may reach enrolment, sign-out and the setup routes and nothing
 * else, every use of it is audited, and it closes for good at the first
 * enrolment. "Not now" would be a promise the session cannot keep — the
 * snooze call is not one of the routes it may make — so those controls are
 * replaced by the reason, which agrees with what the sign-in already told them.
 */

/** Does the profile say this account holds no second factor? `null` = unknown. */
function isPasswordOnly(user: User | null): boolean | null {
  const f = user?.authFactors;
  if (!f) return null;
  return f.passkeyCount === 0 && !f.hasTotp;
}

/** Is a "not now" / "don't ask again" still in force? */
function isSuppressed(user: User | null): boolean {
  const nudge = user?.mfaNudge;
  if (!nudge) return false;
  if (nudge.declinedAt) return true;
  return !!nudge.snoozedUntil && new Date(nudge.snoozedUntil).getTime() > Date.now();
}

/** Is this the bootstrap admin's enrolment-limited session? */
function isEnrolmentPendingSession(): boolean {
  try {
    const token = api.getAccessToken();
    return !!token && decodeJwt(token)?.payload?.mfaEnrollmentPending === true;
  } catch {
    // A malformed or absent token is not an enrolment session; the ordinary
    // banner is the safe reading.
    return false;
  }
}

export function MfaEnrolmentNudge() {
  const { user, refreshUser } = useAuth();
  // Rendered only after mount: `api.isImpersonating()` and the access token are
  // browser state, and the server render has neither.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  // Local so the banner goes away on click, before the profile round-trip that
  // makes it stay away lands.
  const [answered, setAnswered] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!mounted || answered) return null;
  if (isPasswordOnly(user) !== true) return null;
  // The org's own requirement is being announced right above; it says more, and
  // with a deadline.
  if (user?.mfaPolicy) return null;
  if (isSuppressed(user)) return null;
  if (api.isImpersonating()) return null;

  const enrolmentOnly = isEnrolmentPendingSession();

  /** Record the answer, then re-read the profile so it survives a reload. */
  const answer = async (call: () => Promise<unknown>) => {
    setBusy(true);
    setAnswered(true);
    try {
      await call();
      await refreshUser({ force: true });
    } catch {
      // The banner is already gone for this page view. A failed write means it
      // returns on the next load, which is the safe direction to fail in: the
      // account is still password-only either way.
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="status"
      aria-label="Protect your account"
      className="border-b border-info-border bg-info-bg px-4 py-2.5 text-info-strong sm:px-6 lg:px-8"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <ShieldPlus className="h-4 w-4 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1">
          <strong>Your account is protected by a password alone.</strong>{' '}
          {enrolmentOnly
            ? 'Until you add a passkey or an authenticator app, this session can only finish setting one up — every sign-in like it is recorded.'
            : 'Add a passkey — or an authenticator app — so a stolen password is not enough to sign in as you. It takes about a minute.'}
        </span>
        <Link href={PASSKEY_ENROLMENT_HREF} className="whitespace-nowrap font-medium underline underline-offset-2">
          Protect my account
        </Link>
        {!enrolmentOnly && (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => void answer(() => api.snoozeMfaPrompt())}
              className="whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-medium underline underline-offset-2 hover:bg-black/5 disabled:opacity-60 dark:hover:bg-white/10"
            >
              Not now for a week
            </button>
            {/* Spelled out rather than an X. A close icon reads as "hide this
                once", and this choice lasts until the person reverses it on the
                Security page — the label has to say so. */}
            <button
              type="button"
              disabled={busy}
              onClick={() => void answer(() => api.declineMfaPrompt())}
              className="whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-medium underline underline-offset-2 hover:bg-black/5 disabled:opacity-60 dark:hover:bg-white/10"
            >
              Don&apos;t ask again
            </button>
          </>
        )}
      </div>
    </div>
  );
}
