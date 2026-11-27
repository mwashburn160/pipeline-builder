// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The activity signal a client sends with `POST /auth/refresh` (body field
 * `activity`).
 *
 * `user`: there was real input (pointer, key, touch, scroll) since the
 * client's last refresh, so an interactive session's idle clock restarts.
 * `passive`: none — a background poll renewing the token of an unattended
 * tab; the idle clock stays where it was. Anything unsaid is `passive`, so a
 * client that never reports activity reaches its idle timeout.
 */
export type SessionActivity = 'user' | 'passive';

/** Read the activity signal from a request value: only the exact `'user'` counts. */
export function parseSessionActivity(value: unknown): SessionActivity {
  return value === 'user' ? 'user' : 'passive';
}
