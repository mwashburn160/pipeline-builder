// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Passkey (WebAuthn) error codes.
 *
 * Thrown by `services/webauthn-service.ts` and mapped to HTTP status in
 * `controllers/webauthn.ts`. Dependency-free on purpose (see `auth-errors.ts`):
 * controllers and tests import the codes without loading the service, its models
 * or the SimpleWebAuthn runtime.
 */

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
