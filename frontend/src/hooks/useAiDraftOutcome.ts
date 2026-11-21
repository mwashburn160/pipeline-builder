// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useMemo, useRef } from 'react';
import api from '@/lib/api';
import type { AiDraftFeature, AiDraftOutcome } from '@/types/ai-usage';

/** JSON with sorted keys, so two equal drafts compare equal whatever their key order. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
    : v));
}

/**
 * Fire-and-forget: an outcome that fails to record is never the user's problem.
 * A draft that came without a draft id is never reported — the server redeems
 * that id (once) and would refuse the outcome without it.
 */
function send(feature: AiDraftFeature, outcome: AiDraftOutcome, draftId: string | undefined): void {
  if (!draftId) return;
  try {
    void Promise.resolve(api.recordAiDraftOutcome(feature, outcome, draftId)).catch(() => undefined);
  } catch {
    // A missing client in a test double is not worth surfacing either.
  }
}

/**
 * Tracks ONE AI-generated draft at a time and reports what became of it, for
 * the AI usage report's acceptance rate (`POST /api/ask-agent/draft-outcome`):
 *
 *  - `offered(feature, draft, draftId)` — a new draft arrived, with the
 *    single-use id its generator issued. A previous draft still pending was
 *    replaced unused, so it is reported `discarded`.
 *  - `accepted(final?)` — the draft was created / deployed. `final` is what was
 *    actually submitted: different from the draft as offered ⇒ `edited_accepted`.
 *  - unmount with a draft still pending (the dialog closed, the tab changed) ⇒
 *    `discarded`. The report waits a microtask and is dropped if the component
 *    mounted again meanwhile: React StrictMode's simulated unmount/re-mount in
 *    development must not spend the single-use id of a draft that is still on
 *    screen. Re-offering the draft already pending (same id, as a re-run mount
 *    effect does) keeps it rather than reporting it replaced.
 *
 * Each draft reports once, under its own draft id (the server refuses a reused,
 * forged or expired one). Only the feature, the outcome and that id leave the
 * browser — the draft itself is compared locally and never sent.
 */
export function useAiDraftOutcome() {
  const pending = useRef<{ feature: AiDraftFeature; snapshot: string; draftId?: string } | null>(null);

  const discarded = useCallback(() => {
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    send(p.feature, 'discarded', p.draftId);
  }, []);

  const offered = useCallback((feature: AiDraftFeature, draft: unknown, draftId?: string) => {
    const prev = pending.current;
    if (prev && !(draftId && prev.draftId === draftId)) send(prev.feature, 'discarded', prev.draftId);
    pending.current = { feature, snapshot: stableJson(draft), ...(draftId ? { draftId } : {}) };
  }, []);

  const accepted = useCallback((final?: unknown) => {
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    send(p.feature, final !== undefined && stableJson(final) !== p.snapshot ? 'edited_accepted' : 'accepted', p.draftId);
  }, []);

  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Only a REAL unmount reports: StrictMode re-mounts synchronously, before
      // this microtask runs.
      queueMicrotask(() => { if (!mounted.current) discarded(); });
    };
  }, [discarded]);

  return useMemo(() => ({ offered, accepted, discarded }), [offered, accepted, discarded]);
}
