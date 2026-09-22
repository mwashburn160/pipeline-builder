// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Leaf constants for the PluginLookup Lambda handler.
 *
 * Dependency-free so the handler's esbuild bundle stays small — it does not drag
 * in the config machinery via `app-config.ts`. The handler imports THIS module;
 * `CoreConstants` re-exports the values for synth-side consumers. The Lambda's
 * environment carries only `PLATFORM_SECRET_NAME`, so these are fixed values,
 * not env knobs.
 */

/** Default platform URL fallback when PLATFORM_BASE_URL is not set. */
export const DEFAULT_PLATFORM_URL = 'https://localhost:8443';

/** Custom-resource handler timeout (must be < the Lambda's 30s to allow response handling). */
export const HANDLER_TIMEOUT_MS = 25_000;

/** Platform base URL the handler calls; overridable per-request via ResourceProperties.baseURL. */
export const HANDLER_DEFAULT_BASE_URL = process.env.PLATFORM_BASE_URL || DEFAULT_PLATFORM_URL;

/** Max retries on transient plugin-lookup failures. */
export const HANDLER_MAX_RETRIES = 2;

/** Base backoff between handler retries (exponential). */
export const HANDLER_RETRY_DELAY_MS = 1000;
