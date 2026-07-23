// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Defense-in-depth redaction for free-form audit `details` blobs.
 *
 * The audit UI renders and exports the emitter-controlled `details` object
 * verbatim. If any emitter ever puts a secret / token / AWS account id into
 * it, an admin would see and export it. This helper produces a redacted DEEP
 * COPY of a details object so both render and export paths stay clean.
 *
 * Two independent passes:
 *   1. Sensitive-key masking — any key whose name matches a sensitive pattern
 *      has its value replaced wholesale (regardless of the value's shape).
 *   2. AWS-account-id scrubbing — any 12-digit run in a string value (incl.
 *      the account segment of an ARN) is replaced, since an AWS account id
 *      must never appear or persist.
 *
 * This is a client-side belt-and-suspenders layer; emitters should still
 * avoid putting secrets in `details` server-side.
 */

const REDACTED = '[REDACTED]';

/**
 * Keys whose values must be masked. Mirrors the server-side
 * `SENSITIVE_KEY_PATTERN` in `packages/api-core/src/utils/logger.ts`
 * (kept in sync manually — the frontend must NOT import api-core server
 * code). Extended here with `account` / `accountId` so AWS-account-bearing
 * keys are masked by name as well as by value shape.
 * Case-insensitive, anchored-substring match.
 */
const SENSITIVE_KEY_PATTERN =
  /password|secret|bearer|api[_-]?key|cookie|token|^auth(orization|_header)?$|stripe[_-]?(key|secret)|mongo(db)?[_-]?uri|account/i;

/**
 * Matches a run of exactly 12 digits that is NOT part of a longer digit run.
 * Bounded by non-digits (or string edges) so the account segment of an ARN
 * — `arn:aws:kms:us-east-1:123456789012:key/x` — is caught while a longer
 * numeric id is left alone.
 */
const AWS_ACCOUNT_ID = /(?<!\d)\d{12}(?!\d)/g;

/** Scrub AWS-account-id-shaped tokens out of a single string. */
function redactString(s: string): string {
  return s.replace(AWS_ACCOUNT_ID, REDACTED);
}

function redactValue(value: unknown, depth: number): unknown {
  // Cap depth so a pathological / deeply-nested blob can't lock the render.
  if (depth > 8) return value;
  if (typeof value === 'string') return redactString(value);
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY_PATTERN.test(k) ? REDACTED : redactValue(v, depth + 1);
  }
  return out;
}

/**
 * Return a redacted deep copy of an audit `details` object. Never mutates
 * the input. Safe to call with `undefined` (returns `undefined`).
 */
export function redactDetails<T>(details: T): T {
  if (details == null) return details;
  return redactValue(details, 0) as T;
}
