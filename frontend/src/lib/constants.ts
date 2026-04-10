// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

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
export const PLUGIN_BUILD_TIMEOUT_MS = parseInt(process.env.NEXT_PUBLIC_PLUGIN_BUILD_TIMEOUT_MS || '300000', 10); // 5 min

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

/** Time range options for log filtering. */
export const LOG_TIME_RANGES = [
  { label: 'Last 15m', ms: 15 * 60 * 1000 },
  { label: 'Last 1h', ms: 60 * 60 * 1000 },
  { label: 'Last 6h', ms: 6 * 60 * 60 * 1000 },
  { label: 'Last 24h', ms: 24 * 60 * 60 * 1000 },
  { label: 'Last 7d', ms: 7 * 24 * 60 * 60 * 1000 },
] as const;

/** Extract a human-readable message from an unknown caught error. */
export function formatError(err: unknown, fallback = 'An error occurred'): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return fallback;
}

/** Badge color mapping for log severity levels. */
export const LOG_LEVEL_COLORS: Record<string, 'green' | 'yellow' | 'red' | 'gray' | 'blue'> = {
  info: 'blue',
  warn: 'yellow',
  error: 'red',
  debug: 'gray',
};

/** Default toast notification display duration in ms. */
export const DEFAULT_TOAST_DURATION_MS = 4000;

/** Delay before resetting copy button state in ms. */
export const COPY_FEEDBACK_RESET_MS = 2000;

/** localStorage key for dark mode theme preference. */
export const THEME_STORAGE_KEY = 'theme';

/** Pretty-print an object as indented JSON. */
export function formatJSON(obj: unknown): string {
  return JSON.stringify(obj, null, 2);
}

/** Parse a JSON string, returning `fallback` on failure. */
export function safeJSONParse<T>(str: string, fallback: T): T {
  try {
    return JSON.parse(str) as T;
  } catch {
    return fallback;
  }
}
