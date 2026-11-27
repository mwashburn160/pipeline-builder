// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * ai-core's configuration, in one typed object.
 *
 * The limits are read ONCE when this module is first evaluated (the same timing
 * as the module-level constants they replace; `AI_REQUEST_TIMEOUT_MS`,
 * `AI_MAX_OUTPUT_TOKENS` and `AI_MAX_RETRIES` remain exported as aliases).
 * `failoverProviders` is a getter, read on every call, because the chain is
 * consulted per call and tests change it between cases.
 */

import { envInt, envStr } from '@pipeline-builder/api-core';

export interface AiCoreConfig {
  /** Wall-clock bound on one AI call, retries included, ms (`AI_REQUEST_TIMEOUT_MS`). */
  readonly requestTimeoutMs: number;
  /** Platform-wide output-token ceiling per model call (`AI_MAX_OUTPUT_TOKENS`). */
  readonly maxOutputTokens: number;
  /** SDK-level retries on the same provider (`AI_MAX_RETRIES`). */
  readonly maxRetries: number;
  /** Comma-separated provider failover chain; `''` = every configured provider (`AI_FAILOVER_PROVIDERS`). */
  readonly failoverProviders: string;
}

export const aiCoreConfig: AiCoreConfig = {
  requestTimeoutMs: envInt('AI_REQUEST_TIMEOUT_MS', 120_000, { min: 1_000 }),
  maxOutputTokens: envInt('AI_MAX_OUTPUT_TOKENS', 8192, { min: 64 }),
  maxRetries: envInt('AI_MAX_RETRIES', 2, { min: 0, max: 5 }),
  get failoverProviders() { return envStr('AI_FAILOVER_PROVIDERS', ''); },
};
