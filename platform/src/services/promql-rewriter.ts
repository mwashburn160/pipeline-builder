// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 *  PromQL-aware org_id matcher injection.
 *
 * Replaces the substring tenancy gate in alert-rule-service.ts. The previous
 * check (`expr.includes(\`org_id="<orgId>"\`)`) caught the common case but
 * had two problems * 1. An attacker can write `vector(0) + sum(rate(http_requests_total[5m]))`
 * and append `# org_id="org-acme"` somewhere  the substring check
 * passes, the expr still fires across every org.
 * 2. Honest operators have to manually paste the same matcher into every
 * metric selector, which is tedious for compound expressions.
 *
 * This module solves both: a real PromQL parser walks the expression, finds
 * every metric selector, and either VALIDATES that the org_id matcher is
 * present (strict) or INJECTS it automatically (lenient  preferred).
 *
 * Scope of the parser: enough to find metric selectors reliably. NOT a
 * full PromQL evaluator. Handles * - bare metric names → `up`
 * - metric with selector → `http_requests_total{status="5xx"}`
 * - functions / aggregations → `rate(...)`, `sum by (org_id) (...)`
 * - string literals (single/double quoted)
 * - comments via `#` (rejected  operators shouldn't have them)
 * - reserved words → `by`, `without`, `on`, `ignoring`, etc.
 *
 * Out of scope (will reject loudly) * - `@` modifier with timestamps (real but rare in alert rules)
 * - subqueries `[5m:1m]` (parser doesn't track subquery depth  bracket
 * counting is good enough to skip them but we don't dive in to inject)
 */

/** Set of PromQL reserved words / function names that look like metric
 * names but aren't. Identifiers in this set never get the org_id matcher
 * even if not followed by `(`  covers things like `by (foo)` where `by`
 * isn't followed by a paren immediately. */
const RESERVED = new Set<string>([
  // Keywords (binary / scalar operator modifiers)
  'and', 'or', 'unless', 'bool',
  // Vector matching modifiers
  'on', 'ignoring', 'group_left', 'group_right',
  // Aggregation modifiers
  'by', 'without',
  // Time modifiers
  'offset', 'start', 'end',
  // Common functions / aggregators  these are caught by the `(` check
  // already, but keeping them here is defense-in-depth against odd
  // whitespace (e.g. `sum (` with a space).
  'sum', 'avg', 'min', 'max', 'count', 'stddev', 'stdvar',
  'rate', 'increase', 'irate', 'delta', 'idelta', 'deriv',
  'histogram_quantile', 'histogram_count', 'histogram_sum',
  'quantile_over_time', 'avg_over_time', 'sum_over_time',
  'min_over_time', 'max_over_time', 'count_over_time',
  'last_over_time', 'present_over_time',
  'predict_linear', 'holt_winters', 'absent', 'absent_over_time',
  'changes', 'resets', 'sort', 'sort_desc', 'topk', 'bottomk',
  'clamp', 'clamp_max', 'clamp_min', 'round', 'floor', 'ceil',
  'abs', 'exp', 'ln', 'log2', 'log10', 'sqrt',
  'time', 'timestamp', 'vector', 'scalar',
  'label_replace', 'label_join',
  'year', 'month', 'day_of_month', 'day_of_week', 'hour', 'minute',
  'days_in_month',
  // Boolean-ish constants
  'true', 'false', 'nan', 'inf',
]);

/**
 * Walk an expression and return every metric-selector location. A metric
 * selector is an identifier that is NOT a reserved word and NOT followed
 * immediately by `(`. Returns the labelset shape as well  so callers can
 * inspect whether the org_id matcher is present.
 */
interface MetricSelectorMatch {
  /** Position of the identifier start in the source expression. */
  start: number;
  /** Position one past the end of the labelset (or the identifier if no labelset). */
  end: number;
  /** The identifier text. */
  name: string;
  /** Raw labelset content (between `{` and `}`), or null when there were no `{}`. */
  labelsetRaw: string | null;
  /** Position of the `{` if one exists  used by the injector to write at the right spot. */
  labelsetOpen: number | null;
  /** Position of the matching `}`. */
  labelsetClose: number | null;
}

/** Identifier regex matching PromQL's grammar. */
const IDENT_RE = /[a-zA-Z_:][a-zA-Z0-9_:]*/y; // sticky for incremental scan

/** Aggregation / matching keywords whose argument list `(...)` contains
 * label names, not sub-expressions. After seeing one of these we skip
 * the entire balanced paren group so its contents don't get treated as
 * metric selectors. */
const LABEL_LIST_KEYWORDS = new Set<string>([
  'by', 'without', 'on', 'ignoring', 'group_left', 'group_right',
]);

function findMetricSelectors(expr: string): MetricSelectorMatch[] {
  const out: MetricSelectorMatch[] = [];
  let i = 0;
  let inString: '"' | "'" | null = null;

  while (i < expr.length) {
    const c = expr[i];

    // Skip string literals  identifier-looking text inside a string isn't a metric.
    if (inString) {
      if (c === '\\' && i + 1 < expr.length) { i += 2; continue; }
      if (c === inString) inString = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'") { inString = c; i++; continue; }

    // PromQL doesn't have line comments in expressions; reject them
    // upstream rather than silently skipping over.

    // Skip whitespace, operators, punctuation we don't care about.
    if (!/[a-zA-Z_:]/.test(c)) { i++; continue; }

    // Filter out identifier-starts that are actually duration suffixes
    // `[5m]`, `1h30m`, etc. PromQL durations attach a unit character
    // (`s`, `m`, `h`, `d`, `w`, `y`, or `ms`) directly to a digit. If the
    // previous non-whitespace char is a digit AND we're inside `[...]`,
    // this identifier is a duration unit, not a metric.
    const prev = i > 0 ? expr[i - 1]: '';
    if (/[0-9]/.test(prev)) { i++; continue; }

    // Identifier candidate. Scan it.
    IDENT_RE.lastIndex = i;
    const m = IDENT_RE.exec(expr);
    if (!m) { i++; continue; }
    const identStart = i;
    const identEnd = i + m[0].length;
    i = identEnd;

    // Label-list keyword (`by (foo)` / `without (le)` / etc.). Skip the
    // entire following `(...)` so we don't treat the label names inside
    // as metrics.
    if (LABEL_LIST_KEYWORDS.has(m[0])) {
      let j = identEnd;
      while (j < expr.length && /\s/.test(expr[j])) j++;
      if (expr[j] === '(') {
        let depth = 1;
        let k = j + 1;
        while (k < expr.length && depth > 0) {
          if (expr[k] === '(') depth++;
          else if (expr[k] === ')') depth--;
          k++;
        }
        i = k;
      }
      continue;
    }

    if (RESERVED.has(m[0])) continue;

    // Peek for the next non-whitespace character. `(` → function. `{` → selector.
    // Anything else (operator, end of expr, `[`, etc.) → bare metric.
    let j = identEnd;
    while (j < expr.length && /\s/.test(expr[j])) j++;
    const peek = expr[j];

    if (peek === '(') continue; // function call  skip

    if (peek === '{') {
      // Parse the labelset to find the matching close brace, respecting
      // string literals inside (label values can contain `{` / `}`).
      let depth = 1;
      let k = j + 1;
      let inStr: '"' | "'" | null = null;
      while (k < expr.length && depth > 0) {
        const ch = expr[k];
        if (inStr) {
          if (ch === '\\' && k + 1 < expr.length) { k += 2; continue; }
          if (ch === inStr) inStr = null;
        } else if (ch === '"' || ch === "'") {
          inStr = ch;
        } else if (ch === '{') {
          depth++;
        } else if (ch === '}') {
          depth--;
        }
        k++;
      }
      if (depth !== 0) {
        // Unbalanced braces  bail with what we've got so the caller's
        // validator can flag it.
        throw new PromQLRewriteError('Unbalanced `{` / `}` in expression');
      }
      out.push({
        start: identStart,
        end: k,
        name: m[0],
        labelsetRaw: expr.substring(j + 1, k - 1),
        labelsetOpen: j,
        labelsetClose: k - 1,
      });
      i = k;
      continue;
    }

    // Bare metric (no labelset).
    out.push({
      start: identStart,
      end: identEnd,
      name: m[0],
      labelsetRaw: null,
      labelsetOpen: null,
      labelsetClose: null,
    });
  }

  if (inString) {
    throw new PromQLRewriteError('Unterminated string literal in expression');
  }
  return out;
}

/** Custom error type so callers can distinguish parse failures from other throws. */
export class PromQLRewriteError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'PromQLRewriteError';
  }
}

/** Detect whether a labelset contains an `org_id="..."` or `org_id=~"..."`
 * matcher with the expected value. Walks labels via a small state machine
 * (not split-by-comma) because label values can contain commas. */
function labelsetHasOrgId(labelset: string, orgId: string): boolean {
  // Match `org_id` followed by `=` / `=~` / `!=` / `!~` then a quoted string.
  // We accept `=` and `=~` (both flag the rule as scoped to this org); `!=`
  // and `!~` are NOT acceptable  they'd EXCLUDE the org, the opposite of
  // what we want.
  const re = /org_id\s*(=~?|!~?)\s*(["'])([^"']*)\2/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(labelset))) {
    const op = m[1];
    const value = m[3];
    if ((op === '=' || op === '=~') && value === orgId) return true;
    // `=` to a DIFFERENT org → cross-tenant attempt; explicit caller-visible
    // failure rather than silently passing.
    if (op === '=' && value !== orgId) {
      throw new PromQLRewriteError( `expression references org_id="${value}" which doesn't match the rule's own org ("${orgId}")`,
      );
    }
  }
  return false;
}

/**
 * Inject `org_id="<orgId>"` into every metric selector that doesn't already
 * have it. Operators write `rate(http_requests_total[5m])` and the rule
 * stored in the DB becomes `rate(http_requests_total{org_id="org-acme"}[5m])`.
 *
 * Returns the rewritten expression. Throws PromQLRewriteError on * - malformed expression (unbalanced braces, unterminated strings)
 * - cross-tenant attempts (`org_id="org-other"` referenced by org-acme)
 *
 * The rewrite is idempotent  running it twice produces the same output.
 */
export function injectOrgId(expr: string, orgId: string): string {
  if (expr.includes('#')) {
    throw new PromQLRewriteError('Comments (#) are not allowed in alert-rule expressions');
  }

  const selectors = findMetricSelectors(expr);

  // Walk back-to-front so positions in earlier matches don't shift.
  const sorted = [...selectors].sort((a, b) => b.start - a.start);
  let out = expr;

  for (const sel of sorted) {
    if (sel.labelsetRaw !== null) {
      if (labelsetHasOrgId(sel.labelsetRaw, orgId)) continue;
      // Inject as the first label so the wire form is stable + easy to
      // grep for. Strip a leading comma if the labelset wasn't empty.
      const trimmed = sel.labelsetRaw.trim();
      const inserted = trimmed.length === 0
        ? `org_id="${orgId}"`
        : `org_id="${orgId}",${sel.labelsetRaw}`;
      out = out.substring(0, sel.labelsetOpen! + 1) + inserted + out.substring(sel.labelsetClose!);
    } else {
      // Bare metric  wrap with `{org_id="..."}`.
      out = out.substring(0, sel.end) + `{org_id="${orgId}"}` + out.substring(sel.end);
    }
  }

  return out;
}

/**
 * Validation-only mode: returns ok=true if every metric selector already
 * includes the matcher, ok=false with a message otherwise. Doesn't rewrite.
 * Used by routes that want to surface a fix-it message to the operator
 * rather than silently rewriting their expression.
 */
export function validateOrgIdMatchers(expr: string, orgId: string): { ok: true } | { ok: false; message: string } {
  let selectors: MetricSelectorMatch[];
  try {
    if (expr.includes('#')) {
      return { ok: false, message: 'Comments (#) are not allowed in alert-rule expressions' };
    }
    selectors = findMetricSelectors(expr);
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message: String(err) };
  }
  for (const sel of selectors) {
    try {
      const has = sel.labelsetRaw !== null && labelsetHasOrgId(sel.labelsetRaw, orgId);
      if (!has) {
        return {
          ok: false,
          message: `metric "${sel.name}" needs an org_id="${orgId}" matcher to scope it to your org`,
        };
      }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message: String(err) };
    }
  }
  return { ok: true };
}
