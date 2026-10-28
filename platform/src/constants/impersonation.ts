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
 * `envInt` through the `lib/*` SUBPATH, never the api-core barrel. This module's
 * whole point is that it pulls in nothing (see the note above), and the barrel
 * would drag express + the service graph into a middleware and into every suite
 * that mocks it — a suite mocking `@pipeline-builder/api-core` partially would
 * also make `envInt` throw, because `stubModule` refuses a non-overridden
 * export. `utils/env.ts` has NO imports of its own, so the subpath stays a leaf.
 * It is the shared reader rather than a local `Number(...)` so the strictness
 * (decimals, garbage, bounds) is the same one every other knob gets, and so the
 * env-documented guard can see these names.
 */
import { envInt } from '@pipeline-builder/api-core/lib/utils/env.js';

/**
 * How long an issued impersonation SESSION token lives. The single source of
 * truth: the token helper mints with it and the sessions list bounds "live" by
 * it. Two copies would drift, and the list would then offer to revoke sessions
 * that already ended, or hide ones still running.
 *
 * Env-tunable because the acceptable window is a POLICY question, not a
 * technical one: an org under a strict access-review regime wants minutes, and
 * the only way to get that was editing this file. Floored at 60s — a window
 * shorter than the sign-in it authorizes cannot be used at all.
 */
export const IMPERSONATION_SESSION_TTL_MS = envInt('IMPERSONATION_SESSION_TTL_MS', 15 * 60 * 1000, { min: 60_000 });

/** How long an approval (or a pending request) stays redeemable. Env-tunable for
 *  the same reason as the session TTL: how long a consent may sit unanswered is
 *  the customer's policy. Floored at 60s. */
export const IMPERSONATION_REQUEST_TTL_MS = envInt('IMPERSONATION_REQUEST_TTL_MS', 60 * 60 * 1000, { min: 60_000 });

/** A duration in whole minutes or hours, for user-facing text ("15 minutes", "1 hour"). */
export function describeDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}
