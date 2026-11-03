// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { OPENAI_COMPATIBLE_PROVIDER_ID } from '../constants/ai-providers.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('ai-call-weight');

/** Largest weight one model may carry — one call can never reserve more than this many units. */
export const MAX_AI_CALL_WEIGHT = 100;

/**
 * Built-in weights, under whatever `AI_MODEL_WEIGHTS` sets. The self-hosted
 * OpenAI-compatible provider (the in-cluster `ask-model`) runs on hardware the
 * operator already pays for, so a call on it spends NO `aiCalls` unit by default;
 * set `{"openai-compatible": 1}` to meter it like any other model.
 */
const BUILT_IN_WEIGHTS: Readonly<Record<string, number>> = { [OPENAI_COMPATIBLE_PROVIDER_ID]: 0 };

/**
 * Parse `AI_MODEL_WEIGHTS` — a JSON object of `key → integer weight` — into
 * lower-cased entries. A malformed value is IGNORED (logged), never fatal: the
 * weights are an optional pricing lever and every call still meters at 1.
 */
export function parseAiModelWeights(raw: string | undefined): Record<string, number> {
  const out: Record<string, number> = { ...BUILT_IN_WEIGHTS };
  if (!raw || raw.trim() === '') return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.warn('AI_MODEL_WEIGHTS is not valid JSON; every model weighs 1');
    return out;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    logger.warn('AI_MODEL_WEIGHTS must be a JSON object; every model weighs 1');
    return out;
  }
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_AI_CALL_WEIGHT) {
      logger.warn('AI_MODEL_WEIGHTS entry ignored (weight must be an integer 0..100)', { key });
      continue;
    }
    out[key.trim().toLowerCase()] = value;
  }
  return out;
}

let cached: { raw: string | undefined; weights: Record<string, number> } | undefined;

function currentWeights(): Record<string, number> {
  const raw = process.env.AI_MODEL_WEIGHTS;
  if (!cached || cached.raw !== raw) cached = { raw, weights: parseAiModelWeights(raw) };
  return cached.weights;
}

/**
 * How many `aiCalls` units one call on `{ provider, modelId }` reserves.
 *
 * MODEL-CLASS WEIGHTING is OFF by default: with `AI_MODEL_WEIGHTS` unset every
 * model weighs 1 — except the self-hosted provider, which weighs 0 (see
 * {@link BUILT_IN_WEIGHTS}). Matching, first hit wins:
 *  1. a key equal to the PROVIDER id (`"openai-compatible": 0`, `"bedrock": 2`);
 *  2. the LONGEST key contained in the model id (`"opus": 3` matches
 *     `claude-opus-4-1`; `"sonnet": 1`, `"haiku": 1`).
 * No match → 1. A weight of 0 means the call reserves nothing (it is still
 * recorded in the usage ledger with its tokens).
 */
export function aiCallWeight(selection: { provider: string; modelId: string }): number {
  const weights = currentWeights();
  const provider = selection.provider.toLowerCase();
  if (provider in weights) return weights[provider]!;
  const model = selection.modelId.toLowerCase();
  let best: { key: string; weight: number } | undefined;
  for (const [key, weight] of Object.entries(weights)) {
    if (key.length > 0 && model.includes(key) && (!best || key.length > best.key.length)) best = { key, weight };
  }
  return best ? best.weight : 1;
}
