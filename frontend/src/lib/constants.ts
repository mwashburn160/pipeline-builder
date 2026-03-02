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

/** Timeout for plugin Docker build requests in ms. */
export const PLUGIN_BUILD_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/** Default fetch request timeout in ms. */
export const API_REQUEST_TIMEOUT_MS = 30_000; // 30 seconds
