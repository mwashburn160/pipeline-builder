// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * What an account can still get in with — the one place that question is
 * answered, so the passkey guard and the TOTP guard can never disagree about it.
 *
 * The distinction that matters: a SIGN-IN method opens a session on its own (a
 * password, a linked social/SSO identity, a passkey). TOTP does NOT — it is a
 * second factor layered on a password sign-in, so an account whose only
 * credential is TOTP cannot sign in at all. That is why `hasTotp` is reported
 * here but never counted as a way in.
 *
 * Used by:
 *   - `services/webauthn-service.ts` — refusing to remove the last passkey when
 *     it is the only way in;
 *   - `services/totp-service.ts` — the same guard for disabling TOTP.
 */

import { User, WebAuthnCredential, UserTotp } from '../models/index.js';

/** Everything either last-factor guard needs, in one read per collection. */
export interface SignInMethods {
  /** The account has a password hash (email/password signup, or one set later). */
  hasPassword: boolean;
  /** At least one linked social/SSO identity that could sign in. */
  hasProvider: boolean;
  /** Registered passkeys. */
  passkeyCount: number;
  /** A CONFIRMED authenticator-app enrolment (pending ones don't count). */
  hasTotp: boolean;
}

/** Load the account's credentials. The password hash is read only to derive
 *  `hasPassword` and never leaves this function. */
export async function loadSignInMethods(userId: string): Promise<SignInMethods> {
  const [user, passkeyCount, totp] = await Promise.all([
    User.findById(userId).select('+password oauth').lean() as Promise<
    { password?: string; oauth?: Record<string, { id?: string } | undefined> } | null>,
    WebAuthnCredential.countDocuments({ userId }),
    UserTotp.exists({ userId, activatedAt: { $ne: null } }),
  ]);
  return {
    hasPassword: typeof user?.password === 'string' && user.password.length > 0,
    hasProvider: Object.values(user?.oauth ?? {}).some((link) => !!link?.id),
    passkeyCount,
    hasTotp: !!totp,
  };
}

/**
 * Whether anything would still open a session after removing one credential.
 *
 * `removing` names what is about to go: one passkey (so the account needs a
 * password, a provider, or ANOTHER passkey) or the TOTP enrolment (which was
 * never a way in by itself, so this only fires for an account that somehow has
 * no sign-in credential left at all — a guard that costs nothing and would
 * otherwise be the one case nobody checked).
 */
export function retainsSignInMethod(methods: SignInMethods, removing: 'passkey' | 'totp'): boolean {
  if (methods.hasPassword || methods.hasProvider) return true;
  return removing === 'passkey' ? methods.passkeyCount > 1 : methods.passkeyCount > 0;
}
