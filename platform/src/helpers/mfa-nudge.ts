// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The PASSWORD-ONLY PROMPT: asking an account that has no second factor to get
 * one, and remembering when it has asked us to stop.
 *
 * WHY THERE IS NO "ENABLE MFA" SETTING. Whether an account is protected is
 * DERIVED from what it holds — a passkey, or a confirmed authenticator
 * enrolment (`helpers/auth-factors.ts`, and `utils/token.ts` at issuance).
 * A per-user on/off flag would be a second source of truth that could disagree
 * with the factors themselves, and it would collide with the org's `requireMfa`
 * policy, which has its own grace deadline and strictest-wins inheritance.
 * Enrolling IS enabling; removing the last factor IS disabling. What was
 * genuinely missing is the ASK: `MfaRequiredBanner` only fires on a policy
 * deadline, so a member of an org that does not mandate MFA was never invited
 * to protect their own account.
 *
 * So the only state here is about the prompt:
 *
 *   - `snoozedUntil` — "Not now", for {@link SNOOZE_DAYS} days. Persisted
 *     server-side rather than in the browser because a prompt that returns at
 *     the next sign-in (or on the next device) is exactly what teaches people
 *     to dismiss banners unread;
 *   - `declinedAt` — "Don't ask again". Deliberate, durable, and reversible by
 *     the person from the Security page ({@link clearMfaNudge}).
 *
 * Neither weakens anything: no route, policy or session changes because a
 * banner is hidden. That is why the endpoints that write them are plain
 * authenticated own-account calls with no step-up and no permission.
 *
 * STALE STATE IS IMPOSSIBLE BY CONSTRUCTION. {@link clearMfaNudge} runs on the
 * first enrolment of any factor, so a person who enrols and later removes their
 * last factor is prompted again rather than silenced by a decline they made
 * months earlier. The profile read also refuses to report the state at all for
 * an account that holds a factor, so even a write that somehow escaped the
 * clear cannot suppress a future prompt.
 */

import { User } from '../models/index.js';

/**
 * How long "Not now" lasts.
 *
 * A week is the shortest window that actually changes behaviour: it survives
 * "I'll do it after this deploy" and the weekend that follows, so the person is
 * asked again in a different frame of mind rather than in the same one. Longer
 * (a month, a quarter) is indistinguishable from "don't ask again" without
 * being the deliberate choice that "don't ask again" is — and that choice
 * exists, one button away, for anyone who means it.
 */
export const SNOOZE_DAYS = 7;

/** What `GET /user/profile` reports about the prompt. Dates as ISO strings. */
export interface MfaNudgeView {
  /** Prompt suppressed until this moment. Omitted once it has passed. */
  snoozedUntil?: string;
  /** The person asked not to be prompted again. */
  declinedAt?: string;
}

/** The stored shape, as read off the user document. */
export interface StoredMfaNudge {
  snoozedUntil?: Date | null;
  declinedAt?: Date | null;
}

/**
 * The wire view of `user.mfaNudge`, or `undefined` when there is nothing to
 * report. An EXPIRED snooze is reported as nothing rather than as a past date:
 * the client's only question is "is the prompt suppressed right now", and a
 * stale deadline is one more thing for it to get wrong.
 */
export function mfaNudgeView(stored: StoredMfaNudge | null | undefined): MfaNudgeView | undefined {
  if (!stored) return undefined;
  const snoozedUntil = stored.snoozedUntil ? new Date(stored.snoozedUntil) : null;
  const declinedAt = stored.declinedAt ? new Date(stored.declinedAt) : null;
  const view: MfaNudgeView = {
    ...(snoozedUntil && snoozedUntil.getTime() > Date.now() ? { snoozedUntil: snoozedUntil.toISOString() } : {}),
    ...(declinedAt ? { declinedAt: declinedAt.toISOString() } : {}),
  };
  return Object.keys(view).length > 0 ? view : undefined;
}

/**
 * What `GET /user/profile` should report, given the account's factors.
 *
 * Two refusals, both deliberate:
 *   - factors UNKNOWN (the profile could not resolve them) reports nothing, so
 *     the shell never prompts on a guess;
 *   - factors PRESENT reports nothing, because the prompt has no meaning for a
 *     protected account. That is also the belt to the braces of clearing the
 *     state at enrolment: a decline that somehow outlived the clear still
 *     cannot suppress a future prompt, because it is never sent while a factor
 *     exists, and it is gone by the time one does not.
 */
export function reportableMfaNudge(
  factors: { passkeyCount: number; hasTotp: boolean } | undefined,
  stored: StoredMfaNudge | null | undefined,
): MfaNudgeView | undefined {
  if (!factors) return undefined;
  if (factors.passkeyCount > 0 || factors.hasTotp) return undefined;
  return mfaNudgeView(stored);
}

/**
 * Suppress the prompt for {@link SNOOZE_DAYS} days.
 *
 * The deadline is computed HERE, never posted by the client — the same rule the
 * org MFA policy follows for its grace period. A client-chosen date is a
 * client-chosen "never".
 *
 * @returns the new deadline.
 */
export async function snoozeMfaNudge(userId: string): Promise<Date> {
  const snoozedUntil = new Date(Date.now() + SNOOZE_DAYS * 24 * 60 * 60 * 1000);
  // Only the deadline: a snooze taken after a decline (the person reversed the
  // decline and then said "later") must not resurrect the decline, and the
  // decline is cleared on its own path, so the two fields never fight.
  await User.updateOne({ _id: userId }, { $set: { 'mfaNudge.snoozedUntil': snoozedUntil } });
  return snoozedUntil;
}

/**
 * Stop prompting this account until it asks to be prompted again.
 *
 * The snooze is dropped in the same write: a deadline underneath a decline
 * would silently re-arm the prompt the day the decline was reversed, which is
 * not what either word means.
 *
 * @returns when the decline was recorded.
 */
export async function declineMfaNudge(userId: string): Promise<Date> {
  const declinedAt = new Date();
  await User.updateOne(
    { _id: userId },
    { $set: { 'mfaNudge.declinedAt': declinedAt }, $unset: { 'mfaNudge.snoozedUntil': '' } },
  );
  return declinedAt;
}

/**
 * Forget both, so the account is prompted normally again.
 *
 * Two callers, for one reason. The person can ask for it from the Security page
 * ("don't ask again" has to be reversible by the person who chose it), and
 * every enrolment path calls it so a factor makes the suppression irrelevant
 * rather than leaving it to outlive the factor it was traded for.
 *
 * Unsets the whole subdocument rather than blanking its fields: "never asked"
 * and "asked, then cleared" are the same state, and should look the same.
 */
export async function clearMfaNudge(userId: string): Promise<void> {
  await User.updateOne({ _id: userId }, { $unset: { mfaNudge: '' } });
}
