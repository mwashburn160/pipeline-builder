// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { ErrorCode } from '@pipeline-builder/api-core';
import { CoerceKind, SourcePosition, Token } from './tokenizer';

export type Scope = Record<string, unknown>;

export interface EvalError {
  code: ErrorCode;
  message: string;
  field?: string;
  path?: string;
  pos?: SourcePosition;
}

const RESERVED_ROOT_PATHS = new Set(['secrets']);

/**
 * Look up a dot-separated path inside a scope object. Returns `undefined`
 * if any intermediate segment is missing or not an object.
 */
export function lookupPath(scope: Scope, path: string[]): unknown {
  let cur: unknown = scope;
  for (const segment of path) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[segment];
  }
  return cur;
}

/**
 * Resolve a token stream against a scope. Returns the resolved string.
 * Throws `EvalError` when an unresolved path has no default filter.
 *
 * Coercion filters (`| number`, `| bool`, `| json`) only take effect
 * when the template expression is the entire field — e.g.
 * `replicas: "{{ vars.count | number }}"` yields `3` (number) while
 * `replicas: "count={{ vars.count | number }}"` yields `"count=3"`
 * (string, because the template is embedded in surrounding literals).
 * Mixed-literal fields always return a string.
 */
export function resolve(
  tokens: Token[],
  scope: Scope,
  field?: string,
): string | number | boolean | null | unknown[] | Record<string, unknown> {
  // Whole-field coercion shortcut: only apply coercion when the entire field
  // is a single expression (no surrounding literal text).
  if (tokens.length === 1 && tokens[0]!.kind === 'expr' && tokens[0]!.coerce) {
    const tok = tokens[0]! as Extract<Token, { kind: 'expr' }>;
    const raw = resolveOne(tok, scope, field);
    return applyCoercion(raw, tok.coerce!, tok, field);
  }

  const parts: string[] = [];
  for (const tok of tokens) {
    if (tok.kind === 'literal') {
      parts.push(tok.value);
      continue;
    }
    const raw = resolveOne(tok, scope, field);
    parts.push(typeof raw === 'string' ? raw : String(raw));
  }
  return parts.join('');
}

/** Resolve a single expression token to its string form (no coercion). */
function resolveOne(tok: Extract<Token, { kind: 'expr' }>, scope: Scope, field?: string): string {
  const root = tok.path[0]!;
  if (RESERVED_ROOT_PATHS.has(root)) {
    throw makeEvalError({
      code: ErrorCode.TEMPLATE_SECRETS_RESERVED,
      message: `'${root}' is a reserved scope — use the plugin's 'secrets:' field instead`,
      field,
      path: tok.path.join('.'),
      pos: tok.pos,
    });
  }
  const value = lookupPath(scope, tok.path);
  if (value == null || value === '') {
    if (tok.defaultValue !== undefined) return tok.defaultValue;
    throw makeEvalError({
      code: ErrorCode.TEMPLATE_UNKNOWN_PATH,
      message: `Template references unknown path '${tok.path.join('.')}' and no default provided`,
      field,
      path: tok.path.join('.'),
      pos: tok.pos,
    });
  }
  if (typeof value === 'object') {
    throw makeEvalError({
      code: ErrorCode.TEMPLATE_TYPE_MISMATCH,
      message: `Template path '${tok.path.join('.')}' resolved to an object; only strings/numbers/booleans are interpolatable`,
      field,
      path: tok.path.join('.'),
      pos: tok.pos,
    });
  }
  return String(value);
}

/** Apply a whole-field coercion filter to a resolved string value. */
function applyCoercion(
  raw: string,
  kind: CoerceKind,
  tok: Extract<Token, { kind: 'expr' }>,
  field?: string,
): number | boolean | null | string | unknown[] | Record<string, unknown> {
  switch (kind) {
    case 'number': {
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        throw makeEvalError({
          code: ErrorCode.TEMPLATE_TYPE_MISMATCH,
          message: `'${raw}' cannot be coerced to number at path '${tok.path.join('.')}'`,
          field,
          path: tok.path.join('.'),
          pos: tok.pos,
        });
      }
      return n;
    }
    case 'bool': {
      const v = raw.trim().toLowerCase();
      if (v === 'true' || v === '1' || v === 'yes') return true;
      if (v === 'false' || v === '0' || v === 'no' || v === '') return false;
      throw makeEvalError({
        code: ErrorCode.TEMPLATE_TYPE_MISMATCH,
        message: `'${raw}' cannot be coerced to bool at path '${tok.path.join('.')}'`,
        field,
        path: tok.path.join('.'),
        pos: tok.pos,
      });
    }
    case 'json': {
      try {
        return JSON.parse(raw) as string | number | boolean | null | unknown[] | Record<string, unknown>;
      } catch (err) {
        throw makeEvalError({
          code: ErrorCode.TEMPLATE_TYPE_MISMATCH,
          message: `'${raw}' is not valid JSON at path '${tok.path.join('.')}': ${(err as Error).message}`,
          field,
          path: tok.path.join('.'),
          pos: tok.pos,
        });
      }
    }
  }
}

/**
 * Extract dependency paths from a token stream. Used by the topological
 * sort pass to order resolution of self-referencing documents.
 */
export function dependencies(tokens: Token[]): string[] {
  const out: string[] = [];
  for (const tok of tokens) {
    if (tok.kind === 'expr') out.push(tok.path.join('.'));
  }
  return out;
}

function makeEvalError(e: EvalError): Error & EvalError {
  const err = new Error(e.message) as Error & EvalError;
  err.name = 'TemplateEvalError';
  err.code = e.code;
  err.field = e.field;
  err.path = e.path;
  err.pos = e.pos;
  return err;
}
