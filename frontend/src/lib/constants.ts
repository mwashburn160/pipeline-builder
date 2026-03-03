/**
 * @module lib/constants
 * @description Shared frontend constants. Centralizes magic numbers
 * so they can be tuned in one place.
 */

/** Refresh the auth token this many ms before it expires. */
export const REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

/** Maximum consecutive refresh failures before forcing logout. */
export const MAX_REFRESH_ATTEMPTS = 3;

/** Module-level plugin cache time-to-live in ms. */
export const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Quota usage percentage thresholds for status indicators. */
export const QUOTA_CRITICAL_THRESHOLD = 90;
export const QUOTA_WARNING_THRESHOLD = 70;

/** Maximum character length for AI prompts. */
export const AI_MAX_PROMPT_LENGTH = 5000;

/** Timeout for plugin Docker build requests in ms. Configurable via NEXT_PUBLIC_PLUGIN_BUILD_TIMEOUT_MS env var. */
export const PLUGIN_BUILD_TIMEOUT_MS = parseInt(process.env.NEXT_PUBLIC_PLUGIN_BUILD_TIMEOUT_MS || String(5 * 60 * 1000), 10);

/** Default fetch request timeout in ms. */
export const API_REQUEST_TIMEOUT_MS = 30_000; // 30 seconds

/** Maximum stored build events in SSE hook before trimming. */
export const MAX_BUILD_EVENTS = 1000;

/** Maximum SSE reconnection retries for build status. */
export const BUILD_SSE_MAX_RETRIES = 3;

/** Maximum SSE reconnection retries for message notifications. */
export const MESSAGE_SSE_MAX_RETRIES = 5;

/** Base retry delay (ms) for message notification reconnection. */
export const MESSAGE_SSE_BASE_RETRY_DELAY_MS = 2000;

/** Threshold for distinguishing seconds vs milliseconds epoch timestamps. */
export const EPOCH_MS_THRESHOLD = 1e12;
