// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { ErrorCode } from '@pipeline-builder/api-core';
import { dependencies } from './evaluator';
import { topoSort } from './topo-sort';
import { SourcePosition, Token, TokenizerError, tokenize } from './tokenizer';
import { FieldPredicate, visitStrings, walkAndBind } from './walker';

export interface TemplateError {
  field: string;
  line?: number;
  col?: number;
  code: ErrorCode;
  message: string;
  path?: string;
  cycle?: string[];
}

export interface ValidationResult {
  valid: boolean;
  errors: TemplateError[];
}

/**
 * Build a predicate that accepts a template path when its root is in the
 * given allow-list. Used by the validator to check that every `{{ path }}`
 * resolves to a known scope root (`pipeline`, `plugin`, `env`, …).
 *
 * Only the root segment is checked — we don't enforce exact nested-key
 * existence here because metadata / vars keys are user-provided per pipeline
 * and not known at plugin upload time.
 */
export function allowedScopeRoots(roots: string[]): (path: string[]) => boolean {
  const allowed = new Set(roots);
  return (path) => {
    const root = path[0];
    return !!root && allowed.has(root);
  };
}

/**
 * Validate all template tokens in a document have well-formed paths and
 * point at allowed scope roots. Returns all errors found — does NOT stop
 * on first.
 *
 * Caller supplies `isTemplatable` (the schema allow-list) and
 * `isKnownPath` (the scope-shape predicate). Template text is parsed
 * fresh; use a TokenCache externally if repeated parsing is a concern.
 */
export function validateTemplates<T extends object>(
  doc: T,
  isTemplatable: FieldPredicate,
  isKnownPath: (path: string[]) => boolean,
): ValidationResult {
  const errors: TemplateError[] = [];
  const entries: { field: string; tokens: Token[] }[] = [];

  // Pass 1: parse every templatable field, collecting parse errors instead
  // of throwing on the first one.
  visitStrings(doc, isTemplatable, (field, source) => {
    try {
      entries.push({ field, tokens: tokenize(source) });
    } catch (err) {
      if (err instanceof TokenizerError) {
        errors.push({ field, line: err.pos.line, col: err.pos.col, code: ErrorCode.TEMPLATE_PARSE_ERROR, message: err.message });
      } else {
        errors.push({ field, code: ErrorCode.TEMPLATE_PARSE_ERROR, message: String(err) });
      }
    }
  });

  // Pass 2: validate each expr's path is shape-allowed and not reserved
  for (const { field, tokens } of entries) {
    for (const tok of tokens) {
      if (tok.kind !== 'expr') continue;
      if (tok.path[0] === 'secrets') {
        errors.push(mkErr(field, tok.pos, ErrorCode.TEMPLATE_SECRETS_RESERVED,
          `'secrets' is a reserved scope — use the plugin's 'secrets:' field instead`,
          tok.path.join('.')));
        continue;
      }
      if (!isKnownPath(tok.path)) {
        errors.push(mkErr(field, tok.pos, ErrorCode.TEMPLATE_UNKNOWN_PATH,
          `Template references unknown scope root '${tok.path[0]}'`,
          tok.path.join('.')));
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Detect cycles in a self-referencing document. Caller supplies the
 * templatable predicate and a function to extract the scope-path that
 * each template field writes to (same value used as a key in deps).
 *
 * Example for pipeline.json: the field `metadata.env` writes to scope
 * path `metadata.env`; a template `{{ metadata.region }}` in that field
 * declares a dependency on `metadata.region`.
 */
export function detectCycles<T extends object>(
  doc: T,
  isTemplatable: FieldPredicate,
  fieldToScopePath: (field: string) => string | null,
): TemplateError[] {
  const nodes = [];
  for (const entry of walkAndBind(doc, isTemplatable)) {
    const key = fieldToScopePath(entry.field);
    if (!key) continue;
    nodes.push({ key, deps: dependencies(entry.tokens) });
  }
  const { cycles } = topoSort(nodes);
  return cycles.map(c => ({
    field: c[0]!,
    code: ErrorCode.TEMPLATE_CYCLE,
    message: `Template cycle detected: ${c.join(' -> ')}`,
    cycle: c,
  }));
}

// -- helpers -----------------------------------------------------------------

function mkErr(
  field: string,
  pos: SourcePosition,
  code: ErrorCode,
  message: string,
  path?: string,
): TemplateError {
  return { field, line: pos.line, col: pos.col, code, message, ...(path && { path }) };
}

