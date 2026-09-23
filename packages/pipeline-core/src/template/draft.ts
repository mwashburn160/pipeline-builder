// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Service-side validation of a DRAFTED pipeline template — the one entry point
 * a caller needs to ask "would this template survive being created and then
 * instantiated?" before it is offered to anyone.
 *
 * It exists because a drafted template (the ask agent's `propose_template`, a
 * CLI-authored file, an import) is otherwise checked only against a shape
 * schema. A shape schema cannot see that `{{ vars.REGION }}` is referenced but
 * never declared in `inputs`, or that two metadata values reference each other
 * in a cycle: both are accepted at create time and only fail later, at synth,
 * far from whoever wrote them.
 *
 * What it reports:
 *  - `parse`                — malformed `{{ … }}` anywhere in the body, at its line/col.
 *  - `reserved-scope`       — `{{ secrets.* }}`, which the engine reserves.
 *  - `unknown-scope`        — a self-referencing field pointing at a root that is
 *                             neither `metadata` nor `vars`; the pipeline create
 *                             path rejects exactly these.
 *  - `cycle`                — self-references that cannot be ordered.
 *  - `undeclared-variable`  — `{{ vars.X }}` with no matching `inputs[].name` and
 *                             no default in `props.vars`, so instantiation can
 *                             never supply it.
 *  - `duplicate-input` / `invalid-input-name` — an input that cannot be filled:
 *                             a repeated name, or one the grammar cannot express
 *                             as `{{ vars.<name> }}`.
 *  - `unused-input`         — declared but never referenced. A WARNING: the
 *                             template still works, it just asks for something
 *                             it ignores.
 *
 * Errors mean "do not offer this"; warnings mean "say so and let the author
 * decide". `valid` reflects errors only.
 */

import { TokenizerError, tokenize } from './tokenizer.js';
import { detectCycles } from './validate.js';
import { visitStrings } from './walker.js';

/** What went wrong. See the module header for what each kind means. */
export type TemplateDraftProblemKind =
  | 'invalid-props'
  | 'parse'
  | 'reserved-scope'
  | 'unknown-scope'
  | 'cycle'
  | 'undeclared-variable'
  | 'duplicate-input'
  | 'invalid-input-name'
  | 'unused-input';

/** One problem found in a drafted template. */
export interface TemplateDraftProblem {
  readonly kind: TemplateDraftProblemKind;
  /** `error` blocks the draft; `warning` is worth saying but not fatal. */
  readonly severity: 'error' | 'warning';
  readonly message: string;
  /** Dotted path of the offending field inside `props`, when there is one. */
  readonly field?: string;
  readonly line?: number;
  readonly col?: number;
  /** The `{{ path }}` that caused it. */
  readonly path?: string;
  /** For `cycle`: the scope keys forming the loop. */
  readonly cycle?: readonly string[];
  /** For the variable/input kinds: the `vars.<name>` involved. */
  readonly variable?: string;
}

/** One declared input, read defensively — a draft's `inputs` is untrusted. */
export interface TemplateDraftInput {
  readonly name?: unknown;
}

/** The part of a drafted template this validator reads. */
export interface TemplateDraftLike {
  /** The template body: a BuilderProps carrying `{{ vars.* }}` placeholders. */
  readonly props?: unknown;
  /** The declared `vars.*` contract. */
  readonly inputs?: readonly TemplateDraftInput[] | null;
}

/** The verdict on a drafted template. */
export interface TemplateDraftValidation {
  /** True when no problem has `severity: 'error'`. */
  readonly valid: boolean;
  readonly problems: readonly TemplateDraftProblem[];
  /** Every `vars.<name>` the body references, sorted. */
  readonly referencedVariables: readonly string[];
  /** Every well-formed `inputs[].name`, in declaration order. */
  readonly declaredInputs: readonly string[];
}

/** The template grammar's identifier rule (tokenizer.ts): `[a-zA-Z_][a-zA-Z0-9_]{0,63}`. */
const IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;

/** The roots a self-referencing pipeline field may address (same set the pipeline create path allows). */
const SELF_SCOPE_ROOTS = ['metadata', 'vars'];

/** The metadata layers synth merges, in the order it merges them. */
const METADATA_PREFIXES = ['global.', 'defaults.metadata.', 'synth.metadata.'];

/** The first path segment of `rest` — `A.B` and `A[0]` both yield `A`. */
function firstSegment(rest: string): string {
  const match = /^[^.[]+/.exec(rest);
  return match ? match[0] : rest;
}

/**
 * The scope key a templatable field WRITES, or null when the field is not
 * self-referencing. `global.env`, `defaults.metadata.env` and
 * `synth.metadata.env` all write `metadata.env` — that is how synth layers
 * them — so a cycle through any layer is found.
 */
function selfScopeKey(field: string): string | null {
  if (field === 'project') return 'project';
  for (const prefix of METADATA_PREFIXES) {
    if (field.startsWith(prefix)) return `metadata.${firstSegment(field.slice(prefix.length))}`;
  }
  if (field.startsWith('vars.')) return `vars.${firstSegment(field.slice('vars.'.length))}`;
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validate a drafted pipeline template. Never throws: a malformed draft comes
 * back as problems, because the caller's job is to report them, not to crash.
 */
export function validateTemplateDraft(draft: TemplateDraftLike): TemplateDraftValidation {
  const problems: TemplateDraftProblem[] = [];
  const referenced = new Set<string>();

  if (!isRecord(draft.props)) {
    return {
      valid: false,
      problems: [{ kind: 'invalid-props', severity: 'error', message: 'Template body (props) must be an object' }],
      referencedVariables: [],
      declaredInputs: [],
    };
  }
  const props = draft.props;

  // -- Pass 1: every string in the body, so a malformed `{{` is caught wherever
  //    it is — not only in the fields the pipeline create path happens to check.
  let parseFailed = false;
  visitStrings(props, () => true, (field, source) => {
    let tokens;
    try {
      tokens = tokenize(source);
    } catch (err) {
      parseFailed = true;
      const pos = err instanceof TokenizerError ? err.pos : undefined;
      problems.push({
        kind: 'parse',
        severity: 'error',
        message: err instanceof Error ? err.message : String(err),
        field,
        ...(pos && { line: pos.line, col: pos.col }),
      });
      return;
    }
    const selfReferencing = selfScopeKey(field) !== null;
    for (const token of tokens) {
      if (token.kind !== 'expr') continue;
      const root = token.path[0]!;
      const path = token.path.join('.');
      if (root === 'secrets') {
        problems.push({
          kind: 'reserved-scope',
          severity: 'error',
          message: '\'secrets\' is a reserved scope — a template body must not reference it',
          field,
          path,
          line: token.pos.line,
          col: token.pos.col,
        });
        continue;
      }
      if (root === 'vars' && token.path.length > 1) referenced.add(token.path[1]!);
      if (selfReferencing && !SELF_SCOPE_ROOTS.includes(root)) {
        problems.push({
          kind: 'unknown-scope',
          severity: 'error',
          message: `Template references unknown scope root '${root}' (a pipeline field may reference ${SELF_SCOPE_ROOTS.join(' or ')} only)`,
          field,
          path,
          line: token.pos.line,
          col: token.pos.col,
        });
      }
    }
  });

  // -- Pass 2: cycles among the self-referencing fields. Skipped when anything
  //    failed to parse — the cycle walker tokenizes eagerly and would throw on
  //    the same bad field that pass 1 already reported.
  if (!parseFailed) {
    for (const err of detectCycles(props, (field) => selfScopeKey(field) !== null, selfScopeKey)) {
      problems.push({
        kind: 'cycle',
        severity: 'error',
        message: err.message,
        field: err.field,
        ...(err.cycle && { cycle: err.cycle }),
      });
    }
  }

  // -- Pass 3: the declared inputs. An input the grammar cannot express, or one
  //    declared twice, can never be filled in — both are errors, not warnings.
  const declared: string[] = [];
  const seen = new Set<string>();
  for (const input of draft.inputs ?? []) {
    const name = input?.name;
    if (typeof name !== 'string' || !IDENTIFIER.test(name)) {
      problems.push({
        kind: 'invalid-input-name',
        severity: 'error',
        message: `Declared input ${JSON.stringify(name)} is not a usable variable name (${IDENTIFIER.source})`,
        ...(typeof name === 'string' && { variable: name }),
      });
      continue;
    }
    if (seen.has(name)) {
      problems.push({ kind: 'duplicate-input', severity: 'error', message: `Declared input '${name}' appears more than once`, variable: name });
      continue;
    }
    seen.add(name);
    declared.push(name);
  }

  // -- Pass 4: the contract between body and inputs. A var the body references
  //    is supplied either by a declared input or by a default already sitting in
  //    `props.vars`; anything else has no way of ever getting a value.
  const defaulted = isRecord(props.vars) ? Object.keys(props.vars) : [];
  const supplied = new Set([...declared, ...defaulted]);
  for (const variable of [...referenced].sort()) {
    if (supplied.has(variable)) continue;
    problems.push({
      kind: 'undeclared-variable',
      severity: 'error',
      message: `Template references {{ vars.${variable} }} but declares no input named '${variable}'`,
      variable,
    });
  }
  for (const name of declared) {
    if (referenced.has(name)) continue;
    problems.push({
      kind: 'unused-input',
      severity: 'warning',
      message: `Declared input '${name}' is never referenced as {{ vars.${name} }}`,
      variable: name,
    });
  }

  return {
    valid: !problems.some((p) => p.severity === 'error'),
    problems,
    referencedVariables: [...referenced].sort(),
    declaredInputs: declared,
  };
}

/** One readable line per problem, for a tool result or an error body. */
export function formatTemplateDraftProblems(problems: readonly TemplateDraftProblem[]): string[] {
  return problems.map((p) => {
    const where = p.field ? `${p.field}${p.line !== undefined ? `:${p.line}:${p.col}` : ''}` : p.kind;
    return `[${where}] ${p.message}`;
  });
}
