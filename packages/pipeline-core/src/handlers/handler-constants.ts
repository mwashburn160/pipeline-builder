/**
 * @module handlers/handler-constants
 * @description Lightweight constants for Lambda handlers. Avoids importing CoreConstants
 * (which pulls in billing, database, infrastructure configs) into the Lambda bundle.
 */

/** HTTP request timeout for plugin lookup API calls (ms). Must be less than Lambda timeout to allow response handling. */
export const HANDLER_TIMEOUT_MS = parseInt(process.env.HANDLER_TIMEOUT_MS || '25000');

/** Default base URL when not provided via custom resource properties. */
export const HANDLER_DEFAULT_BASE_URL = process.env.PLATFORM_BASE_URL || 'https://localhost:8443';

/** Maximum number of retry attempts for transient failures. */
export const HANDLER_MAX_RETRIES = parseInt(process.env.HANDLER_MAX_RETRIES || '2');

/** Initial backoff delay between retries (ms). Doubles on each retry. */
export const HANDLER_RETRY_DELAY_MS = parseInt(process.env.HANDLER_RETRY_DELAY_MS || '1000');
