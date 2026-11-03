// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Lock } from 'lucide-react';
import { Callout } from './Callout';
import { AI_PROVIDER_MODELS, AI_PROVIDER_NAMES } from '@pipeline-builder/api-core/ai-catalog';
import { AI_DISABLED_MESSAGE } from '@/lib/ai-errors';

/** Which provider/model actually answered an AI request (after org-key selection and any failover). */
export interface AIServedByInfo {
  provider: string;
  model: string;
  /** Set when a platform failover answered: the provider first chosen. */
  fallbackFrom?: string;
}

/** Token usage of one AI request, as the generation routes and the Ask stream return it. */
export interface AIUsageInfo {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  totalTokens?: number;
}

const providerName = (id: string) => AI_PROVIDER_NAMES[id] ?? id;
const modelName = (provider: string, model: string) =>
  AI_PROVIDER_MODELS[provider]?.find((m) => m.id === model)?.name ?? model;

/**
 * The one-line "answered by" footer under an AI result: the model and provider
 * that ACTUALLY served it (which can differ from the one picked — the org's own
 * key, or a platform failover), the failover when there was one, and what it cost
 * in tokens. Renders nothing when the response carried no `servedBy` (the Ask
 * agent drafting path, an older service).
 */
export function AIServedBy({ servedBy, usage, className = '' }: { servedBy?: AIServedByInfo | null; usage?: AIUsageInfo | null; className?: string }) {
  if (!servedBy) return null;
  const total = usage ? (usage.totalTokens ?? usage.inputTokens + usage.outputTokens) : 0;
  return (
    <p className={`text-2xs text-fg-muted ${className}`} data-testid="ai-served-by">
      Answered by {modelName(servedBy.provider, servedBy.model)} ({providerName(servedBy.provider)})
      {servedBy.fallbackFrom && <> · {providerName(servedBy.fallbackFrom)} was unavailable, so it failed over</>}
      {usage && total > 0 && (
        <> · {total.toLocaleString()} tokens{usage.cachedInputTokens ? ` (${usage.cachedInputTokens.toLocaleString()} cached)` : ''}</>
      )}
    </p>
  );
}

/**
 * Shown IN PLACE of an AI control while the organization's AI switch is off, so
 * the answer arrives before the click instead of as an `AI_DISABLED` refusal.
 */
export function AIDisabledNotice({ className = '' }: { className?: string }) {
  return (
    <Callout variant="warning" icon={Lock} title="AI is turned off" className={className}>
      <span data-testid="ai-disabled-notice">{AI_DISABLED_MESSAGE}</span>
    </Callout>
  );
}
