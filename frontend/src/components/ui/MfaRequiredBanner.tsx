// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { PASSKEY_ENROLMENT_HREF } from '@/lib/security-links';

/** Where enrolment lives. Both anchors exist on the security tab. */
const ENROL_HREF = PASSKEY_ENROLMENT_HREF;

/** Whole days between now and `iso`, floored at 0. */
function daysUntil(iso: string): number {
  const ms = new Date(iso).getTime() - Date.now();
  return ms <= 0 ? 0 : Math.ceil(ms / (24 * 60 * 60 * 1000));
}

/**
 * Tells a member that their organization requires two-factor authentication
 * — and, crucially, tells them BEFORE the deadline rather than by failing
 * their next sign-in.
 *
 * Four states, all driven by `user.mfaPolicy`, which the profile endpoint sends
 * only for orgs that actually require MFA:
 *
 *   - the session is already MFA-grade (`aal: 2`) → nothing is shown. Nagging
 *     someone who has complied is how banners get ignored;
 *   - a grace period is still running → a warning with the deadline and a day
 *     count, so "two weeks" is a date rather than a feeling;
 *   - the grace period has passed → the session is living on borrowed time: it
 *     works until it next needs re-issuing, and then stops. Say so plainly;
 *   - the person's factors were RESET by their admins → they are inside their
 *     own enrolment grace (`resetGraceUntil`), the one window in which they can
 *     sign in without a factor to enrol a new one. Say by when.
 *
 * Deliberately NOT dismissible. The quota banner can be dismissed because the
 * worst case is a rejected request; here the worst case is being unable to sign
 * in at all, and the fix takes a minute.
 */
export function MfaRequiredBanner() {
  const { user } = useAuth();
  const policy = user?.mfaPolicy;
  // A just-enrolled passkey doesn't raise THIS session's `aal` (only a fresh
  // sign-in does), so re-reading the profile on mount is what makes the banner
  // disappear after the person signs back in rather than lingering for the life
  // of the tab.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!mounted || !policy || policy.aal >= 2) return null;

  const days = policy.graceUntil ? daysUntil(policy.graceUntil) : 0;
  const deadline = policy.graceUntil
    ? new Date(policy.graceUntil).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
    : null;

  // An approved MFA reset: the org still requires MFA, but not of this person
  // until their own enrolment grace ends. That deadline is the one that matters.
  const resetDeadline = policy.resetGraceUntil
    ? new Date(policy.resetGraceUntil).toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' })
    : null;

  const enforced = !resetDeadline && (policy.enforced || !deadline);
  const container = enforced
    ? 'bg-danger-bg border-danger-border text-danger-strong'
    : 'bg-warning-bg border-warning-border text-warning-strong';
  const Icon = enforced ? ShieldAlert : ShieldCheck;

  return (
    <div className={`border-b px-4 sm:px-6 lg:px-8 py-2.5 ${container}`} role="status">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <Icon className="w-4 h-4 shrink-0" aria-hidden />
        <span className="flex-1 min-w-0">
          {resetDeadline ? (
            <>
              <strong>Your two-factor authentication was reset by your organization&apos;s admins.</strong>{' '}
              Add a passkey or an authenticator app before {resetDeadline} — after that you will not be able
              to sign in without one. Then sign in again with it.
            </>
          ) : enforced ? (
            <>
              <strong>Your organization requires two-factor authentication.</strong>{' '}
              This session was opened with one factor, so it will stop working the next time it
              is renewed. Add a passkey or an authenticator app, then sign in again.
            </>
          ) : (
            <>
              <strong>Your organization will require two-factor authentication
                {days === 0 ? ' today' : days === 1 ? ' tomorrow' : ` in ${days} days`}.</strong>{' '}
              After {deadline} you will not be able to sign in without a passkey or an
              authenticator app.
            </>
          )}
        </span>
        <Link href={ENROL_HREF} className="font-medium underline underline-offset-2 whitespace-nowrap">
          Set it up now
        </Link>
      </div>
    </div>
  );
}
