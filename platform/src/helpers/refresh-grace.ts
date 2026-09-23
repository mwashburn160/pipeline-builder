// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Refresh-rotation GRACE: the answer to "two tabs (or a CLI retry) refreshed
 * with the same token at the same moment".
 *
 * Rotation is single-use by design — of two racing uses of one refresh token,
 * exactly one wins the atomic swap (`renewSessionTokens`). Without a grace, the
 * loser reads as token REUSE and its slot is revoked: an ordinary race signs the
 * person out. So the winner parks the pair it just minted under the hash of the
 * token it rotated AWAY, for {@link REFRESH_GRACE_MS}; a loser presenting that
 * immediately-previous token inside the window is handed the SAME current pair
 * instead of being revoked. Past the window, a previous token is reuse again.
 *
 * Only the immediately previous token is honoured (the entry is keyed by it and
 * holds the pair that replaced it), and only for the same user + slot. Backed by
 * the shared pending-state store, so it works across replicas.
 */

import { createPendingStateStore } from './pending-state-store.js';
import type { IssuedTokens } from '../services/session/refresh-sessions.js';

/** How long a just-rotated refresh token still yields the pair that replaced it. */
const REFRESH_GRACE_MS = 30_000;

interface GraceEntry {
  userId: string;
  sessionId: string;
  tokens: IssuedTokens;
}

const graceStore = createPendingStateStore<GraceEntry>({
  prefix: 'refresh-grace:',
  ttlMs: REFRESH_GRACE_MS,
  cleanupIntervalMs: 60_000,
  maxEntries: 10_000,
});

/** Park the pair a successful rotation minted, under the rotated-away token's hash. */
export async function rememberRotation(previousHash: string, entry: GraceEntry): Promise<void> {
  await graceStore.put(previousHash, entry);
}

/**
 * The current pair for a refresh token that was rotated away less than
 * {@link REFRESH_GRACE_MS} ago — for the same user and slot — or null.
 * Read without consuming: every racing loser in the window gets the same pair.
 */
export async function graceTokensFor(previousHash: string, userId: string, sessionId: string): Promise<IssuedTokens | null> {
  const entry = await graceStore.peek(previousHash);
  if (!entry || entry.userId !== userId || entry.sessionId !== sessionId) return null;
  return entry.tokens;
}
