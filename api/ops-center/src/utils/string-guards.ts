// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Validate that a value is a non-empty string no longer than `max`. A
 * lightweight defense-in-depth guard for free-text request fields (titles,
 * labels, silence comments, matcher values): it bounds the input length and
 * narrows the type in one check. Default cap is 256.
 */
export function isReasonableString(v: unknown, max = 256): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= max;
}
