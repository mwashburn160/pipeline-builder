// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { hasTemplate, tokenize, type Token } from './tokenizer.js';

export interface WalkEntry {
  /** Dotted path to the field inside the document, e.g. 'commands[3]' or 'env.STAGE' */
  field: string;
  /** Raw source string containing template tokens */
  source: string;
  /** Parsed token stream */
  tokens: Token[];
  /** Setter to write back a resolved value into the original `root` object */
  set: (value: unknown) => void;
}

export type FieldPredicate = (field: string) => boolean;

/**
 * Visit every templatable string leaf under `root`. Calls `handler(field, source)`
 * for each string whose field path satisfies `isTemplatable` and contains `{{`.
 * Does NOT tokenize — callers decide whether to throw or collect errors.
 */
export function visitStrings(
  root: unknown,
  isTemplatable: FieldPredicate,
  handler: (field: string, source: string, keyPath: Array<string | number>) => void,
): void {
  step(root, '', [], isTemplatable, handler);
}

function step(
  node: unknown,
  field: string,
  keyPath: Array<string | number>,
  isTemplatable: FieldPredicate,
  handler: (field: string, source: string, keyPath: Array<string | number>) => void,
): void {
  if (Array.isArray(node)) {
    node.forEach((child, idx) => step(child, `${field}[${idx}]`, [...keyPath, idx], isTemplatable, handler));
    return;
  }
  if (node !== null && typeof node === 'object') {
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      step(child, field ? `${field}.${key}` : key, [...keyPath, key], isTemplatable, handler);
    }
    return;
  }
  if (typeof node === 'string' && isTemplatable(field) && hasTemplate(node)) {
    handler(field, node, keyPath);
  }
}

/**
 * Walk all templatable string fields under `root`, returning one entry per
 * templated field with a bound `set()` that mutates `root` in place.
 * Tokenization happens eagerly here — parse errors throw.
 *
 * By default only fields containing at least one `{{ expr }}` are returned.
 * Pass `includeLiteralOnly` to also return fields whose only template content
 * is a `{{{{` escape sequence — these still need rewriting so the tokenizer's
 * `{{{{` → `{{` unescape actually materializes into the document.
 *
 * The bound `set()` writes back via the exact key path captured during the
 * walk (the real `Object.entries` keys), so document keys containing `.`,
 * `[`, or `]` (e.g. `env["FOO.BAR"]`) are written correctly rather than being
 * silently dropped by re-parsing a flattened dotted field string.
 */
export function walkAndBind<T extends object>(
  root: T,
  isTemplatable: FieldPredicate,
  includeLiteralOnly = false,
): WalkEntry[] {
  const entries: WalkEntry[] = [];
  visitStrings(root, isTemplatable, (field, source, keyPath) => {
    const tokens = tokenize(source);
    if (!includeLiteralOnly && !tokens.some(t => t.kind === 'expr')) return;
    entries.push({
      field,
      source,
      tokens,
      set: (value: unknown) => writeField(root, keyPath, value),
    });
  });
  return entries;
}

function writeField(root: unknown, parts: Array<string | number>, value: unknown): void {
  if (parts.length === 0) return;
  let cur: unknown = root;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur == null || typeof cur !== 'object') return;
    cur = (cur as Record<string | number, unknown>)[parts[i]!];
  }
  if (cur == null || typeof cur !== 'object') return;
  (cur as Record<string | number, unknown>)[parts[parts.length - 1]!] = value;
}
