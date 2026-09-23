// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Passkey (WebAuthn) error codes.
 *
 * Thrown by `services/webauthn-service.ts` and answered with the HTTP status in
 * {@link WEBAUTHN_ERROR_MAP} below. Dependency-free on purpose (see
 * `auth-errors.ts`): controllers and tests import the codes without loading the
 * service, its models or the SimpleWebAuthn runtime.
 */

import type { ErrorMap } from '../helpers/controller-helper.js';

/** The ceremony id is unknown, expired, already consumed, or was minted for
 *  someone else. Deliberately one code for all four — telling them apart is a
 *  probing oracle. → 403 */
export const WEBAUTHN_INVALID_CEREMONY = 'WEBAUTHN_INVALID_CEREMONY';
/** The authenticator's response failed verification (signature, origin, RP ID,
 *  user verification, challenge). → 400 */
export const WEBAUTHN_VERIFICATION_FAILED = 'WEBAUTHN_VERIFICATION_FAILED';
/** This authenticator is already registered — on this account or another. → 409 */
export const WEBAUTHN_CREDENTIAL_EXISTS = 'WEBAUTHN_CREDENTIAL_EXISTS';
/** No such passkey for this user (rename/remove of an id they don't own). → 404 */
export const WEBAUTHN_CREDENTIAL_NOT_FOUND = 'WEBAUTHN_CREDENTIAL_NOT_FOUND';
/** Step-up was asked for but the account has registered no passkey. → 409 */
export const WEBAUTHN_NO_CREDENTIALS = 'WEBAUTHN_NO_CREDENTIALS';
/** Removing this passkey would leave the account with no way to sign in at
 *  all (no password, no linked provider, no other passkey). → 409 */
export const WEBAUTHN_LAST_SIGN_IN_METHOD = 'WEBAUTHN_LAST_SIGN_IN_METHOD';
/** The authenticator's signature counter went BACKWARDS — the classic cloned-
 *  credential signal. Refused and audited. → 403 */
export const WEBAUTHN_COUNTER_REGRESSION = 'WEBAUTHN_COUNTER_REGRESSION';
/** The active org allowlists authenticator models and this passkey's model
 *  (AAGUID) is not on the list, or MDS reports the model compromised. → 403 */
export const WEBAUTHN_AUTHENTICATOR_NOT_ALLOWED = 'WEBAUTHN_AUTHENTICATOR_NOT_ALLOWED';
/** The active org allowlists authenticator models, but this registration's
 *  attestation could not be verified (no attestation, self attestation, a model
 *  the FIDO Metadata Service does not know, or no metadata loaded). → 403 */
export const WEBAUTHN_ATTESTATION_UNVERIFIABLE = 'WEBAUTHN_ATTESTATION_UNVERIFIABLE';

/** The HTTP answer for each passkey sentinel above — kept beside the codes,
 *  the same convention as `totp-errors.ts`, so a new sentinel and its refusal
 *  land in one file. */
export const WEBAUTHN_ERROR_MAP: ErrorMap = {
  [WEBAUTHN_INVALID_CEREMONY]: { status: 403, message: 'This passkey request expired or was already used. Please try again.' },
  [WEBAUTHN_VERIFICATION_FAILED]: { status: 400, message: 'That passkey could not be verified' },
  [WEBAUTHN_CREDENTIAL_EXISTS]: { status: 409, message: 'This passkey is already registered' },
  [WEBAUTHN_CREDENTIAL_NOT_FOUND]: { status: 404, message: 'Passkey not found' },
  [WEBAUTHN_NO_CREDENTIALS]: { status: 409, message: 'This account has no passkeys' },
  [WEBAUTHN_LAST_SIGN_IN_METHOD]: {
    status: 409,
    message: 'This is the only way you can sign in. Set a password or add another passkey first.',
  },
  [WEBAUTHN_COUNTER_REGRESSION]: { status: 403, message: 'That passkey could not be verified' },
  [WEBAUTHN_AUTHENTICATOR_NOT_ALLOWED]: {
    status: 403,
    message: 'Your organization does not allow this kind of passkey. Use one of the security keys or authenticators it has approved.',
    code: WEBAUTHN_AUTHENTICATOR_NOT_ALLOWED,
  },
  [WEBAUTHN_ATTESTATION_UNVERIFIABLE]: {
    status: 403,
    message: 'Your organization only accepts approved authenticators, and this one could not prove its make and model. Use an approved security key or authenticator.',
    code: WEBAUTHN_ATTESTATION_UNVERIFIABLE,
  },
};
