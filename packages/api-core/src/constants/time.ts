// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Named time constants to prevent magic-number confusion.
 * All values include their unit in the name to avoid ms/s ambiguity.
 */

/** 30 seconds in milliseconds — default SSE ticket TTL. */
export const SSE_TICKET_TTL_MS = 30_000;

/** 4 hours in seconds — billing plan cache TTL. */
export const CACHE_TTL_BILLING_PLANS_SECS = 14_400;

/** 4 hours in milliseconds — temp directory cleanup threshold. */
export const TEMP_DIR_MAX_AGE_MS = 14_400_000;
