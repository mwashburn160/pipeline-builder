// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { ErrorCode, ValidationError } from '@pipeline-builder/api-core';
import { validatePipelineProps } from '@pipeline-builder/pipeline-core';

/**
 * The only shape this validator needs: the `props` nesting that create/update
 * bodies and DB rows use (BuilderProps). The templatable fields themselves —
 * `project`, `vars`, the metadata layers and `synth.source` — are read by
 * pipeline-core's `validatePipelineProps`, the one definition of the contract.
 *
 * `props` is `unknown`-typed on purpose: the callers are Zod-validated request
 * bodies and Drizzle rows, whose concrete types satisfy it structurally with no
 * casts, so a schema rename breaks the build instead of validating nothing.
 */
export interface PipelineLike {
  props?: unknown;
}

/** Options: `template` validates a pipeline TEMPLATE body (its source may carry `{{ vars.* }}`). */
export interface ValidatePipelineTemplatesOptions {
  readonly template?: boolean;
}

/**
 * Validate `{{ ... }}` tokens in a pipeline's props. Throws `ValidationError`
 * on any problem. Called at pipeline create/update time (and, with
 * `template: true`, at template create/update time).
 */
export function validatePipelineTemplates(pipeline: PipelineLike, opts: ValidatePipelineTemplatesOptions = {}): void {
  const props = pipeline.props && typeof pipeline.props === 'object' ? pipeline.props : {};
  const errors = validatePipelineProps(props, { template: opts.template === true });
  if (errors.length === 0) return;

  const cycles = errors.filter((e) => e.code === ErrorCode.TEMPLATE_CYCLE);
  if (cycles.length === errors.length) {
    throw new ValidationError(
      'Pipeline has circular template references:\n' +
      cycles.map(e => `  • ${e.message}`).join('\n'),
    );
  }
  throw new ValidationError(
    `Pipeline template validation failed (${errors.length} error${errors.length === 1 ? '' : 's'}):\n` +
    errors.map(e => `  • [${e.field}${e.line ? `:${e.line}:${e.col}` : ''}] ${e.message}`).join('\n'),
  );
}
