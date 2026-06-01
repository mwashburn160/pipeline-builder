// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

// Interval validation MUST happen at the route layer (against REPORT_INTERVALS):
// ReportingService interpolates the value directly into `DATE_TRUNC(${interval}, ...)`,
// so an unvalidated string would be a raw-SQL injection vector. The service-side
// check is defense-in-depth — the route is the security boundary.

export const MAX_REPORT_LIMIT = 1000;
export const MAX_REPORT_RANGE_DAYS = 365;
export const MAX_REPORT_RANGE_MS = MAX_REPORT_RANGE_DAYS * 24 * 60 * 60 * 1000;

/** Patterns that match common credential leakage in error messages. */
const CREDENTIAL_PATTERNS: ReadonlyArray<RegExp> = [
  /AWS_[A-Z_]+=[\S]+/g,
  /(password|secret|token|key)[\s:=]+\S+/gi,
];

/** Redact credential-shaped substrings from a failure/error message. */
export function scrubErrorMessage(msg: string | null | undefined): string | null | undefined {
  if (!msg) return msg;
  return CREDENTIAL_PATTERNS.reduce((acc, re) => acc.replace(re, '[REDACTED]'), msg);
}
