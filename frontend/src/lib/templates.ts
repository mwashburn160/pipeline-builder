// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Browser-safe tokenizer / evaluator for the `{{ path | filter }}` template
 * syntax. Mirrors `@pipeline-builder/pipeline-core/src/template/*` but without
 * the CDK / Node dependencies so it can be imported from the React bundle.
 *
 * Supports:
 *   - Path lookup:    {{ pipeline.metadata.env }}
 *   - Default filter: {{ x | default: 'y' }}
 *   - Coercion:       {{ x | number }}, {{ x | bool }}, {{ x | json }}
 *   - Escape `{{`:    {{{{ literal }}}}
 *
 * Used by UI components that need to highlight or preview template tokens
 * inside user-editable fields (metadata values, commands, env vars).
 */

export interface Position { line: number; col: number; }
export type CoerceKind = 'number' | 'bool' | 'json';

export interface LiteralToken { kind: 'literal'; value: string; pos: Position; }
export interface ExprToken {
  kind: 'expr';
  path: string[];
  defaultValue?: string;
  coerce?: CoerceKind;
  source: string;
  pos: Position;
}
export type Token = LiteralToken | ExprToken;

export class TokenizeError extends Error {
  constructor(message: string, public readonly pos: Position) {
    super(`${message} at line ${pos.line}, col ${pos.col}`);
    this.name = 'TokenizeError';
  }
}

export const MAX_FIELD_SIZE = 4 * 1024;
export const MAX_PATH_DEPTH = 5;

export function hasTemplate(source: string): boolean {
  return source.includes('{{');
}

/** Tokenize a template source string. Throws TokenizeError on malformed input. */
export function tokenize(source: string): Token[] {
  if (source.length > MAX_FIELD_SIZE) {
    throw new TokenizeError(`Field exceeds ${MAX_FIELD_SIZE} bytes`, { line: 1, col: 1 });
  }
  const tokens: Token[] = [];
  let i = 0, line = 1, col = 1;
  let litStart = 0, litStartPos: Position = { line: 1, col: 1 };

  const advance = (n: number) => {
    for (let k = 0; k < n; k++) {
      if (source[i + k] === '\n') { line++; col = 1; } else col++;
    }
    i += n;
  };
  const flush = (end: number) => {
    if (end > litStart) {
      const raw = source.slice(litStart, end).replace(/\{\{\{\{/g, '{{');
      tokens.push({ kind: 'literal', value: raw, pos: litStartPos });
    }
  };
  const startLit = () => { litStart = i; litStartPos = { line, col }; };
  startLit();

  while (i < source.length) {
    if (source.startsWith('{{{{', i)) { advance(4); continue; }
    if (source.startsWith('{{', i)) {
      flush(i);
      const exprPos: Position = { line, col };
      advance(2);
      const expr = readExpr(source, i, line, col);
      tokens.push({
        kind: 'expr',
        path: expr.path,
        defaultValue: expr.defaultValue,
        coerce: expr.coerce,
        source: source.slice(exprPos.col - 1 === 0 ? i - 2 : i - 2, expr.endIdx),
        pos: exprPos,
      });
      advance(expr.endIdx - i);
      startLit();
      continue;
    }
    if (source.startsWith('}}', i)) {
      throw new TokenizeError("Unexpected '}}' outside expression", { line, col });
    }
    advance(1);
  }
  flush(i);
  return tokens;
}

interface ParsedExpr { path: string[]; defaultValue?: string; coerce?: CoerceKind; endIdx: number; }

function readExpr(src: string, start: number, startLine: number, startCol: number): ParsedExpr {
  let i = start, line = startLine, col = startCol;
  const ws = () => { while (i < src.length && (src[i] === ' ' || src[i] === '\t')) { i++; col++; } };
  const ident = () => {
    if (i >= src.length || !/[a-zA-Z_]/.test(src[i]!)) {
      throw new TokenizeError('Expected identifier', { line, col });
    }
    const s = i;
    while (i < src.length && /[a-zA-Z0-9_]/.test(src[i]!)) { i++; col++; }
    return src.slice(s, i);
  };
  const quoted = () => {
    const q = src[i];
    if (q !== '"' && q !== "'") throw new TokenizeError('Expected quoted string', { line, col });
    i++; col++;
    const parts: string[] = [];
    while (i < src.length && src[i] !== q) {
      if (src[i] === '\\') {
        const n = src[i + 1];
        if (n === '\\' || n === q) { parts.push(n); i += 2; col += 2; continue; }
        throw new TokenizeError(`Invalid escape`, { line, col });
      }
      if (src[i] === '\n') throw new TokenizeError('Unterminated string', { line, col });
      parts.push(src[i]!); i++; col++;
    }
    if (i >= src.length) throw new TokenizeError('Unterminated string', { line, col });
    i++; col++;
    return parts.join('');
  };

  ws();
  const path: string[] = [ident()];
  while (src[i] === '.') {
    i++; col++;
    path.push(ident());
    if (path.length > MAX_PATH_DEPTH) throw new TokenizeError(`Path depth > ${MAX_PATH_DEPTH}`, { line, col });
  }
  ws();

  let defaultValue: string | undefined;
  let coerce: CoerceKind | undefined;
  while (src[i] === '|') {
    i++; col++; ws();
    if (src.startsWith('default', i)) {
      if (defaultValue !== undefined) throw new TokenizeError("'default' only once", { line, col });
      i += 7; col += 7; ws();
      if (src[i] !== ':') throw new TokenizeError(`Expected ':'`, { line, col });
      i++; col++; ws();
      defaultValue = quoted();
      ws();
      continue;
    }
    let matched: CoerceKind | null = null;
    for (const k of ['number', 'bool', 'json'] as const) {
      if (src.startsWith(k, i)) {
        const next = src[i + k.length];
        if (!next || !/[a-zA-Z0-9_]/.test(next)) { matched = k; i += k.length; col += k.length; break; }
      }
    }
    if (!matched) throw new TokenizeError(`Unknown filter`, { line, col });
    if (coerce) throw new TokenizeError(`Only one coercion allowed`, { line, col });
    coerce = matched;
    ws();
  }

  if (!src.startsWith('}}', i)) throw new TokenizeError(`Expected '}}'`, { line, col });
  i += 2;
  return { path, defaultValue, coerce, endIdx: i };
}

// -----------------------------------------------------------------------------
// Evaluation (mirror of server-side, without secrets-reserved check since
// UI never constructs server scopes — secrets path would never resolve).
// -----------------------------------------------------------------------------

export type Scope = Record<string, unknown>;

export function lookupPath(scope: Scope, path: string[]): unknown {
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
  errorPos?: Position;
}

/** Parse a string and return diagnostic info suitable for inline editor feedback. */
export function validateSource(source: string): ValidationResult {
  if (!hasTemplate(source)) return { valid: true, tokens: [{ kind: 'literal', value: source, pos: { line: 1, col: 1 } }] };
  try {
    return { valid: true, tokens: tokenize(source) };
  } catch (err) {
    const e = err as TokenizeError;
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
