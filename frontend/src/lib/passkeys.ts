// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The three passkey ceremonies, each as one call.
 *
 * Every ceremony is the same shape — ask the server for a challenge, hand it to
 * the browser, send the authenticator's reply back — so it lives here once
 * rather than in each of the three components that need it. Components import
 * from this module and never touch `@simplewebauthn/browser` directly, which
 * also keeps the library out of every test that renders one of them.
 *
 * Errors are left as the browser threw them: `webauthnErrorMessage`
 * (lib/webauthn.ts) is what decides whether the user sees anything, and a
 * cancelled prompt must stay silent.
 */

import { startAuthentication, startRegistration, WebAuthnAbortService } from '@simplewebauthn/browser';
import api from './api';
import type { Passkey } from '@/types';

export {
  browserSupportsWebAuthn,
  browserSupportsWebAuthnAutofill,
} from '@simplewebauthn/browser';

/**
 * Cancel whatever ceremony is in flight.
 *
 * Only one WebAuthn request can be outstanding per page, so the autofill
 * request the sign-in page starts on mount has to be torn down before anything
 * else — submitting a password, or clicking the explicit passkey button — can
 * start its own.
 */
export function cancelPasskeyCeremony(): void {
  WebAuthnAbortService.cancelCeremony();
}

/**
 * Enrol a new passkey. `stepUpToken` comes from a StepUpModal — the server gates
 * the challenge on it, so an account without a password earns it by
 * re-authenticating with its own provider.
 */
export async function registerPasskey(name: string, stepUpToken?: string): Promise<{ passkey: Passkey; recoveryCodes?: string[] }> {
  const optionsRes = await api.getPasskeyRegistrationOptions(stepUpToken);
  const pending = optionsRes.data;
  if (!pending) throw new Error(optionsRes.message || 'Could not start passkey registration');

  const response = await startRegistration({ optionsJSON: pending.options });

  const verified = await api.verifyPasskeyRegistration({ ceremonyId: pending.ceremonyId, response, name });
  if (!verified.data?.passkey) throw new Error(verified.message || 'Could not register the passkey');
  // The account's recovery codes ride along — once — when this passkey is its
  // FIRST second factor.
  return { passkey: verified.data.passkey, ...(verified.data.recoveryCodes?.length ? { recoveryCodes: verified.data.recoveryCodes } : {}) };
}

/** Earn a step-up token with a passkey. Same token the password path issues. */
export async function stepUpWithPasskey(): Promise<string> {
  const optionsRes = await api.getPasskeyStepUpOptions();
  const pending = optionsRes.data;
  if (!pending) throw new Error(optionsRes.message || 'Could not start passkey confirmation');

  const response = await startAuthentication({ optionsJSON: pending.options });

  const verified = await api.verifyPasskeyStepUp({ ceremonyId: pending.ceremonyId, response });
  if (!verified.data?.stepUpToken) throw new Error(verified.message || 'Could not confirm with that passkey');
  return verified.data.stepUpToken;
}

/**
 * Sign in with a passkey, either from the explicit button or from the browser's
 * autofill dropdown (`autofill: true` — "conditional UI", which waits silently
 * until the person picks a credential instead of opening a modal).
 *
 * Resolves once the session is established (the API client has applied the
 * tokens); the caller refreshes the profile and navigates.
 */
export async function signInWithPasskey(opts: { autofill?: boolean } = {}): Promise<void> {
  const optionsRes = await api.getPasskeyLoginOptions();
  const pending = optionsRes.data;
  if (!pending) throw new Error(optionsRes.message || 'Passkey sign-in is unavailable');

  const response = await startAuthentication({
    optionsJSON: pending.options,
    useBrowserAutofill: opts.autofill === true,
  });

  const result = await api.completePasskeyLogin({ ceremonyId: pending.ceremonyId, response });
  if (!result.success) throw new Error(result.message || 'Passkey sign-in failed');
}
