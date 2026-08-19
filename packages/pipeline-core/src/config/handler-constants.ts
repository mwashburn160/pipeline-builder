// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Leaf constants for the PluginLookup Lambda handler.
 *
 * Deliberately dependency-free (only `process.env` reads, no imports) so the
 * handler's esbuild bundle stays small — it does not drag in the whole config
 * machinery via `app-config.ts`. The handler imports THIS module, not
 * `CoreConstants`.
 *
 * This originally guarded a much sharper edge: `app-config.ts` →
 * `infrastructure-config.ts` → `aws-cdk-lib`, which OOM-killed esbuild
 * (hundreds of MB, SIGKILL during cold-start synth). That chain is gone —
 * `infrastructure-config.ts` is now CDK-free and the constructs live behind the
 * `/cdk` entry point — but the dependency-free contract is still worth keeping.
 *
 * `CoreConstants` (app-config.ts) re-exports these so synth-side consumers
 * (api-server, server-config) keep using `CoreConstants.HANDLER_*` unchanged —
 * single source of truth lives here.
 */

/** Parse an integer env var, falling back on unset OR malformed (NaN). A raw
 *  `parseInt` returning NaN silently disables the handler's retry loop / axios
 *  timeout — breaking every plugin lookup — so guard it. Kept inline to preserve
 *  this module's dependency-free contract (no imports → small Lambda bundle). */
function envInt(value: string | undefined, fallback: number): number {
  const n = parseInt(value ?? '', 10);
  return Number.isNaN(n) ? fallback : n;
}

/** Default platform URL fallback when PLATFORM_BASE_URL is not set. */
export const DEFAULT_PLATFORM_URL = 'https://localhost:8443';

/** Custom-resource handler timeout (must be < the Lambda's 30s to allow response handling). */
export const HANDLER_TIMEOUT_MS = envInt(process.env.HANDLER_TIMEOUT_MS, 25000); // 25s

/** Platform base URL the handler calls; overridable per-request via ResourceProperties.baseURL. */
export const HANDLER_DEFAULT_BASE_URL = process.env.PLATFORM_BASE_URL || DEFAULT_PLATFORM_URL;

/** Max retries on transient plugin-lookup failures. */
export const HANDLER_MAX_RETRIES = envInt(process.env.HANDLER_MAX_RETRIES, 2);

/** Base backoff between handler retries (exponential). */
export const HANDLER_RETRY_DELAY_MS = envInt(process.env.HANDLER_RETRY_DELAY_MS, 1000); // 1s
