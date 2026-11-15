// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { AskTurn } from '@/lib/api/domains/ask';

/** The ask service's `history` bounds (api/ask request-schema): at most 20
 *  turns, 8000 characters each, 32,000 in all. A request over any of them is a
 *  400, which would fail every question after a long enough conversation. */
const HISTORY_MAX_TURNS = 20;
const HISTORY_MAX_TURN_CHARS = 8000;
const HISTORY_MAX_TOTAL_CHARS = 32_000;

/**
 * The most recent turns that fit the service's bounds: each turn capped at its
 * per-turn length, then the newest turns kept while they fit the count and the
 * total. Older context is what a long conversation can afford to lose.
 */
export function boundAskHistory(history: readonly AskTurn[]): AskTurn[] {
  const kept: AskTurn[] = [];
  let total = 0;
  for (let i = history.length - 1; i >= 0 && kept.length < HISTORY_MAX_TURNS; i--) {
    const turn = history[i];
    const content = turn.content.length > HISTORY_MAX_TURN_CHARS ? turn.content.slice(0, HISTORY_MAX_TURN_CHARS) : turn.content;
    if (total + content.length > HISTORY_MAX_TOTAL_CHARS) break;
    total += content.length;
    kept.unshift({ role: turn.role, content });
  }
  return kept;
}
