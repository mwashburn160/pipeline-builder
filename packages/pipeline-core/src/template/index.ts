// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

export {
  tokenize,
  hasTemplate,
  TokenizerError,
  MAX_FIELD_SIZE_BYTES,
  MAX_PATH_DEPTH,
  MAX_IDENTIFIER_LENGTH,
  type Token,
  type LiteralToken,
  type ExprToken,
  type SourcePosition,
} from './tokenizer';

export {
  resolve,
  lookupPath,
  dependencies,
  type Scope,
  type EvalError,
} from './evaluator';

export {
  walkAndBind,
  type WalkEntry,
  type FieldPredicate,
} from './walker';

export {
  topoSort,
  type TopoNode,
  type TopoResult,
} from './topo-sort';

export {
  TokenCache,
  defaultTokenCache,
} from './cache';

export {
  validateTemplates,
  detectCycles,
  allowedScopeRoots,
  type TemplateError,
  type ValidationResult,
} from './validate';

export {
  recordResolution,
  templateResolutionsTotal,
  templateResolutionDurationMs,
} from './metrics';

// -- Convenience: high-level resolve() that walks + resolves + measures

import { ErrorCode } from '@pipeline-builder/api-core';
import { resolve as evaluatorResolve, type Scope } from './evaluator';
import { recordResolution } from './metrics';
import { hasTemplate, tokenize, Token } from './tokenizer';
import { topoSort } from './topo-sort';
import { walkAndBind, type FieldPredicate } from './walker';

export interface ResolveResult {
  errors: Array<{ code: ErrorCode; message: string; field?: string; path?: string }>;
}

/**
 * Resolve all templates inside `doc` by mutating string fields in place.
 * `doc` is treated as opaque — only string fields that match `isTemplatable`
 * are rewritten. Returns collected errors (empty array on success).
 *
 * `docType` is used for metrics; pass 'pipeline' or 'plugin'.
 */
export function resolveTemplates<T extends object>(
  doc: T,
  scope: Scope,
  isTemplatable: FieldPredicate,
  docType: 'pipeline' | 'plugin' = 'plugin',
): ResolveResult {
  const start = Date.now();
  const errors: ResolveResult['errors'] = [];
  const entries = walkAndBind(doc, isTemplatable);
  let success = true;
  for (const entry of entries) {
    try {
      const value = evaluatorResolve(entry.tokens, scope, entry.field);
      entry.set(value);
    } catch (err) {
      success = false;
      const e = err as Error & { code?: ErrorCode; path?: string };
      errors.push({
        code: e.code ?? ErrorCode.TEMPLATE_PARSE_ERROR,
        message: e.message,
        field: entry.field,
        path: e.path,
      });
    }
  }
  recordResolution(docType, Date.now() - start, success);
  return { errors };
}

/**
 * Resolve a self-referencing document (e.g. pipeline.json where
 * metadata fields reference each other). Topologically orders the
 * resolution so dependencies come first. Mutates `doc` in place.
 *
 * `fieldToScopePath` maps each field (e.g. `metadata.env`) to the scope
 * path it populates (typically the same, sans any array indices).
 */
export function resolveSelfReferencing<T extends object>(
  doc: T,
  scope: Scope,
  isTemplatable: FieldPredicate,
  fieldToScopePath: (field: string) => string | null,
  docType: 'pipeline' | 'plugin' = 'pipeline',
): ResolveResult {
  const start = Date.now();
  const entries = walkAndBind(doc, isTemplatable);
  // Build topo nodes keyed by target scope path
  const nodes = entries
    .map(e => {
      const key = fieldToScopePath(e.field);
      if (!key) return null;
      const deps: string[] = [];
      for (const t of e.tokens) if (t.kind === 'expr') deps.push(t.path.join('.'));
      return { key, deps, entry: e };
    })
    .filter((n): n is NonNullable<typeof n> => n !== null);

  const { ordered, cycles } = topoSort(nodes.map(n => ({ key: n.key, deps: n.deps })));
  const errors: ResolveResult['errors'] = [];
  if (cycles.length) {
    for (const c of cycles) {
      errors.push({
        code: ErrorCode.TEMPLATE_CYCLE,
        message: `Template cycle detected: ${c.join(' -> ')}`,
        path: c.join(' -> '),
      });
    }
    recordResolution(docType, Date.now() - start, false);
    return { errors };
  }

  // Resolve in topo order; multiple entries may share a scope key (e.g. one
  // pipeline field could map to the same scope path — unlikely here), so
  // iterate all entries whose key == ordered[i].
  const byKey = new Map<string, typeof nodes>();
  for (const n of nodes) {
    const list = byKey.get(n.key) ?? [];
    list.push(n);
    byKey.set(n.key, list);
  }

  let success = true;
  for (const key of ordered) {
    for (const n of byKey.get(key) ?? []) {
      try {
        const value = evaluatorResolve(n.entry.tokens, scope, n.entry.field);
        n.entry.set(value);
      } catch (err) {
        success = false;
        const e = err as Error & { code?: ErrorCode; path?: string };
        errors.push({
          code: e.code ?? ErrorCode.TEMPLATE_PARSE_ERROR,
          message: e.message,
          field: n.entry.field,
          path: e.path,
        });
      }
    }
  }
  recordResolution(docType, Date.now() - start, success);
  return { errors };
}

/**
 * Inline round-trip helper — parses and resolves a single string against
 * a scope. Returns a string unless a whole-field coercion filter was
 * used (in which case the native type from `| number`, `| bool`, or
 * `| json` is returned).
 */
export function resolveString(
  source: string,
  scope: Scope,
): string | number | boolean | null | unknown[] | Record<string, unknown> {
  if (!hasTemplate(source)) return source;
  const tokens: Token[] = tokenize(source);
  return evaluatorResolve(tokens, scope);
}
