// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Redact AWS account identifiers from values headed for a DURABLE store or an
 * outbound payload (audit `details`, ingested event `detail`, error messages).
 *
 * HARD CONSTRAINT: an AWS account id must NEVER be persisted anywhere in this
 * system — `orgId` is the marketplace `customerIdentifier`, never an AWS account
 * id. AWS surfaces (CodePipeline/CodeBuild failure messages, KMS/role ARNs) leak
 * the account id as the 5th ARN segment or as a bare 12-digit token, so scrub at
 * every boundary that writes untrusted AWS-derived text. Defense-in-depth: apply
 * this even when an upstream (e.g. the events Lambda) is expected to have
 * stripped it — the persistence boundary must not trust upstream.
 */

const REDACTED = '[REDACTED]';

/**
 * A 12-digit run is the AWS account-id shape (and the account segment of every
 * ARN). Bounded by non-digits so we never clip inside a longer number (e.g. a
 * 13-digit millisecond timestamp is left intact).
 */
const AWS_ACCOUNT_ID_RE = /(?<!\d)\d{12}(?!\d)/g;

/** Keys that name an AWS account id outright — their value is dropped wholesale. */
const ACCOUNT_KEY_RE = /account/i;

/** Redact every AWS-account-id-shaped token (incl. the account field of any ARN) from a string. */
export function scrubAwsIdentifiersFromString(input: string): string {
  return input.replace(AWS_ACCOUNT_ID_RE, REDACTED);
}

/**
 * Deep-scrub a value (string / array / plain object) of AWS account identifiers,
 * returning a scrubbed copy — the input is never mutated. String values have
 * account-id tokens redacted; any key matching {@link ACCOUNT_KEY_RE} with a
 * string/number value is redacted wholesale. Non-string primitives pass through
 * unchanged (a bare number is only redacted when it sits under an account-named
 * key, to avoid clobbering legitimate numeric fields).
 */
export function scrubAwsIdentifiers<T>(value: T): T {
  if (typeof value === 'string') {
    return scrubAwsIdentifiersFromString(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => scrubAwsIdentifiers(v)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    // Recurse plain AND null-prototype objects (data bags). A Date/Buffer/Map/
    // class instance is NOT a plain object, and walking it via Object.entries
    // would clobber it to `{}` (or a byte map) — silently destroying e.g. a Date
    // held in audit `details`. But a null-prototype object (`Object.create(null)`,
    // some JSON.parse revivers, BSON docs) is a plain data bag that must still be
    // scrubbed — skipping it was a hole at the very persistence boundary this
    // module guards. Leave only prototyped non-plain objects untouched.
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (ACCOUNT_KEY_RE.test(k) && (typeof v === 'string' || typeof v === 'number')) {
        out[k] = REDACTED;
      } else {
        out[k] = scrubAwsIdentifiers(v);
      }
    }
    return out as T;
  }
  return value;
}
