// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Single source of truth for "what counts as sensitive" across every masking
 * layer.
 *
 * Four layers consume this module (see `docs/plans/frontend-logs.md` §3.4):
 *
 *   L1  key-based, write-time   — winston `redactFormat` (metadata keys)
 *   L2  value-based, write-time — winston `maskFormat` (the message string)
 *   L3  value-based, ingest-time — promtail `replace` stages  ← AUTHORITATIVE
 *   L4  value-based, read-time  — platform's Loki client, before serving/export
 *
 * **L3 is the guarantee, not L4.** Read-time masking only masks the DISPLAY: the
 * secret is still in Loki and still matchable, so a user can search a candidate
 * value and learn from the hit that it is present, even though the line renders
 * `[REDACTED]`. Repeat that and search becomes an oracle. Masking therefore has
 * to happen before storage for anything the search path can match; L4 exists to
 * cover history written before L3 shipped, and as defense in depth.
 *
 * Because L3 runs inside promtail (Go / RE2) and L1/L2/L4 run in Node, each
 * pattern carries BOTH forms and a generator emits the promtail YAML from this
 * list — see `scripts/gen-promtail-masking.mjs`. Keeping one list is the point:
 * `SENSITIVE_KEY_PATTERN` previously existed in two hand-synced copies, and a
 * third would have made drift certain.
 */

import { scrubAwsIdentifiersFromString } from './aws-scrub.js';

export const REDACTED = '[REDACTED]';

/**
 * Keys whose VALUE must be masked wholesale, regardless of the value's shape.
 * Case-insensitive, anchored-substring match.
 *
 * Add a term only for leakage you've actually seen — over-redaction makes
 * incident debugging harder, and these logs are now a product surface.
 */
export const SENSITIVE_KEY_PATTERN = /password|secret|bearer|api[_-]?key|cookie|token|^auth(orization|_header)?$|stripe[_-]?(key|secret)|mongo(db)?[_-]?uri/i;

/**
 * One secret-shaped value pattern.
 *
 * `js` is used by the Node-side layers. `re2` is the equivalent source for
 * promtail's `replace` stage — Go's RE2 has no lookaround, so a pattern that
 * needs it has `re2: null` and stays Node-only (L2/L4 still catch it; it just
 * isn't scrubbed before storage). `(?i)` is spelled inline for RE2 because
 * promtail takes a bare source string, while the JS form uses the `i` flag.
 */
export interface SensitiveValuePattern {
  /** Stable identifier, used as the promtail stage comment. */
  name: string;
  js: RegExp;
  /** RE2 source for promtail, or null when the pattern is JS-only. */
  re2: string | null;
  /** Replacement text. `$1` keeps a leading capture (e.g. the `?token=` prefix). */
  replacement: string;
}

/**
 * Ordered — earlier patterns win, so the specific (a Stripe key) is masked
 * before the generic (a `secret=` assignment) can produce a messier result.
 */
export const SENSITIVE_VALUE_PATTERNS: readonly SensitiveValuePattern[] = [
  {
    // A PEM block spans lines, so promtail (which replaces per line) can't see
    // the whole thing — JS-only. The BEGIN line alone is still a strong signal.
    name: 'pem_private_key',
    js: /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,
    re2: null,
    replacement: REDACTED,
  },
  {
    name: 'pem_private_key_header',
    js: /-----BEGIN[A-Z ]*PRIVATE KEY-----/g,
    re2: '-----BEGIN[A-Z ]*PRIVATE KEY-----',
    replacement: REDACTED,
  },
  {
    name: 'jwt',
    js: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g,
    re2: 'eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]*',
    replacement: REDACTED,
  },
  {
    name: 'bearer_token',
    js: /bearer\s+[A-Za-z0-9._~+/-]+=*/gi,
    re2: '(?i)bearer\\s+[A-Za-z0-9._~+/-]+=*',
    replacement: `Bearer ${REDACTED}`,
  },
  {
    name: 'aws_access_key_id',
    js: /\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g,
    re2: '\\b(A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\\b',
    replacement: REDACTED,
  },
  {
    name: 'stripe_key',
    js: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g,
    re2: '\\b(sk|rk)_(live|test)_[A-Za-z0-9]{10,}\\b',
    replacement: REDACTED,
  },
  {
    name: 'github_token',
    js: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
    re2: '\\bgh[pousr]_[A-Za-z0-9]{20,}\\b',
    replacement: REDACTED,
  },
  {
    name: 'slack_token',
    js: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
    re2: '\\bxox[abprs]-[A-Za-z0-9-]{10,}\\b',
    replacement: REDACTED,
  },
  {
    // `scheme://user:pass@host` — keep the scheme so the line stays readable.
    name: 'url_credentials',
    js: /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^:@/\s]+:[^@/\s]+@/g,
    re2: '([a-zA-Z][a-zA-Z0-9+.-]*://)[^:@/\\s]+:[^@/\\s]+@',
    replacement: `$1${REDACTED}@`,
  },
  {
    // `?token=…` / `&api_key=…` in a URL. Keeps the parameter name visible.
    name: 'url_secret_param',
    js: /([?&](?:access[_-]?token|api[_-]?key|apikey|auth|password|secret|sig|signature|token)=)[^&\s"'<>]+/gi,
    re2: '(?i)([?&](access[_-]?token|api[_-]?key|apikey|auth|password|secret|sig|signature|token)=)[^&\\s"\'<>]+',
    replacement: `$1${REDACTED}`,
  },
  {
    // `secret=…` / `"password": "…"` style assignments in free text.
    // `&` is excluded from the value class so this can't run on after
    // `url_secret_param` and swallow the rest of a query string — the URL rule
    // has already masked those, and this one must not eat `&page=2`.
    name: 'inline_secret_assignment',
    js: /((?:aws_)?(?:secret_access_key|client_secret|api[_-]?key|apikey|password|passwd|secret|token)"?\s*[=:]\s*"?)[^\s"',;}&]+/gi,
    re2: '(?i)(((aws_)?(secret_access_key|client_secret|api[_-]?key|apikey|password|passwd|secret|token))"?\\s*[=:]\\s*"?)[^\\s"\',;}&]+',
    replacement: `$1${REDACTED}`,
  },
];

/**
 * Mask secret-shaped values in a single string.
 *
 * Also scrubs AWS account identifiers via {@link scrubAwsIdentifiersFromString}
 * — a hard repo rule (an AWS account id must never be persisted or surfaced),
 * composed here rather than duplicated so the two rules can't drift.
 *
 * Non-throwing and allocation-light on the common path: strings with no match
 * come back by identity.
 */
export function maskLine(input: string): string {
  if (!input) return input;
  let out = input;
  for (const { js, replacement } of SENSITIVE_VALUE_PATTERNS) {
    // `js` carries the /g flag, so reset lastIndex — a shared RegExp object is
    // stateful across calls and would otherwise skip matches intermittently.
    js.lastIndex = 0;
    out = out.replace(js, replacement);
  }
  return scrubAwsIdentifiersFromString(out);
}

/**
 * Does this string look like it CONTAINS a secret? Used to reject log-search
 * terms, closing the other end of the oracle described at the top of this file:
 * masking the result is pointless if the query itself can confirm a guess.
 */
export function looksSensitive(input: string): boolean {
  if (!input) return false;
  return maskLine(input) !== input;
}
