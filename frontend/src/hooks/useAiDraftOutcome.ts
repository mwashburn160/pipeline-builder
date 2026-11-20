// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef } from 'react';
import api from '@/lib/api';
import type { AiDraftFeature, AiDraftOutcome } from '@/types/ai-usage';

/** JSON with sorted keys, so two equal drafts compare equal whatever their key order. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
    : v));
}

/** Fire-and-forget: an outcome that fails to record is never the user's problem. */
function send(feature: AiDraftFeature, outcome: AiDraftOutcome): void {
  try {
    void Promise.resolve(api.recordAiDraftOutcome(feature, outcome)).catch(() => undefined);
  } catch {
    // A missing client in a test double is not worth surfacing either.
  }
}

/**
 * Tracks ONE AI-generated draft at a time and reports what became of it, for
 * the AI usage report's acceptance rate (`POST /api/ask-agent/draft-outcome`):
 *
 *  - `offered(feature, draft)` — a new draft arrived. A previous draft still
 *    pending was replaced unused, so it is reported `discarded`.
 *  - `accepted(final?)` — the draft was created / deployed. `final` is what was
 *    actually submitted: different from the draft as offered ⇒ `edited_accepted`.
 *  - unmount with a draft still pending (the dialog closed, the tab changed) ⇒
 *    `discarded`.
 *
 * Each draft reports once. Only the feature and the outcome leave the browser —
 * the draft itself is compared locally and never sent.
 */
export function useAiDraftOutcome() {
  const pending = useRef<{ feature: AiDraftFeature; snapshot: string } | null>(null);

  const discarded = useCallback(() => {
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    send(p.feature, 'discarded');
  }, []);

  const offered = useCallback((feature: AiDraftFeature, draft: unknown) => {
    if (pending.current) send(pending.current.feature, 'discarded');
    pending.current = { feature, snapshot: stableJson(draft) };
  }, []);

  const accepted = useCallback((final?: unknown) => {
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    send(p.feature, final !== undefined && stableJson(final) !== p.snapshot ? 'edited_accepted' : 'accepted');
  }, []);

  useEffect(() => discarded, [discarded]);

  return { offered, accepted, discarded };
}
