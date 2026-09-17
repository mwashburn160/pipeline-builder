// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Impersonation timing constants.
 *
 * Deliberately in a module with NO imports. The token helper and the request
 * service both need these, and many test suites mock the models barrel with a
 * partial object — importing a constant through that barrel broke every such
 * suite each time a new one was added. A dependency-free module is never mocked
 * and pulls in no mongoose, so it cannot fail that way.
 */

/**
 * How long an issued impersonation SESSION token lives. The single source of
 * truth: the token helper mints with it and the sessions list bounds "live" by
 * it. Two copies would drift, and the list would then offer to revoke sessions
 * that already ended, or hide ones still running.
 */
export const IMPERSONATION_SESSION_TTL_MS = 15 * 60 * 1000; // 15 minutes

/** How long an approval (or a pending request) stays redeemable. */
export const IMPERSONATION_REQUEST_TTL_MS = 60 * 60 * 1000; // 1 hour

/** A duration in whole minutes or hours, for user-facing text ("15 minutes", "1 hour"). */
export function describeDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}
