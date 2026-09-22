// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Rule operator evaluation functions.
 *
 * Each operator takes a field value from the entity and a rule value,
 * returning true if the condition is MET (no violation) or false if VIOLATED.
 */

import { createContext, Script, type Context } from 'vm';
import { createLogger, envInt, errorMessage } from '@pipeline-builder/api-core';
import type { RuleOperator } from '@pipeline-builder/pipeline-data';

const logger = createLogger('rule-operators');

/**
 * Cap on user-supplied regex patterns in compliance rules. Override via
 * `COMPLIANCE_MAX_REGEX_LENGTH`. Authoring-time hygiene only — it is NOT the
 * ReDoS bound (a 9-character `(a+)+$` is already catastrophic).
 */
const MAX_REGEX_LENGTH = envInt('COMPLIANCE_MAX_REGEX_LENGTH', 100, { min: 1 });

/**
 * HARD wall-clock bound on one rule-authored regex match. Override via
 * `COMPLIANCE_REGEX_TIMEOUT_MS`.
 */
const REGEX_TIMEOUT_MS = envInt('COMPLIANCE_REGEX_TIMEOUT_MS', 50, { min: 1 });

/**
 * ReDoS bound for rule-authored patterns.
 *
 * Rule patterns are authored by an org (and PROPAGATE from a parent org), then
 * evaluated on the entity-create hot path, so an unbounded match pins the
 * compliance pod's event loop for every tenant. Node's `RegExp` is a
 * backtracking engine and a length cap plus a nested-quantifier heuristic is
 * not a bound — `(a+)+$` is 6 characters.
 *
 * The bound here is real: the match runs inside a `vm` context under a
 * `timeout`, and V8's irregexp engine honours the isolate's termination check,
 * so a catastrophically-backtracking match is INTERRUPTED rather than run to
 * completion (verified on the pinned Node 24 runtime — a 40×'a' + 'b' input
 * against `(a+)+$` aborts at the deadline instead of hanging).
 *
 * Why not `re2`: it is a native (node-gyp) dependency, which would have to
 * clear the repo's `minimumReleaseAge` supply-chain hold AND be built for both
 * image architectures. `vm` is in the standard library, needs no dependency,
 * and keeps `evaluateOperator` synchronous (a worker thread would force every
 * caller of `evaluateRules` async for the same guarantee).
 *
 * The script and context are created once and reused; the context holds no
 * state beyond the three scratch globals, and stays usable after a timeout.
 */
const REGEX_SCRIPT = new Script('__pbResult = new RegExp(__pbPattern).test(__pbValue)');

interface RegexSandbox extends Context {
  __pbPattern: string;
  __pbValue: string;
  /** Written by the sandboxed script, not by us — hence `unknown`. */
  __pbResult: unknown;
}

/**
 * Read the sandbox's result. Behind a function call on purpose: the value is
 * written by the vm script OUT OF BAND, so narrowing it from our own
 * `ctx.__pbResult = false` reset would be wrong (and TS would fold the
 * comparison away).
 */
function readSandboxResult(ctx: RegexSandbox): boolean {
  return ctx.__pbResult === true;
}

let sandbox: RegexSandbox | null = null;

function getSandbox(): RegexSandbox {
  // `Object.create(null)` so a pattern can't reach anything through the
  // prototype chain; the context holds no globals of its own.
  if (!sandbox) sandbox = createContext(Object.create(null) as RegexSandbox) as RegexSandbox;
  return sandbox;
}

/**
 * Compile and test a rule-authored regex under a hard length cap and a hard
 * wall-clock deadline. Returns false (= VIOLATED, fail-closed) when the pattern
 * is too long, is invalid, or exceeds {@link REGEX_TIMEOUT_MS}.
 */
export function safeRegexTest(pattern: string, value: string): boolean {
  if (pattern.length > MAX_REGEX_LENGTH) return false;
  const ctx = getSandbox();
  ctx.__pbPattern = pattern;
  ctx.__pbValue = value;
  ctx.__pbResult = false;
  try {
    REGEX_SCRIPT.runInContext(ctx, { timeout: REGEX_TIMEOUT_MS });
    return readSandboxResult(ctx);
  } catch (err) {
    // A timeout is the interesting case: the pattern is pathological (or the
    // input adversarial) and would otherwise have pinned the event loop. Log
    // it — the pattern, never the entity value — and fail closed.
    if (err instanceof Error && /timed out/i.test(err.message)) {
      logger.warn('Compliance regex evaluation exceeded its deadline; treating as violated', {
        pattern, timeoutMs: REGEX_TIMEOUT_MS, valueLength: value.length,
      });
      // Drop the context so nothing from the aborted run is carried forward.
      sandbox = null;
    }
    return false;
  }
}

/**
 * Get a nested value from an object using dot-notation path.
 *
 * Supports computed field prefixes for derived values:
 * - `$count(field)` — array length or object key count
 * - `$length(field)` — string character length
 * - `$keys(field)` — object keys as string array
 * - `$lines(field)` — line count of a string field
 *
 * @param entity - The entity object to extract from
 * @param fieldPath - Dot-notation path (e.g., "props.stages") or computed prefix (e.g., "$count(secrets)")
 * @returns The resolved value, or undefined if the path doesn't exist
 *
 * @example
 * getFieldValue({ a: { b: 1 } }, 'a.b')        // → 1
 * getFieldValue({ arr: [1,2,3] }, '$count(arr)') // → 3
 * getFieldValue({ s: 'hello' }, '$length(s)')    // → 5
 */
export function getFieldValue(entity: Record<string, unknown>, fieldPath: string): unknown {
  // Handle computed fields: $count(field), $length(field), $keys(field), $lines(field)
  const computedMatch = fieldPath.match(/^\$(\w+)\((.+)\)$/);
  if (computedMatch) {
    const [, fn, innerPath] = computedMatch;
    const v = getFieldValue(entity, innerPath);
    const computedFns: Record<string, (val: unknown) => unknown> = {
      count: (val) => Array.isArray(val) ? val.length : (val && typeof val === 'object') ? Object.keys(val).length : 0,
      length: (val) => typeof val === 'string' ? val.length : 0,
      keys: (val) => (val && typeof val === 'object' && !Array.isArray(val)) ? Object.keys(val) : [],
      lines: (val) => typeof val === 'string' ? val.split('\n').length : 0,
    };
    return computedFns[fn]?.(v);
  }

  // Standard dot-notation traversal
  const parts = fieldPath.split('.');
  let current: unknown = entity;

  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

/**
 * Evaluate a single operator against field and rule values.
 *
 * @param operator - The comparison operator to apply
 * @param fieldValue - The actual value from the entity
 * @param ruleValue - The expected value from the rule definition
 * @returns `true` if the condition is SATISFIED (no violation), `false` if VIOLATED
 *
 * @example
 * evaluateOperator('eq', 'CodeBuildStep', 'CodeBuildStep')  // → true
 * evaluateOperator('gt', 100, 50)                           // → true
 * evaluateOperator('in', 'SMALL', ['SMALL', 'MEDIUM'])      // → true
 * evaluateOperator('regex', 'hello-world', '^hello')        // → true
 */
/** Check if fieldValue contains ruleValue (string or array). */
function evalContains(fieldValue: unknown, ruleValue: unknown): boolean {
  if (typeof fieldValue === 'string' && typeof ruleValue === 'string') {
    return fieldValue.toLowerCase().includes(ruleValue.toLowerCase());
  }
  if (Array.isArray(fieldValue)) {
    return fieldValue.some((v) => String(v).toLowerCase() === String(ruleValue).toLowerCase());
  }
  return false;
}

/** Operator lookup table — each entry returns true if condition is SATISFIED. */
const OPERATORS: Record<string, (fv: unknown, rv: unknown) => boolean> = {
  // Equality
  eq: (fv, rv) => fv === rv || String(fv) === String(rv),
  neq: (fv, rv) => fv !== rv && String(fv) !== String(rv),
  // String / array containment
  contains: evalContains,
  notContains: (fv, rv) => !evalContains(fv, rv),
  // Regex
  regex: (fv, rv) => typeof rv === 'string' && safeRegexTest(rv, String(fv ?? '')),
  // Numeric comparison
  gt: (fv, rv) => Number(fv) > Number(rv),
  gte: (fv, rv) => Number(fv) >= Number(rv),
  lt: (fv, rv) => Number(fv) < Number(rv),
  lte: (fv, rv) => Number(fv) <= Number(rv),
  // Set membership
  in: (fv, rv) => Array.isArray(rv) && rv.some((v) => String(v) === String(fv)),
  notIn: (fv, rv) => !Array.isArray(rv) || !rv.some((v) => String(v) === String(fv)),
  // Existence
  exists: (fv) => fv !== null && fv !== undefined,
  notExists: (fv) => fv === null || fv === undefined,
  // Truthy presence — stricter than `exists`: empty string, 0, and false are
  // treated as not present. Useful for required-but-non-empty checks where
  // `exists` would still pass on `field: ''`.
  notEmpty: (fv) => fv !== null && fv !== undefined && fv !== '' && fv !== 0 && fv !== false,
  // Count/length aliases (used with computed $count/$length fields)
  countGt: (fv, rv) => Number(fv) > Number(rv),
  countLt: (fv, rv) => Number(fv) < Number(rv),
  lengthGt: (fv, rv) => Number(fv) > Number(rv),
  lengthLt: (fv, rv) => Number(fv) < Number(rv),
};

export function evaluateOperator(
  operator: RuleOperator,
  fieldValue: unknown,
  ruleValue: unknown,
): boolean {
  return OPERATORS[operator]?.(fieldValue, ruleValue) ?? false; // Unknown operator = violation (fail-closed)
}

/**
 * Author-time validation for a regex pattern. Defence in depth ONLY — the
 * actual ReDoS bound is the deadline in {@link safeRegexTest}, which holds for
 * patterns this check misses and for rules that PROPAGATED from a parent org
 * without passing through it.
 *
 * Checks for:
 * - Maximum length (`MAX_REGEX_LENGTH`, default 100; override via `COMPLIANCE_MAX_REGEX_LENGTH`)
 * - Nested quantifiers that could cause ReDoS (e.g., `(a+)+`) — a narrow
 *   heuristic that rejects the obvious cases early with a clear message
 * - Valid regex syntax
 *
 * @param pattern - The regex pattern string to validate
 * @returns Error message if unsafe, `null` if safe
 */
export function validateRegexPattern(pattern: string): string | null {
  if (pattern.length > MAX_REGEX_LENGTH) {
    return `Regex pattern exceeds maximum length of ${MAX_REGEX_LENGTH} characters`;
  }

  // Reject known dangerous patterns (nested quantifiers like (a+)+, (a*)*b, etc.)
  if (/(\+|\*|\{[^}]+\})\s*\)?\s*(\+|\*|\{[^}]+\})/.test(pattern)) {
    return 'Regex pattern contains nested quantifiers which may cause performance issues';
  }

  try {
    new RegExp(pattern);
    return null;
  } catch (err) {
    return `Invalid regex pattern: ${errorMessage(err)}`;
  }
}

/**
 * Validate all regex patterns in a rule body (single-field operator + cross-field conditions).
 * Returns an error message string if any pattern is invalid, null if all are valid.
 */
export function validateRuleRegexPatterns(body: {
  operator?: string;
  value?: unknown;
  conditions?: Array<{ field: string; operator: string; value?: unknown }>;
}): string | null {
  if (body.operator === 'regex' && typeof body.value === 'string') {
    const err = validateRegexPattern(body.value);
    if (err) return err;
  }
  if (body.conditions) {
    for (const c of body.conditions) {
      if (c.operator === 'regex' && typeof c.value === 'string') {
        const err = validateRegexPattern(c.value);
        if (err) return `Condition "${c.field}": ${err}`;
      }
    }
  }
  return null;
}
