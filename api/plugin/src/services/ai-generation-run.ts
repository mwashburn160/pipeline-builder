// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { aiUsageAuditDetails, resolveOrgModelSelection, runWithFailover } from '@pipeline-builder/ai-core';
import type { AITokenUsage, ResolvedModelSelection } from '@pipeline-builder/ai-core';
import { actorId, errorMessage, recordAudit } from '@pipeline-builder/api-core';
import { incCounter, observe, type AiCallSlot } from '@pipeline-builder/api-server';

import { PLUGIN_PROMPT_VERSION } from './ai-plugin-generation-service.js';

/** Which generation route a run belongs to — the `route` label on metrics and audit rows. */
export type GenerationRoute = 'generate' | 'generate-stream';

/** What the caller asked for (the validated request body's model fields). */
export interface GenerationModelRequest {
  provider?: string;
  model?: string;
  /** The caller's own bring-your-own key — beats the org's and the platform's. */
  apiKey?: string;
  /** Platform providers to try, in order, when the chosen one fails retryably. */
  fallbackProviders?: string[];
}

export interface GenerationRunInit {
  route: GenerationRoute;
  orgId: string;
  userId: string;
  /** The caller's tier — the token metric's `tier` label (never an org id). */
  tier?: string;
  /** Length of the user's prompt — recorded, never the text. */
  promptLength: number;
  log: (level: 'WARN', message: string, meta?: Record<string, unknown>) => void;
}

/**
 * One AI plugin generation, start to settle: resolves the model for the org
 * (caller key > org key > platform key, honouring the org's AI switch), runs the
 * call under platform failover, marks the `aiCalls` slot consumed the moment the
 * provider responds, and on settle emits the metrics and the
 * `plugin.ai.generate` audit row. Mirrors pipeline's `GenerationRun`.
 *
 * The metrics and the audit row name the provider and model that ANSWERED (after
 * org-key selection and any failover) — never the requested one, which hid which
 * provider was browning out — and whose key paid. The audit row carries SAFE
 * METADATA ONLY: never the prompt, the output or a key.
 */
export class GenerationRun {
  /** The selection that served (or was serving) the call; undefined before resolution. */
  served?: ResolvedModelSelection;
  /** True once the provider responded — the slot is consumed from then on. */
  contacted = false;
  private slot?: AiCallSlot;
  private readonly startedAt = Date.now();

  constructor(private readonly init: GenerationRunInit) {}

  /**
   * Resolve the org's model for this request — the FIRST step, before any
   * reservation: whose key serves the call decides whether (and how much) it is
   * charged (api-server `withAiCallReservation`). Pass as its `resolve`.
   */
  async resolve(request: GenerationModelRequest): Promise<ResolvedModelSelection> {
    const selection = await resolveOrgModelSelection({
      orgId: this.init.orgId,
      provider: request.provider,
      model: request.model,
      apiKey: request.apiKey,
      fallbacks: request.fallbackProviders,
    });
    this.served = selection;
    return selection;
  }

  /** Attach the reserved (or waived) `aiCalls` slot (the first thing a guarded body does). */
  bind(slot: AiCallSlot): this {
    this.slot = slot;
    return this;
  }

  /** Pass as `onProviderResponse`: the call is paid for from here on. */
  readonly markResponded = (): void => {
    this.contacted = true;
    this.slot?.markConsumed();
  };

  /**
   * Run `attempt` on the model {@link resolve} picked, failing over to the next
   * platform provider when a PLATFORM-key attempt fails retryably before the
   * provider responded (a BYO or org-key call is never re-run on someone else's key).
   */
  async run<T>(request: GenerationModelRequest, attempt: (selection: ResolvedModelSelection) => Promise<T>): Promise<T> {
    const selection = this.served ?? await this.resolve(request);
    const { value } = await runWithFailover(selection, async (sel) => {
      this.served = sel;
      return attempt(sel);
    }, {
      contacted: () => this.contacted,
      ...(request.fallbackProviders?.length ? { chain: [...request.fallbackProviders] } : {}),
      onFailover: (from, to, error) => {
        this.init.log('WARN', 'AI plugin generation failed over', { from, to, error: errorMessage(error) });
        incCounter('ai_failovers_total', { route: this.init.route, from, to });
      },
    });
    return value;
  }

  /** Settle a generation that produced a config. */
  succeed(usage: AITokenUsage, extra: Record<string, unknown> = {}): void {
    this.settle('success', usage, extra);
  }

  /**
   * Settle a generation that did not: a failure, or a client that left before the
   * final output (`aborted`). The slot outcome is read from `contacted`.
   */
  fail(extra: { aborted?: boolean; error?: unknown; usage?: AITokenUsage } = {}): void {
    const { error, usage, ...rest } = extra;
    // An AIEmptyOutputError says the provider answered (with nothing usable): the slot was kept.
    const errorSaysContacted = (error as { providerContacted?: unknown } | null | undefined)?.providerContacted === true;
    this.settle('failure', usage, {
      ...rest,
      ...(error !== undefined ? { errorCode: errorCodeOf(error) } : {}),
    }, errorSaysContacted);
  }

  private settle(outcome: 'success' | 'failure', usage: AITokenUsage | undefined, extra: Record<string, unknown>, errorSaysContacted = false): void {
    const kept = outcome === 'success' || this.contacted || errorSaysContacted;
    const served = this.served;
    const provider = served?.provider ?? 'unresolved';
    const model = served?.modelId ?? 'unresolved';
    const metricOutcome = extra.aborted ? 'aborted' : outcome === 'success' ? 'success' : 'error';
    incCounter('ai_requests_total', { route: this.init.route, provider, model, outcome: metricOutcome });
    if (outcome === 'success') {
      observe('ai_generation_duration_seconds', { route: this.init.route, provider, model }, (Date.now() - this.startedAt) / 1000);
    }
    // The usage ledger's token columns (and, for a waived slot, its only row).
    this.slot?.reportUsage(usage);
    if (served && usage) {
      const base = { route: this.init.route, provider, key_source: served.keySource, tier: this.init.tier ?? 'unknown' };
      incCounter('ai_tokens_total', { ...base, kind: 'input' }, usage.inputTokens);
      incCounter('ai_tokens_total', { ...base, kind: 'output' }, usage.outputTokens);
      if (usage.cachedInputTokens > 0) incCounter('ai_tokens_total', { ...base, kind: 'cached_input' }, usage.cachedInputTokens);
    }

    recordAudit({
      action: 'plugin.ai.generate',
      actorId: actorId({ userId: this.init.userId }),
      orgId: this.init.orgId,
      targetType: 'plugin',
      outcome,
      details: {
        route: this.init.route,
        promptLength: this.init.promptLength,
        ...extra,
        quota: this.slot?.waived
          // No unit reserved: a BYOK key, an impersonation session or a weight-0 model.
          ? { type: 'aiCalls', slot: 'waived', waived: this.slot.waived, amount: 0 }
          : {
            type: 'aiCalls',
            slot: kept ? 'kept' : 'refunded',
            ...(this.slot ? { amount: this.slot.amount, used: this.slot.reservation.quota.used, limit: this.slot.reservation.quota.limit } : {}),
          },
        // Absent when the run failed before a provider was chosen (AI off, nothing configured).
        ...(served ? {
          ai: aiUsageAuditDetails(served, { usage, quotaSlot: kept ? 'kept' : 'refunded', promptVersion: PLUGIN_PROMPT_VERSION }),
        } : {}),
      },
    });
  }
}

/** A stable code for the audit row — an AppError's `code`, a provider's HTTP status, else the error's name. */
function errorCodeOf(error: unknown): string {
  const e = error as { code?: unknown; statusCode?: unknown; name?: unknown } | null;
  if (typeof e?.code === 'string') return e.code;
  if (typeof e?.statusCode === 'number') return `provider_${e.statusCode}`;
  return typeof e?.name === 'string' ? e.name : 'Error';
}
