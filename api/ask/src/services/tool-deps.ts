// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * What every agent tool is handed. Declared apart from `agent-tools.ts` so each
 * tool module can depend on the deps without depending on the composer.
 */

import type { GroundingIndex, LanguageModel } from '@pipeline-builder/ai-core';
import { z } from 'zod';

import type { ServiceClient } from './internal-http.js';

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
  /** The resolved model — used by the tools that generate IN-PROCESS. */
  model: LanguageModel;
  /**
   * Out-of-band values for delegated generation (from the request): the
   * provider/model, and a private-repo token for the from-repo tools.
   * Never exposed to the model as tool input.
   */
  defaults: { provider?: string; model?: string; repoToken?: string };
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
   * pipeline/plugin generators do. Resolves false when the org is out of quota
   * (the tool then declines instead of generating). `tool` labels the metric.
   */
  chargeAiCall: (tool: string) => Promise<boolean>;
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
 * A resource id the MODEL supplies (it lands in a URL path). Opaque-id charset
 * only: no `/`, no `.` — so neither a slash nor a `..` segment can walk the
 * forwarded request to a different route than the one the tool names.
 */
export const ResourceId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, 'must be an opaque id (letters, digits, - or _)');
