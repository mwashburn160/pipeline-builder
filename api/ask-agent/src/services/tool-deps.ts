// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * What every agent tool is handed. Declared apart from `agent-tools.ts` so each
 * tool module can depend on the deps without depending on the composer.
 */

import type { GroundingIndex, ResolvedModelSelection } from '@pipeline-builder/ai-core';
import type { Permission } from '@pipeline-builder/api-core';
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
   * caller's token — it uses ask-agent's service identity — so the tool layer stays
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
   * The AUTHENTICATED caller's org id, for the tool inputs that name the caller's
   * org (org settings, compliance attributes). Tenancy itself is never decided
   * here: every forwarded call rides the caller's own token, and the owning
   * service scopes it to the token's org whatever a body says. Injecting the id
   * keeps the model from even proposing a different org on a draft.
   */
  orgId: string;
  /**
   * The authenticated org's display NAME (the verified token's
   * `organizationName`), when the token carries one. Used only to NAME things —
   * the `organization` segment of a drafted pipeline's stack name — never to
   * scope a call.
   */
  orgName?: string;
  /**
   * Reserve one `aiCalls` slot for a generation this service runs IN-PROCESS on
   * the model's behalf. The turn's own slot pays for the agent's reasoning; an
   * extra model invocation must pay its own, exactly as the delegated
   * pipeline/plugin generators do. Resolves null when the org is out of quota
   * (the tool then declines instead of generating). `tool` labels the metric and
   * the usage ledger's `agent-tool:<tool>` feature; `promptVersion` is the
   * generation's own prompt version, recorded on the turn's audit row beside it.
   */
  chargeAiCall: (tool: string, promptVersion?: string) => Promise<AiToolCharge | null>;
  /**
   * The turn's budget of charged generations (`ASK_MAX_TURN_GENERATIONS`). Every
   * generating tool claims one BEFORE it generates and declines when the claim is
   * refused, so one turn can never draw more than the cap in extra slots.
   */
  generations: TurnGenerations;
  /** Output-token cap for in-process generations. */
  maxOutputTokens: number;
  /**
   * Whether the CALLER holds a permission. Advisory, never a gate: the tools
   * still draft what the caller cannot apply, because a draft they hand to an
   * admin is the point of drafting (the UI keeps the Apply button visible and
   * inert for the same reason). What this buys is that a propose tool's RESULT
   * can say so, which is what lets the agent finish the thought — "you'll need
   * `pipelines:write`; send this to an admin" — instead of handing back a draft
   * that dead-ends at a greyed-out button.
   *
   * Enforcement is unaffected and lives where it always did: every tool rides
   * the caller's bearer token and each owning service re-checks.
   */
  holdsPermission: (permission: Permission) => boolean;
  /**
   * A proposal naming a field outside the tool's allowlist is the injection
   * signal, so it gets a counter and a log line rather than a
   * silent drop. Injected (not imported) so the tool layer stays free of the
   * metrics/logging runtime and the tests can assert on it.
   */
  onRefusedFields: (tool: string, fields: string[]) => void;
}

/** See {@link AgentToolDeps.generations}. */
export interface TurnGenerations {
  /** Claim one generation for `tool`; false once the turn's budget is spent. */
  claim(tool: string): boolean;
  /**
   * A DELEGATED generation answered 2xx, so its peer kept an `aiCalls` slot on
   * the caller's org. Counted for the turn's `done` event (`slotsCharged`).
   */
  delegated(tool: string): void;
}

/**
 * The slot an in-process tool generation holds. The tool MUST `settle()` it on
 * every path (success, failure, abort) — that is where a slot whose request was
 * never sent is refunded and the call's tokens are reported (usage ledger, `ai_tokens_total`,
 * the turn's audit row).
 */
export interface AiToolCharge {
  /** The request is being SENT to the provider: the call is paid for from here on. */
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
