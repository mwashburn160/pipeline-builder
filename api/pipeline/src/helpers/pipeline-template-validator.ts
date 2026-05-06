// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { ValidationError } from '@pipeline-builder/api-core';
import {
  validateTemplates,
  detectCycles,
  allowedScopeRoots,
  resolveSelfReferencing,
  tokenize,
} from '@pipeline-builder/pipeline-core';

/**
 * Scope roots available inside pipeline.json self-references.
 *  - `metadata.*` — references to other metadata keys
 *  - `vars.*` — references to variables
 */
const PIPELINE_SELF_SCOPE = ['metadata', 'vars'];

const isPipelineTemplatable = (field: string): boolean => {
  // Templatable: projectName (top-level string), metadata.* values, vars.* values
  if (field === 'projectName') return true;
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
  if (field === 'projectName') return 'projectName';
  if (field.startsWith('metadata.') || field.startsWith('metadata[')) return field;
  if (field.startsWith('vars.') || field.startsWith('vars[')) return field;
  return null;
}

export interface PipelineLike {
  projectName?: string;
  project?: string;
  metadata?: Record<string, unknown>;
  vars?: Record<string, unknown>;
  // Other fields ignored by the validator
  [k: string]: unknown;
}

/**
 * Validate `{{ ... }}` tokens in a pipeline document. Throws `ValidationError`
 * on any problem. Called at pipeline create/update time.
 */
export function validatePipelineTemplates(pipeline: PipelineLike): void {
  const doc = {
    projectName: pipeline.projectName ?? pipeline.project,
    metadata: pipeline.metadata,
    vars: pipeline.vars,
  };

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
  const scope = {
    metadata: pipeline.metadata ?? {},
    vars: pipeline.vars ?? {},
  };
  const { errors } = resolveSelfReferencing(
    pipeline as unknown as Record<string, unknown>,
    scope,
    isPipelineTemplatable,
    fieldToScopePath,
    'pipeline',
  );
  if (errors.length) {
    throw new ValidationError(
      'Pipeline resolution failed:\n' +
      errors.map(e => `  • [${e.field ?? '?'}] ${e.message}`).join('\n'),
    );
  }
  return pipeline;
}

// Re-export tokenize for callers that need to inspect templates raw
export { tokenize };
