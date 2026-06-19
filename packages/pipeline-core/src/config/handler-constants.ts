// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Leaf constants for the PluginLookup Lambda handler.
 *
 * Deliberately dependency-free (only `process.env` reads, no imports) so the
 * handler's esbuild bundle does NOT transitively reach `app-config.ts` →
 * `infrastructure-config.ts` → `aws-cdk-lib`. Bundling all of aws-cdk-lib into
 * the Lambda OOM-kills esbuild (hundreds of MB, SIGKILL during cold-start
 * synth). The handler imports THIS module, not `CoreConstants`.
 *
 * `CoreConstants` (app-config.ts) re-exports these so synth-side consumers
 * (api-server, server-config) keep using `CoreConstants.HANDLER_*` unchanged —
 * single source of truth lives here.
 */

/** Default platform URL fallback when PLATFORM_BASE_URL is not set. */
export const DEFAULT_PLATFORM_URL = 'https://localhost:8443';

/** Custom-resource handler timeout (must be < the Lambda's 30s to allow response handling). */
export const HANDLER_TIMEOUT_MS = parseInt(process.env.HANDLER_TIMEOUT_MS || '25000', 10); // 25s

/** Platform base URL the handler calls; overridable per-request via ResourceProperties.baseURL. */
export const HANDLER_DEFAULT_BASE_URL = process.env.PLATFORM_BASE_URL || DEFAULT_PLATFORM_URL;

/** Max retries on transient plugin-lookup failures. */
export const HANDLER_MAX_RETRIES = parseInt(process.env.HANDLER_MAX_RETRIES || '2', 10);

/** Base backoff between handler retries (exponential). */
export const HANDLER_RETRY_DELAY_MS = parseInt(process.env.HANDLER_RETRY_DELAY_MS || '1000', 10); // 1s
