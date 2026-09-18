// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Turning WebAuthn's DOMExceptions into something a person can act on.
 *
 * The browser reports every ceremony outcome as a `DOMException`, and the most
 * common one by far — `NotAllowedError` — means "the user dismissed the prompt,
 * or it timed out". That is a CANCEL, not a failure: showing a red banner for it
 * would scold people for closing a dialog they opened by accident. So it maps to
 * `null`, and callers render nothing.
 *
 * The rest carry a specific, non-generic explanation, because the generic
 * message ("The operation either timed out or was not allowed") tells the user
 * nothing they can do something about.
 */

import { formatError } from './constants';

/** The DOM error names a ceremony can realistically end with. */
const MESSAGES: Record<string, string> = {
  // The same authenticator is already enrolled — `excludeCredentials` is what
  // produced this, so it is a duplicate, not a fault.
  InvalidStateError: 'This passkey is already registered',
  // The RP ID doesn't match the page's origin. Almost always a deployment
  // mismatch rather than anything the person did.
  SecurityError: 'Passkeys aren\'t available on this domain. Contact your administrator.',
  // No authenticator could satisfy the request (no platform authenticator, or an
  // algorithm/transport nothing on the device supports).
  NotSupportedError: 'This device can\'t create a passkey',
  ConstraintError: 'This device can\'t create a passkey that meets the security requirements',
};

/**
 * The message to show for a failed ceremony, or `null` when the person simply
 * cancelled (or let it time out) and nothing should be shown.
 */
export function webauthnErrorMessage(err: unknown, fallback = 'Passkey request failed'): string | null {
  const name = (err as { name?: string } | null)?.name;
  if (name === 'NotAllowedError' || name === 'AbortError') return null;
  if (name && MESSAGES[name]) return MESSAGES[name];
  return formatError(err, fallback);
}

/** True when the failure was the person cancelling the browser's prompt. */
export function isWebAuthnCancel(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === 'NotAllowedError' || name === 'AbortError';
}
