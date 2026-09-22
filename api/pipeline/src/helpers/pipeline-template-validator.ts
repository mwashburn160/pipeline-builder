// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { ValidationError } from '@pipeline-builder/api-core';
import {
  validateTemplates,
  detectCycles,
  allowedScopeRoots,
  pipelineScopeMetadata,
  resolveSelfReferencing,
} from '@pipeline-builder/pipeline-core';

/**
 * Scope roots available inside pipeline.json self-references.
 *  - `metadata.*` — references to other metadata keys
 *  - `vars.*` — references to variables
 */
const PIPELINE_SELF_SCOPE = ['metadata', 'vars'];

const isPipelineTemplatable = (field: string): boolean => {
  // Templatable: `project` (top-level string), metadata.* values, vars.* values.
  // `project` is the props key every writer emits and the only name accepted.
  if (field === 'project') return true;
  if (field.startsWith('metadata.') || field.startsWith('metadata[')) return true;
  if (field.startsWith('vars.') || field.startsWith('vars[')) return true;
  return false;
};

const isPipelineKnownPath = allowedScopeRoots(PIPELINE_SELF_SCOPE);

/**
 * Each templatable pipeline field writes to the same scope path it occupies.
 * `metadata.env` writes scope `metadata.env`; `vars.branch` writes scope `vars.branch`.
 */
function fieldToScopePath(field: string): string | null {
  if (field === 'project') return field;
  if (field.startsWith('metadata.') || field.startsWith('metadata[')) return field;
  if (field.startsWith('vars.') || field.startsWith('vars[')) return field;
  return null;
}

/**
 * The only shape this validator needs: the three templatable fields, plus the
 * `props` nesting that create/update bodies and DB rows use.
 *
 * Every member is `unknown` and OPTIONAL on purpose. The callers are Zod-
 * validated request bodies and Drizzle rows, whose concrete types declare
 * `project: string`, `metadata: Record<string, string>` and so on. Naming those
 * types here would force every call site through `as unknown as PipelineLike`,
 * and a cast through `unknown` accepts a body that has NONE of these fields, so
 * a schema rename would compile and validate nothing. Declared this way, the
 * bodies satisfy it structurally with no casts, so a rename breaks the build
 * instead. The narrowing that the validator actually depends on
 * happens below, where each field is read.
 */
export interface PipelineLike {
  project?: unknown;
  /** Pipeline metadata, layered as synth merges it (see `pipelineScopeMetadata`). */
  global?: unknown;
  defaults?: unknown;
  synth?: unknown;
  vars?: unknown;
  /** Create/update bodies + DB rows nest the templatable fields here (BuilderProps). */
  props?: PipelineLike;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
}

/**
 * The templatable view of a pipeline: `project`, `vars`, and `metadata` AS SYNTH
 * SEES IT — `global` ← `defaults.metadata` ← `synth.metadata` (last wins), the
 * one shared definition in pipeline-core. BuilderProps has no `metadata` field,
 * so reading one validated nothing.
 */
function templatableView(src: PipelineLike): { project: unknown; metadata: Record<string, unknown>; vars: unknown } {
  return { project: src.project, metadata: { ...pipelineScopeMetadata(src) }, vars: src.vars };
}

/**
 * Validate `{{ ... }}` tokens in a pipeline document. Throws `ValidationError`
 * on any problem. Called at pipeline create/update time.
 */
export function validatePipelineTemplates(pipeline: PipelineLike): void {
  // The create/update body and DB rows nest the templatable fields under `props`
  // (BuilderProps) — without descending into it, validation reads undefined and
  // silently passes every document. Fall back to the top level for callers that
  // pass the props object directly.
  const doc = templatableView(pipeline.props ?? pipeline);

  // Shape check (parse errors, unknown roots, reserved secrets.*)
  const { valid, errors } = validateTemplates(doc, isPipelineTemplatable, isPipelineKnownPath);
  if (!valid) {
    throw new ValidationError(
      `Pipeline template validation failed (${errors.length} error${errors.length === 1 ? '' : 's'}):\n` +
      errors.map(e => `  • [${e.field}${e.line ? `:${e.line}:${e.col}` : ''}] ${e.message}`).join('\n'),
    );
  }

  // Cycle detection on self-references
  const cycleErrors = detectCycles(doc, isPipelineTemplatable, fieldToScopePath);
  if (cycleErrors.length) {
    throw new ValidationError(
      'Pipeline has circular template references:\n' +
      cycleErrors.map(e => `  • ${e.message}`).join('\n'),
    );
  }
}

/**
 * Apply pass-1 resolution to a pipeline in place. Mutates and returns
 * the same object. Errors on unresolved paths or cycles.
 */
export function resolvePipeline<T extends PipelineLike>(pipeline: T): T {
  // Resolve against `props` when present (that's where the fields live).
  const target = (pipeline.props ?? pipeline) as PipelineLike;
  const doc = templatableView(target);
  const vars = asRecord(doc.vars) ?? {};
  const scope = { metadata: doc.metadata, vars };
  const { errors } = resolveSelfReferencing(
    doc as unknown as Record<string, unknown>,
    scope,
    isPipelineTemplatable,
    fieldToScopePath,
  );
  if (errors.length) {
    throw new ValidationError(
      'Pipeline resolution failed:\n' +
      errors.map(e => `  • [${e.field ?? '?'}] ${e.message}`).join('\n'),
    );
  }

  // Write back. `vars` was resolved in place. Each metadata key is written to
  // the layer synth takes it from (the last one that sets it), so an
  // overridden lower-layer value is left as the author wrote it.
  const writable = target as Record<string, unknown>;
  if (typeof doc.project === 'string') writable.project = doc.project;
  const layers = [
    asRecord(asRecord(target.synth)?.metadata),
    asRecord(asRecord(target.defaults)?.metadata),
    asRecord(target.global),
  ];
  for (const [key, value] of Object.entries(doc.metadata)) {
    const owner = layers.find((layer) => layer && Object.prototype.hasOwnProperty.call(layer, key));
    if (owner) owner[key] = value;
  }
  return pipeline;
}
