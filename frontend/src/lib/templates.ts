// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Inline validation and live preview for the `{{ path | filter }}` template
 * syntax in user-editable fields (metadata values, commands, env vars).
 *
 * Tokenizing is pipeline-core's own tokenizer (its dependency-free `/template`
 * subpath), so the editor accepts and rejects exactly what synth does — size
 * cap in bytes, identifier length, the `{{{{` escape. Only the preview
 * evaluator lives here: synth resolves against scopes the browser never has
 * (secrets are reserved there), so the UI needs just path lookup, `default`
 * and the coercion filters.
 */

import {
  hasTemplate, tokenize, type CoerceKind, type ExprToken, type SourcePosition, type Token, type TokenizerError,
} from '@pipeline-builder/pipeline-core/template';

export { hasTemplate, tokenize, type SourcePosition, type Token };

// -----------------------------------------------------------------------------
// Evaluation
// -----------------------------------------------------------------------------

export type Scope = Record<string, unknown>;

function lookupPath(scope: Scope, path: string[]): unknown {
  let cur: unknown = scope;
  for (const seg of path) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** Resolve tokens against a scope. Returns the resolved value (string unless
 * a whole-field coercion filter returns a native type). */
export function resolve(tokens: Token[], scope: Scope): unknown {
  if (tokens.length === 1 && tokens[0]!.kind === 'expr' && tokens[0]!.coerce) {
    const t = tokens[0]! as ExprToken;
    return coerce(resolveOne(t, scope), t.coerce!);
  }
  const parts: string[] = [];
  for (const tok of tokens) {
    if (tok.kind === 'literal') { parts.push(tok.value); continue; }
    const v = resolveOne(tok, scope);
    parts.push(typeof v === 'string' ? v : String(v));
  }
  return parts.join('');
}

function resolveOne(tok: ExprToken, scope: Scope): string {
  const v = lookupPath(scope, tok.path);
  if (v == null || v === '') {
    if (tok.defaultValue !== undefined) return tok.defaultValue;
    throw new Error(`Unknown path: ${tok.path.join('.')}`);
  }
  if (typeof v === 'object') throw new Error(`Path resolves to object: ${tok.path.join('.')}`);
  return String(v);
}

function coerce(raw: string, kind: CoerceKind): unknown {
  if (kind === 'number') {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`Not a number: ${raw}`);
    return n;
  }
  if (kind === 'bool') {
    const v = raw.trim().toLowerCase();
    if (v === 'true' || v === '1' || v === 'yes') return true;
    if (v === 'false' || v === '0' || v === 'no' || v === '') return false;
    throw new Error(`Not a bool: ${raw}`);
  }
  return JSON.parse(raw);
}

// -----------------------------------------------------------------------------
// UI helpers
// -----------------------------------------------------------------------------

export interface ValidationResult {
  valid: boolean;
  tokens: Token[];
  error?: string;
  errorPos?: SourcePosition;
}

/** Parse a string and return diagnostic info suitable for inline editor feedback. */
export function validateSource(source: string): ValidationResult {
  if (!hasTemplate(source)) return { valid: true, tokens: [{ kind: 'literal', value: source, pos: { line: 1, col: 1 } }] };
  try {
    return { valid: true, tokens: tokenize(source) };
  } catch (err) {
    const e = err as TokenizerError;
    return { valid: false, tokens: [], error: e.message, errorPos: e.pos };
  }
}

/** Try to resolve a string against a scope; return the resolved text or `null` when undefined. */
export function previewResolve(source: string, scope: Scope): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    if (!hasTemplate(source)) return { ok: true, value: source };
    return { ok: true, value: resolve(tokenize(source), scope) };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
