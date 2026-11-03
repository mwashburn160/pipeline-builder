// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * What every agent tool is handed. Declared apart from `agent-tools.ts` so each
 * tool module can depend on the deps without depending on the composer.
 */

import type { GroundingIndex, ResolvedModelSelection } from '@pipeline-builder/ai-core';
import { z } from 'zod';

import type { EmailSwitch, ServiceClient } from './internal-http.js';

export interface AgentToolDeps {
  index: GroundingIndex;
  /** Pipeline service client, pre-bound to the caller's forwarded bearer token. */
  pipeline: ServiceClient;
  /** Plugin service client, pre-bound to the caller's forwarded bearer token. */
  plugin: ServiceClient;
  /** Platform service client (org settings, alert destinations, `/config`). */
  platform: ServiceClient;
  /** Compliance service client (policy dry-runs, rules, exemptions). */
  compliance: ServiceClient;
  /** Reporting service client (execution history, DORA). */
  reporting: ServiceClient;
  /** Quota service client (the org's own headroom). */
  quota: ServiceClient;
  /**
   * The instance-wide outbound-email switch, from platform's AUTHORITATIVE
   * `GET /internal/notify-email/status` (`readInstanceEmailStatus`). Injected
   * rather than imported because it is the one call that does NOT ride the
   * caller's token — it uses ask's service identity — so the tool layer stays
   * honest about it and the suites can drive all three states. Resolves
   * `unknown` (never throws) when platform could not be asked.
   */
  emailStatus: () => Promise<EmailSwitch>;
  /**
   * The turn's resolved model selection — the model the tools that generate
   * IN-PROCESS use, plus who serves it (provider, model id, whose key) for the
   * per-call settings and the platform failover.
   */
  selection: ResolvedModelSelection;
  /**
   * Out-of-band values for delegated generation: the RESOLVED provider/model, the
   * caller's own bring-your-own key (`apiKey`, from the request) and a private-repo
   * token for the from-repo tools. Never exposed to the model as tool input, never
   * logged — they ride only in the body of the delegated generator call.
   */
  defaults: { provider?: string; model?: string; apiKey?: string; repoToken?: string };
  /**
   * The turn's own abort signal (client disconnect). In-process generations combine
   * it with the AI request timeout (`aiCallSettings`).
   */
  abortSignal?: AbortSignal;
  /**
   * The AUTHENTICATED caller's org id. Injected into tenant-scoping tool inputs
   * (e.g. template instantiation, org settings) so the MODEL can never choose
   * which org a call targets — closing a prompt-injection path where a crafted
   * message could name another tenant's org. The model only ever supplies
   * non-authority fields.
   */
  orgId: string;
  /**
   * Reserve one `aiCalls` slot for a generation this service runs IN-PROCESS on
   * the model's behalf. The turn's own slot pays for the agent's reasoning; an
   * extra model invocation must pay its own, exactly as the delegated
   * pipeline/plugin generators do. Resolves null when the org is out of quota
   * (the tool then declines instead of generating). `tool` labels the metric and
   * the usage ledger's `agent-tool:<tool>` feature.
   */
  chargeAiCall: (tool: string) => Promise<AiToolCharge | null>;
  /** Output-token cap for in-process generations. */
  maxOutputTokens: number;
  /**
   * Design rule 10: a proposal naming a field outside the tool's allowlist is
   * the injection signal, so it gets a counter and a log line rather than a
   * silent drop. Injected (not imported) so the tool layer stays free of the
   * metrics/logging runtime and the tests can assert on it.
   */
  onRefusedFields: (tool: string, fields: string[]) => void;
}

/**
 * The slot an in-process tool generation holds. The tool MUST `settle()` it on
 * every path (success, failure, abort) — that is where an uncontacted slot is
 * refunded and the call's tokens are reported (usage ledger, `ai_tokens_total`,
 * the turn's audit row).
 */
export interface AiToolCharge {
  /** The provider started responding: the call is paid for from here on. */
  markConsumed(): void;
  /** Settle once: refund unless consumed, and record the tokens the provider reported. */
  settle(usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number } | undefined): void;
}

/**
 * A resource id the MODEL supplies (it lands in a URL path). Opaque-id charset
 * only: no `/`, no `.` — so neither a slash nor a `..` segment can walk the
 * forwarded request to a different route than the one the tool names.
 */
export const ResourceId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, 'must be an opaque id (letters, digits, - or _)');
