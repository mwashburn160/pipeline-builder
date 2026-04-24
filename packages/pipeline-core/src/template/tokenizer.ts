// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tokenizer for the pipeline-builder template grammar.
 *
 * Grammar:
 *   Template   := (Literal | Expr)*
 *   Expr       := "{{" ws Path (ws Filter)? ws "}}"
 *   Path       := Identifier ("." Identifier)*
 *   Identifier := [a-zA-Z_][a-zA-Z0-9_]{0,63}
 *   Filter     := "|" ws "default" ws ":" ws Quoted
 *   Quoted     := "'" ... "'" | "\"" ... "\""
 *
 * `{{{{` is the escape sequence for a literal `{{`.
 */

export const MAX_FIELD_SIZE_BYTES = 4 * 1024;
export const MAX_PATH_DEPTH = 5;
export const MAX_IDENTIFIER_LENGTH = 64;

export interface SourcePosition {
  line: number;
  col: number;
}

export interface LiteralToken {
  kind: 'literal';
  value: string;
  pos: SourcePosition;
}

export type CoerceKind = 'number' | 'bool' | 'json';

export interface ExprToken {
  kind: 'expr';
  path: string[]; // e.g. ['pipeline', 'metadata', 'env']
  defaultValue?: string; // value for `| default: '...'` filter
  coerce?: CoerceKind; // `| number`, `| bool`, `| json`
  source: string; // original "{{ ... }}" text (for error messages)
  pos: SourcePosition;
}

export type Token = LiteralToken | ExprToken;

export class TokenizerError extends Error {
  constructor(
    message: string,
    public readonly pos: SourcePosition,
  ) {
    super(`${message} at line ${pos.line}, col ${pos.col}`);
    this.name = 'TokenizerError';
  }
}

/**
 * Tokenize a template source string. Never throws on valid input;
 * throws `TokenizerError` with source position on malformed templates.
 */
export function tokenize(source: string): Token[] {
  if (source.length > MAX_FIELD_SIZE_BYTES) {
    throw new TokenizerError(
      `Field exceeds max size of ${MAX_FIELD_SIZE_BYTES} bytes`,
      { line: 1, col: 1 },
    );
  }

  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let col = 1;
  let literalStart = 0;
  let literalStartPos: SourcePosition = { line: 1, col: 1 };

  const advance = (n: number): void => {
    for (let k = 0; k < n; k++) {
      if (source[i + k] === '\n') {
        line++;
        col = 1;
      } else {
        col++;
      }
    }
    i += n;
  };

  const flushLiteral = (endIdx: number): void => {
    if (endIdx > literalStart) {
      // Unescape `{{{{` → `{{`
      const raw = source.slice(literalStart, endIdx);
      const value = raw.replace(/\{\{\{\{/g, '{{');
      tokens.push({ kind: 'literal', value, pos: literalStartPos });
    }
  };

  const startLiteral = (): void => {
    literalStart = i;
    literalStartPos = { line, col };
  };

  startLiteral();

  while (i < source.length) {
    // Escape: `{{{{` → literal `{{`
    if (source.startsWith('{{{{', i)) {
      advance(4);
      continue;
    }
    // Expression start
    if (source.startsWith('{{', i)) {
      flushLiteral(i);
      const exprPos: SourcePosition = { line, col };
      advance(2);
      const expr = readExpression(source, i, line, col);
      tokens.push({
        kind: 'expr',
        path: expr.path,
        defaultValue: expr.defaultValue,
        coerce: expr.coerce,
        source: source.slice(exprPos.col - 1 === 0 ? i - 2 : (() => { return i - 2; })(), expr.endIdx),
        pos: exprPos,
      });
      advance(expr.endIdx - i);
      startLiteral();
      continue;
    }
    // Stray `}}` outside an expression
    if (source.startsWith('}}', i)) {
      throw new TokenizerError("Unexpected '}}' outside expression", { line, col });
    }
    advance(1);
  }

  flushLiteral(i);
  return tokens;
}

interface ParsedExpr {
  path: string[];
  defaultValue?: string;
  coerce?: CoerceKind;
  endIdx: number;
}

function readExpression(
  source: string,
  startIdx: number,
  startLine: number,
  startCol: number,
): ParsedExpr {
  let i = startIdx;
  let line = startLine;
  let col = startCol;

  const skipWs = (): void => {
    while (i < source.length && (source[i] === ' ' || source[i] === '\t')) {
      i++;
      col++;
    }
  };

  const readIdentifier = (): string => {
    const startI = i;
    if (i >= source.length || !/[a-zA-Z_]/.test(source[i]!)) {
      throw new TokenizerError(
        'Expected identifier inside template expression',
        { line, col },
      );
    }
    while (i < source.length && /[a-zA-Z0-9_]/.test(source[i]!)) {
      i++;
      col++;
    }
    const ident = source.slice(startI, i);
    if (ident.length > MAX_IDENTIFIER_LENGTH) {
      throw new TokenizerError(
        `Identifier exceeds max length of ${MAX_IDENTIFIER_LENGTH}`,
        { line, col: col - ident.length },
      );
    }
    return ident;
  };

  const readQuoted = (): string => {
    const quote = source[i];
    if (quote !== '"' && quote !== "'") {
      throw new TokenizerError('Expected quoted string', { line, col });
    }
    i++; col++;
    const parts: string[] = [];
    while (i < source.length && source[i] !== quote) {
      if (source[i] === '\\') {
        const next = source[i + 1];
        if (next === '\\' || next === quote) {
          parts.push(next);
          i += 2;
          col += 2;
          continue;
        }
        throw new TokenizerError(
          `Invalid escape '\\${next ?? ''}' in quoted string`,
          { line, col },
        );
      }
      if (source[i] === '\n') {
        throw new TokenizerError('Unterminated quoted string', { line, col });
      }
      parts.push(source[i]!);
      i++; col++;
    }
    if (i >= source.length) {
      throw new TokenizerError('Unterminated quoted string', { line, col });
    }
    i++; col++; // consume closing quote
    return parts.join('');
  };

  skipWs();
  const path: string[] = [readIdentifier()];
  while (i < source.length && source[i] === '.') {
    i++; col++;
    path.push(readIdentifier());
    if (path.length > MAX_PATH_DEPTH) {
      throw new TokenizerError(
        `Path depth exceeds max of ${MAX_PATH_DEPTH}`,
        { line, col },
      );
    }
  }
  skipWs();

  let defaultValue: string | undefined;
  let coerce: CoerceKind | undefined;

  // Filters chain: `| default: 'x' | number`, `| bool`, `| json`, etc.
  // - `default` takes a quoted argument — applied first (before coercion)
  // - `number`, `bool`, `json` are argument-less coercion filters — applied last
  while (source[i] === '|') {
    i++; col++;
    skipWs();

    if (source.startsWith('default', i)) {
      if (defaultValue !== undefined) {
        throw new TokenizerError("'default' filter may only appear once", { line, col });
      }
      i += 'default'.length;
      col += 'default'.length;
      skipWs();
      if (source[i] !== ':') {
        throw new TokenizerError("Expected ':' after 'default'", { line, col });
      }
      i++; col++;
      skipWs();
      defaultValue = readQuoted();
      skipWs();
      continue;
    }

    let matchedCoerce: CoerceKind | null = null;
    for (const kind of ['number', 'bool', 'json'] as const) {
      if (source.startsWith(kind, i)) {
        // Ensure identifier boundary — `numberish` must not match `number`
        const next = source[i + kind.length];
        if (!next || !/[a-zA-Z0-9_]/.test(next)) {
          matchedCoerce = kind;
          i += kind.length;
          col += kind.length;
          break;
        }
      }
    }

    if (!matchedCoerce) {
      throw new TokenizerError(
        "Unknown filter — supported: 'default', 'number', 'bool', 'json'",
        { line, col },
      );
    }
    if (coerce) {
      throw new TokenizerError('Only one coercion filter is allowed per expression', { line, col });
    }
    coerce = matchedCoerce;
    skipWs();
  }

  if (!source.startsWith('}}', i)) {
    throw new TokenizerError("Expected '}}'", { line, col });
  }
  i += 2;
  return { path, defaultValue, coerce, endIdx: i };
}

/**
 * Convenience: returns true if the source contains any templates.
 * Used as a fast-path to skip tokenization for strings that are obviously literal.
 */
export function hasTemplate(source: string): boolean {
  // Not completely accurate (a lone `{{{{` would return true) but that's fine —
  // tokenize() will produce a literal-only token list and round-trip correctly.
  return source.includes('{{');
}
