// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef } from 'react';
import api from '@/lib/api';

/**
 * How long the reader must stop typing before a miss counts.
 *
 * Every prefix of a real query matches nothing ("a", "au", "aut"), so reporting
 * on each keystroke would count one genuine miss as a dozen and make the signal
 * mostly noise about typing speed.
 */
const SETTLE_MS = 1200;

/**
 * Report a help search that found nothing.
 *
 * This is the only evidence that the corpus has drifted away from what people
 * actually need: a reader who searches, finds nothing and leaves is otherwise
 * indistinguishable from one who never came. The answer ratings say which docs
 * answer badly; this says what is missing from them entirely.
 *
 * A COUNT, never the query. The search text is the reader's own words, and this
 * service records safe metadata only — the endpoint has no field to put it in.
 * That makes the metric a trend ("misses are climbing") rather than a worklist,
 * which is the honest trade for not logging what people type.
 *
 * Fire-and-forget throughout: this must never delay a render or surface an
 * error. Telemetry failing is not the reader's problem.
 *
 * @param query - The current search text.
 * @param resultCount - Matches for it right now.
 * @param ready - False while the corpus is still loading, when EVERY query
 *   looks like a miss. Reporting then would count a slow chunk as a content gap.
 */
export function useHelpSearchMiss(query: string, resultCount: number, ready: boolean): void {
  // Queries already counted this mount, so a reader editing around a dead end
  // ("sso" → "sso setup" → "sso") reports it once, not on every return trip.
  const reported = useRef<Set<string>>(new Set());

  useEffect(() => {
    const q = query.trim().toLowerCase();
    // A one-character query is a keystroke, not a question.
    if (!ready || resultCount > 0 || q.length < 2 || reported.current.has(q)) return;
    const timer = setTimeout(() => {
      reported.current.add(q);
      void api.sendAskFeedback({ kind: 'help-search-miss' }).catch(() => { /* telemetry only */ });
    }, SETTLE_MS);
    return () => clearTimeout(timer);
  }, [query, resultCount, ready]);
}
