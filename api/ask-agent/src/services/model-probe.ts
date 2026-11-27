// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A LIVE check that the self-hosted model (`ask-model`) is answering — asked by
 * `GET /ask-agent/availability?probe=true` before a form defaults to the Ask agent.
 *
 * `askModelAvailability` only PREDICTS from the configured schedule, so a model
 * that was scaled down by hand, crashed, or never pulled its weights still reads
 * as available and the user learns otherwise only from a failed generation.
 *
 * The probe is `GET {OPENAI_COMPATIBLE_BASE_URL}/models`: it lists what the
 * server has, it does not load weights or run inference, and on a zero-replica
 * Deployment it fails fast at TCP rather than waking anything. Reachable means
 * the server answered AND serves at least one model `OPENAI_COMPATIBLE_MODELS`
 * advertises — a server that has never pulled the advertised model closes the
 * connection mid-stream on the first real call, which is the same failure.
 *
 * Results are cached briefly (success and failure alike) and concurrent callers
 * share one in-flight request, so opening forms cannot hammer the model server.
 */

import { getOpenAICompatibleProvider } from '@pipeline-builder/api-core';
import { config } from '../config.js';

/** Upper bound on one probe; the form waits on it before choosing a default. */
const PROBE_TIMEOUT_MS = config.modelProbe.timeoutMs;
/** How long one answer is reused. */
const PROBE_CACHE_MS = config.modelProbe.cacheMs;

export interface ModelProbeResult {
  /** True only when the server answered and serves an advertised model. */
  readonly reachable: boolean;
}

let cached: { at: number; result: ModelProbeResult } | undefined;
let inFlight: Promise<ModelProbeResult> | undefined;

/** Ids the server lists, from an OpenAI-style `{ data: [{ id }] }` body. */
function servedIds(body: unknown): Set<string> {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) return new Set();
  return new Set(data.map((m) => (m as { id?: unknown })?.id).filter((id): id is string => typeof id === 'string'));
}

async function probeOnce(fetchImpl: typeof fetch): Promise<ModelProbeResult> {
  const provider = getOpenAICompatibleProvider();
  const baseURL = config.modelProbe.baseUrl;
  if (!provider || !baseURL) return { reachable: false };

  const headers: Record<string, string> = { accept: 'application/json' };
  const apiKey = config.modelProbe.apiKey;
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  try {
    const res = await fetchImpl(`${baseURL.replace(/\/+$/, '')}/models`, {
      headers,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return { reachable: false };
    const served = servedIds(await res.json());
    return { reachable: provider.models.some((m) => served.has(m.id)) };
  } catch {
    // Refused, reset, DNS failure or timeout: all mean "not answering".
    return { reachable: false };
  }
}

/**
 * Whether the self-hosted model answers right now.
 *
 * @param fetchImpl - Injectable for tests.
 * @param now - Injectable clock for the cache.
 */
export async function probeSelfHostedModel(fetchImpl: typeof fetch = fetch, now: () => number = Date.now): Promise<ModelProbeResult> {
  if (cached && now() - cached.at < PROBE_CACHE_MS) return cached.result;
  if (!inFlight) {
    inFlight = probeOnce(fetchImpl)
      .then((result) => {
        cached = { at: now(), result };
        return result;
      })
      .finally(() => { inFlight = undefined; });
  }
  return inFlight;
}

/** Test hook: forget the cached answer. */
export function resetModelProbeCache(): void {
  cached = undefined;
  inFlight = undefined;
}
