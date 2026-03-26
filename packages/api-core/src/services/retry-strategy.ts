import * as http from 'http';

/**
 * Default retry configuration (env: `HTTP_CLIENT_MAX_RETRIES`, `HTTP_CLIENT_RETRY_DELAY_MS`).
 */
export const DEFAULT_MAX_RETRIES = parseInt(process.env.HTTP_CLIENT_MAX_RETRIES || '2', 10);
export const DEFAULT_RETRY_DELAY_MS = parseInt(process.env.HTTP_CLIENT_RETRY_DELAY_MS || '200', 10);
export const DEFAULT_MAX_RATE_LIMIT_RETRIES = parseInt(process.env.HTTP_CLIENT_MAX_RATE_LIMIT_RETRIES || '4', 10);

/** Max Retry-After value we'll honor (60 seconds). */
const MAX_RETRY_AFTER_MS = 60_000;

/** HTTP status codes considered transient server errors eligible for retry. */
const TRANSIENT_STATUS_CODES = [502, 503, 504];

/**
 * Configuration for retry behavior.
 */
export interface RetryConfig {
  /** Maximum retry attempts for transient failures (default: 2) */
  maxRetries: number;
  /** Base delay between retries in ms — doubles each attempt (default: 200) */
  retryDelayMs: number;
  /** Maximum retry attempts specifically for 429 rate limiting (default: 4) */
  maxRateLimitRetries: number;
}

/**
 * Result of a retry decision: whether to retry, and how long to wait.
 */
export interface RetryDecision {
  /** Whether the request should be retried */
  shouldRetry: boolean;
  /** Delay in milliseconds before retrying (with jitter applied) */
  delayMs: number;
  /** Human-readable reason for the retry decision */
  reason: string;
}

/**
 * Parse a `Retry-After` header value into milliseconds.
 * Supports numeric seconds (e.g. "5") and HTTP-date format.
 * Returns `undefined` for missing or invalid values.
 */
export function parseRetryAfter(header: string | string[] | undefined): number | undefined {
  if (!header) return undefined;
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return undefined;

  // Try numeric seconds first
  const seconds = Number(value);
  if (!isNaN(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }

  // Try HTTP-date
  const date = Date.parse(value);
  if (!isNaN(date)) {
    const delayMs = date - Date.now();
    if (delayMs > 0) return Math.min(delayMs, MAX_RETRY_AFTER_MS);
  }

  return undefined;
}

/**
 * Apply +/-25% random jitter to a delay to prevent thundering herd.
 */
export function addJitter(delay: number): number {
  const jitter = delay * 0.25 * (2 * Math.random() - 1); // -25% to +25%
  return Math.max(0, Math.round(delay + jitter));
}

/**
 * Calculate exponential backoff delay for a given attempt.
 *
 * @param baseDelay - Base delay in milliseconds
 * @param attempt - Zero-based attempt number
 * @returns Delay in milliseconds (without jitter)
 */
export function calculateBackoff(baseDelay: number, attempt: number): number {
  return baseDelay * Math.pow(2, attempt);
}

/**
 * Determine whether a status code represents a transient server error
 * that is eligible for retry (502, 503, 504).
 */
export function isTransientStatusCode(statusCode: number): boolean {
  return TRANSIENT_STATUS_CODES.includes(statusCode);
}

/**
 * Determine whether a status code indicates rate limiting (429).
 */
export function isRateLimited(statusCode: number): boolean {
  return statusCode === 429;
}

/**
 * Determine whether a failed response should be retried, and compute the delay.
 *
 * @param statusCode - HTTP status code of the response
 * @param headers - Response headers (used to read Retry-After for 429)
 * @param attempt - Zero-based attempt number
 * @param config - Retry configuration
 * @returns A RetryDecision indicating whether to retry and the delay
 */
export function getRetryDecision(
  statusCode: number,
  headers: http.IncomingHttpHeaders,
  attempt: number,
  config: RetryConfig,
): RetryDecision {
  // 429 rate limiting — use Retry-After or longer backoff (4x base)
  if (isRateLimited(statusCode) && attempt < config.maxRateLimitRetries) {
    const retryAfter = parseRetryAfter(headers['retry-after']);
    const rawDelay = retryAfter ?? (config.retryDelayMs * 4 * Math.pow(2, attempt));
    return {
      shouldRetry: true,
      delayMs: addJitter(rawDelay),
      reason: 'Rate limited (429)',
    };
  }

  // 5xx transient server errors — standard exponential backoff
  if (isTransientStatusCode(statusCode) && attempt < config.maxRetries) {
    const rawDelay = calculateBackoff(config.retryDelayMs, attempt);
    return {
      shouldRetry: true,
      delayMs: addJitter(rawDelay),
      reason: `Transient server error (${statusCode})`,
    };
  }

  return { shouldRetry: false, delayMs: 0, reason: 'Not retryable' };
}

/**
 * Determine whether a connection/timeout error should be retried, and compute the delay.
 *
 * @param attempt - Zero-based attempt number
 * @param config - Retry configuration
 * @returns A RetryDecision indicating whether to retry and the delay
 */
export function getErrorRetryDecision(
  attempt: number,
  config: RetryConfig,
): RetryDecision {
  if (attempt < config.maxRetries) {
    const rawDelay = calculateBackoff(config.retryDelayMs, attempt);
    return {
      shouldRetry: true,
      delayMs: addJitter(rawDelay),
      reason: 'Connection or timeout error',
    };
  }

  return { shouldRetry: false, delayMs: 0, reason: 'Max retries exceeded' };
}
