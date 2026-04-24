// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { hasTemplate, tokenize, Token } from './tokenizer';

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
  handler: (field: string, source: string) => void,
): void {
  step(root, '', isTemplatable, handler);
}

function step(
  node: unknown,
  field: string,
  isTemplatable: FieldPredicate,
  handler: (field: string, source: string) => void,
): void {
  if (Array.isArray(node)) {
    node.forEach((child, idx) => step(child, `${field}[${idx}]`, isTemplatable, handler));
    return;
  }
  if (node !== null && typeof node === 'object') {
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      step(child, field ? `${field}.${key}` : key, isTemplatable, handler);
    }
    return;
  }
  if (typeof node === 'string' && isTemplatable(field) && hasTemplate(node)) {
    handler(field, node);
  }
}

/**
 * Walk all templatable string fields under `root`, returning one entry per
 * templated field with a bound `set()` that mutates `root` in place.
 * Tokenization happens eagerly here — parse errors throw.
 */
export function walkAndBind<T extends object>(
  root: T,
  isTemplatable: FieldPredicate,
): WalkEntry[] {
  const entries: WalkEntry[] = [];
  visitStrings(root, isTemplatable, (field, source) => {
    const tokens = tokenize(source);
    if (!tokens.some(t => t.kind === 'expr')) return;
    entries.push({
      field, source, tokens,
      set: (value: unknown) => writeField(root, parseFieldPath(field), value),
    });
  });
  return entries;
}

function parseFieldPath(field: string): Array<string | number> {
  const parts: Array<string | number> = [];
  const re = /([^.\[\]]+)|\[(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(field)) !== null) {
    if (m[1] !== undefined) parts.push(m[1]);
    else if (m[2] !== undefined) parts.push(Number(m[2]));
  }
  return parts;
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
