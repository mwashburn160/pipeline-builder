// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The `aiCalls` quota as an AI surface needs it BEFORE a generation is started:
 * whose key will pay for the call, whether the call counts at all, and whether
 * the org has any left.
 *
 * Only a call served on the PLATFORM's key consumes `aiCalls`. A call on the
 * org's saved key or on a key pasted for one request is recorded (tokens, for
 * the usage breakdown) but charged at 0 — so a surface must not say "0 left"
 * and lock the button on an org that is about to use its own key.
 */

import type { QuotaSummary, QuotaTier } from '@/types';

/** Whose key serves an AI call — mirrors ai-core's `ModelSelection.keySource`. */
export type AIKeySource = 'platform' | 'org' | 'request';

/**
 * The key source a call WILL use, from the picker state the AI surfaces share
 * (`useAIProviders`). Precedence matches the backend: the caller's own key >
 * the org's key > the platform's.
 *
 * The Ask-agent entry takes no key override (its delegated generation cannot
 * forward one), so a key left typed in the hidden override field is ignored
 * there — exactly as the surfaces ignore it when they send the request.
 */
export function aiKeySource(ai: { customApiKey: string; currentSource?: string }): AIKeySource {
  if (ai.currentSource === 'agent') return 'platform';
  if (ai.customApiKey.trim()) return 'request';
  if (ai.currentSource === 'org') return 'org';
  return 'platform';
}

/**
 * Tiers whose AI calls are a TRIAL allowance: enough to try generation, not to
 * run on. The trial calls are real (the developer tier holds `ai_generation`),
 * so the surfaces are usable — the label and a prominent upgrade CTA once they
 * run out are what differ.
 */
const AI_TRIAL_TIERS: ReadonlySet<QuotaTier> = new Set<QuotaTier>(['developer']);

/** True when `tier`'s AI calls are a trial allowance. */
export function isAITrialTier(tier: QuotaTier | undefined | null): boolean {
  return !!tier && AI_TRIAL_TIERS.has(tier);
}

/**
 * True when a call on `keySource` would be refused for the org's `aiCalls`
 * limit: the platform's key, a capped quota, nothing left. An unknown quota
 * (not loaded, service down) never blocks — the server still decides.
 */
export function aiQuotaBlocked(summary: QuotaSummary | null | undefined, keySource: AIKeySource): boolean {
  return keySource === 'platform' && !!summary && !summary.unlimited && summary.remaining <= 0;
}
