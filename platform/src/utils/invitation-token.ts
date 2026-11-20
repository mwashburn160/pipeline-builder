// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Invitation tokens at rest. The token is a bearer credential (anyone holding it
 * can accept), so an invitation row stores only its SHA-256 (`tokenHash`) and
 * every lookup — accept, preview, registration by invitation — queries by hash.
 * The plaintext exists only in the emailed accept link (and, once, in the send /
 * resend response when no email carried it).
 */

import crypto from 'crypto';

/** SHA-256 (hex) of a plaintext invitation token. */
export function hashInvitationToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** A fresh invitation token: the plaintext for the link and the hash to store. */
export function generateInvitationToken(): { token: string; tokenHash: string } {
  const token = crypto.randomBytes(32).toString('hex');
  return { token, tokenHash: hashInvitationToken(token) };
}
