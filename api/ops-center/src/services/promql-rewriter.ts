// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 *  PromQL-aware org_id matcher injection.
 *
 * The tenancy gate for operator-authored alert rules: every metric selector
 * in an org's expression is pinned to `org_id="<org>"` so a rule can never
 * evaluate another tenant's series.
 *
 * Design (the invariant, not a pattern match):
 * - A real TOKENIZER lexes the expression into identifiers, numbers /
 *   durations, operators, punctuation and string literals — all three PromQL
 *   string forms (`"…"`, `'…'` with escapes, and backtick raw strings, which
 *   have no escapes). Nothing is ever inferred by regex over raw text, so a
 *   matcher name or value can't be smuggled past the gate inside a string the
 *   scanner mis-delimited (e.g. `{job=~"org_id='X'|.+"}`, `{xorg_id="X"}`,
 *   or a backtick string containing `"`).
 * - Every label-set is parsed matcher-by-matcher (name, operator, value).
 *   Anything that isn't a well-formed matcher list is rejected.
 * - `org_id="<org>"` is injected into EVERY selector regardless of which
 *   matchers it already has (Prometheus ANDs repeated matchers on one label),
 *   so no existing matcher — regex, negative, or otherwise — can widen scope.
 *   The only selector left untouched is one that already carries that exact
 *   equality matcher (tokenized), which keeps the rewrite idempotent.
 * - Unknown characters and `#` comments are rejected (fail closed).
 *
 * An identifier is treated as a metric selector unless it is a PromQL lexer
 * KEYWORD (aggregators, set operators, modifiers) or is followed by `(` (a
 * function call). Function names are NOT keywords to Prometheus — `sum(rate)`
 * selects a metric called `rate` — so they're deliberately not exempted here.
 * Misclassifying a keyword as a metric only makes Prometheus reject the
 * rewritten rule (fail closed); the reverse would leak, so the keyword list
 * is kept to real lexer keywords.
 */

import { errorMessage } from '@pipeline-builder/api-core';

/** Custom error type so callers can distinguish parse failures from other throws. */
export class PromQLRewriteError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'PromQLRewriteError';
  }
}

/**
 * PromQL lexer keywords (matched case-insensitively, as Prometheus does).
 * These can never be metric names.
 */
const KEYWORDS = new Set<string>([
  // Aggregation operators
  'sum', 'avg', 'count', 'min', 'max', 'group', 'stddev', 'stdvar',
  'topk', 'bottomk', 'count_values', 'quantile', 'limitk', 'limit_ratio',
  // Set / binary operators
  'and', 'or', 'unless', 'atan2',
  // Modifiers
  'bool', 'by', 'without', 'on', 'ignoring', 'group_left', 'group_right',
  'offset',
  // Number literals
  'inf', 'nan',
]);

/** Keywords whose parenthesized argument list holds label NAMES, not sub-expressions. */
const LABEL_LIST_KEYWORDS = new Set<string>([
  'by', 'without', 'on', 'ignoring', 'group_left', 'group_right',
]);

const MATCH_OPS = new Set(['=', '!=', '=~', '!~']);

type TokenKind = 'ident' | 'number' | 'string' | 'op' | 'punct';

interface Token {
  kind: TokenKind;
  /** Raw source text of the token. */
  text: string;
  /** Start offset in the source. */
  start: number;
  /** One past the end offset in the source. */
  end: number;
  /** Decoded value for string tokens; null when the literal uses escapes we
   * don't decode (such a value is never treated as equal to anything). */
  value?: string | null;
}

const IDENT_START = /[a-zA-Z_:]/;
const IDENT_PART = /[a-zA-Z0-9_:]/;
const NUMBER_PART = /[a-zA-Z0-9_.]/;
const WHITESPACE = /\s/;
/** Multi-char operators first so the longest match wins. */
const OPERATORS = ['=~', '!~', '!=', '==', '<=', '>=', '=', '<', '>', '+', '-', '*', '/', '%', '^', '@'];
const PUNCT = new Set(['(', ')', '{', '}', '[', ']', ',', ':']);

/** Lex a string literal starting at `i` (which holds the quote char). */
function lexString(expr: string, i: number): Token {
  const quote = expr[i];
  let k = i + 1;
  let hasEscape = false;
  if (quote === '`') {
    // Raw string: no escapes, ends at the next backtick.
    const close = expr.indexOf('`', k);
    if (close === -1) throw new PromQLRewriteError('Unterminated string literal in expression');
    return { kind: 'string', text: expr.slice(i, close + 1), start: i, end: close + 1, value: expr.slice(k, close) };
  }
  while (k < expr.length) {
    const ch = expr[k];
    if (ch === '\\') {
      if (k + 1 >= expr.length) break;
      hasEscape = true;
      k += 2;
      continue;
    }
    if (ch === '\n') break; // interpreted strings can't span lines
    if (ch === quote) {
      return {
        kind: 'string',
        text: expr.slice(i, k + 1),
        start: i,
        end: k + 1,
        value: hasEscape ? null : expr.slice(i + 1, k),
      };
    }
    k++;
  }
  throw new PromQLRewriteError('Unterminated string literal in expression');
}

/** Tokenize a PromQL expression. Throws PromQLRewriteError on anything it can't lex. */
export function tokenize(expr: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (WHITESPACE.test(c)) { i++; continue; }
    if (c === '#') throw new PromQLRewriteError('Comments (#) are not allowed in alert-rule expressions');
    if (c === '"' || c === "'" || c === '`') {
      const t = lexString(expr, i);
      out.push(t);
      i = t.end;
      continue;
    }
    // Numbers / durations / hex (`5m`, `1h30m`, `0.95`, `1e3`, `0x1f`, `.5`).
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(expr[i + 1] ?? ''))) {
      let k = i + 1;
      while (k < expr.length) {
        const ch = expr[k];
        if (NUMBER_PART.test(ch)) { k++; continue; }
        // Signed exponent: `1e-3`, `2E+5`.
        if ((ch === '+' || ch === '-') && /[eE]/.test(expr[k - 1]) && !/^0[xX]/.test(expr.slice(i, k))) { k++; continue; }
        break;
      }
      out.push({ kind: 'number', text: expr.slice(i, k), start: i, end: k });
      i = k;
      continue;
    }
    if (IDENT_START.test(c)) {
      let k = i + 1;
      while (k < expr.length && IDENT_PART.test(expr[k])) k++;
      out.push({ kind: 'ident', text: expr.slice(i, k), start: i, end: k });
      i = k;
      continue;
    }
    const op = OPERATORS.find((o) => expr.startsWith(o, i));
    if (op) {
      out.push({ kind: 'op', text: op, start: i, end: i + op.length });
      i += op.length;
      continue;
    }
    if (PUNCT.has(c)) {
      out.push({ kind: 'punct', text: c, start: i, end: i + 1 });
      i++;
      continue;
    }
    throw new PromQLRewriteError(`Unexpected character ${JSON.stringify(c)} at position ${i}`);
  }
  return out;
}

interface Matcher {
  name: string | null; // null = the label name used escapes we don't decode
  op: string;
  value: string | null;
}

interface Selector {
  /** Metric name, or '' for a nameless `{…}` selector. */
  name: string;
  /** Offset of the `{`, or null for a bare metric without a label-set. */
  open: number | null;
  /** Offset just past the metric identifier (where a bare metric's `{…}` goes). */
  identEnd: number;
  /** True when the label-set holds no elements. */
  emptyLabelset: boolean;
  matchers: Matcher[];
}

function isTok(t: Token | undefined, text: string): boolean {
  return !!t && (t.kind === 'punct' || t.kind === 'op') && t.text === text;
}

/**
 * Parse the label-set whose `{` is at token index `i`. Returns the matchers
 * and the token index just past the closing `}`. A bare quoted string element
 * (Prometheus 3 `{"metric.name", …}`) is accepted as a name element.
 */
function parseLabelset(tokens: Token[], i: number): { matchers: Matcher[]; next: number; empty: boolean } {
  const matchers: Matcher[] = [];
  let k = i + 1;
  let elements = 0;
  for (;;) {
    const t = tokens[k];
    if (!t) throw new PromQLRewriteError('Unbalanced `{` / `}` in expression');
    if (isTok(t, '}')) return { matchers, next: k + 1, empty: elements === 0 };
    if (t.kind !== 'ident' && t.kind !== 'string') {
      throw new PromQLRewriteError(`Malformed label matcher near position ${t.start}`);
    }
    const nameTok = t;
    const opTok = tokens[k + 1];
    if (nameTok.kind === 'string' && (isTok(opTok, ',') || isTok(opTok, '}'))) {
      // Quoted metric-name element.
      elements++;
      k += isTok(opTok, ',') ? 2 : 1;
      continue;
    }
    if (!opTok || opTok.kind !== 'op' || !MATCH_OPS.has(opTok.text)) {
      throw new PromQLRewriteError(`Malformed label matcher near position ${nameTok.start}`);
    }
    const valTok = tokens[k + 2];
    if (!valTok || valTok.kind !== 'string') {
      throw new PromQLRewriteError(`Label matcher value must be a string literal near position ${opTok.start}`);
    }
    matchers.push({
      name: nameTok.kind === 'ident' ? nameTok.text : (nameTok.value ?? null),
      op: opTok.text,
      value: valTok.value ?? null,
    });
    elements++;
    k += 3;
    const sep = tokens[k];
    if (isTok(sep, ',')) { k++; continue; }
    if (isTok(sep, '}')) continue;
    throw new PromQLRewriteError('Unbalanced `{` / `}` in expression');
  }
}

/** Find every metric selector in the expression. */
function findSelectors(expr: string): Selector[] {
  const tokens = tokenize(expr);
  const out: Selector[] = [];
  let bracketDepth = 0;
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];

    if (isTok(t, '[')) { bracketDepth++; i++; continue; }
    if (isTok(t, ']')) { bracketDepth = Math.max(0, bracketDepth - 1); i++; continue; }
    if (isTok(t, '}')) throw new PromQLRewriteError('Unbalanced `{` / `}` in expression');

    // Nameless selector: `{job="x"}`, `{__name__=~"…"}`.
    if (isTok(t, '{')) {
      const ls = parseLabelset(tokens, i);
      out.push({ name: '', open: t.start, identEnd: t.start, emptyLabelset: ls.empty, matchers: ls.matchers });
      i = ls.next;
      continue;
    }

    if (t.kind !== 'ident' || bracketDepth > 0) { i++; continue; }

    const lower = t.text.toLowerCase();
    const next = tokens[i + 1];

    if (LABEL_LIST_KEYWORDS.has(lower)) {
      // Skip the label-name list `(a, b)` that may follow.
      if (isTok(next, '(')) {
        let k = i + 2;
        while (k < tokens.length && !isTok(tokens[k], ')')) {
          if (tokens[k].kind !== 'ident' && tokens[k].kind !== 'string' && !isTok(tokens[k], ',')) {
            throw new PromQLRewriteError(`Malformed label list after "${t.text}"`);
          }
          k++;
        }
        if (k >= tokens.length) throw new PromQLRewriteError(`Unbalanced parentheses after "${t.text}"`);
        i = k + 1;
      } else {
        i++;
      }
      continue;
    }
    if (KEYWORDS.has(lower)) { i++; continue; }
    // `@ start()` / `@ end()` and every other call: a function name, not a metric.
    if (isTok(next, '(')) { i++; continue; }

    if (isTok(next, '{')) {
      const ls = parseLabelset(tokens, i + 1);
      out.push({ name: t.text, open: next.start, identEnd: t.end, emptyLabelset: ls.empty, matchers: ls.matchers });
      i = ls.next;
      continue;
    }

    out.push({ name: t.text, open: null, identEnd: t.end, emptyLabelset: true, matchers: [] });
    i++;
  }
  return out;
}

const ORG_ID_RE = /^[A-Za-z0-9_.:-]+$/;

function assertOrgId(orgId: string): void {
  if (!ORG_ID_RE.test(orgId)) throw new PromQLRewriteError('Invalid organization id for PromQL scoping');
}

/** True when the selector already carries the exact `org_id="<orgId>"` equality matcher. */
function isPinned(sel: Selector, orgId: string): boolean {
  return sel.matchers.some((m) => m.name === 'org_id' && m.op === '=' && m.value === orgId);
}

/** An `org_id="<other>"` equality is an explicit cross-tenant reference — refuse it loudly. */
function assertNoForeignOrg(sel: Selector, orgId: string): void {
  for (const m of sel.matchers) {
    if (m.name === 'org_id' && m.op === '=' && m.value !== null && m.value !== orgId) {
      throw new PromQLRewriteError(
        `expression references org_id="${m.value}" which doesn't match the rule's own org ("${orgId}")`,
      );
    }
  }
}

/**
 * Inject `org_id="<orgId>"` into every metric selector. Operators write
 * `rate(http_requests_total[5m])` and the rule stored in the DB becomes
 * `rate(http_requests_total{org_id="org-acme"}[5m])`. Existing matchers are
 * kept and ANDed with the injected one; only a selector that already carries
 * the exact equality matcher is left alone (idempotent).
 *
 * Throws PromQLRewriteError on malformed expressions (unlexable input,
 * unbalanced braces, unterminated strings, malformed matchers) and on
 * explicit cross-tenant references (`org_id="org-other"`).
 */
export function injectOrgId(expr: string, orgId: string): string {
  assertOrgId(orgId);
  const selectors = findSelectors(expr);
  const matcher = `org_id="${orgId}"`;

  // Walk back-to-front so earlier offsets don't shift.
  let out = expr;
  for (const sel of [...selectors].reverse()) {
    assertNoForeignOrg(sel, orgId);
    if (isPinned(sel, orgId)) continue;
    if (sel.open === null) {
      out = out.slice(0, sel.identEnd) + `{${matcher}}` + out.slice(sel.identEnd);
    } else {
      const insert = sel.emptyLabelset ? matcher : `${matcher},`;
      out = out.slice(0, sel.open + 1) + insert + out.slice(sel.open + 1);
    }
  }
  return out;
}

/**
 * Validation-only mode: ok=true iff every metric selector carries the exact
 * `org_id="<orgId>"` equality matcher. Regex / negative forms never count —
 * `injectOrgId` (which runs first on every write path) adds the equality.
 */
export function validateOrgIdMatchers(expr: string, orgId: string): { ok: true } | { ok: false; message: string } {
  try {
    assertOrgId(orgId);
    for (const sel of findSelectors(expr)) {
      assertNoForeignOrg(sel, orgId);
      if (!isPinned(sel, orgId)) {
        const what = sel.name ? `metric "${sel.name}"` : 'label-set selector {…}';
        return { ok: false, message: `${what} needs an org_id="${orgId}" matcher to scope it to your org` };
      }
    }
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
  return { ok: true };
}
