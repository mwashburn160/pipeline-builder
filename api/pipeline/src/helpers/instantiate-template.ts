// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { ValidationError, type TemplateInput } from '@pipeline-builder/api-core';

/** Request body accepted by the instantiate endpoint (post-validation). */
export interface InstantiateBody {
  project: string;
  organization: string;
  pipelineName?: string;
  inputs?: Record<string, string | number | boolean>;
}

/** Minimal template shape the instantiate transform reads. */
export interface TemplateLike {
  props: Record<string, unknown> | null | undefined;
  inputs?: TemplateInput[] | null;
}

/** Coerce a supplied input value to its declared type. */
function coerceInput(type: TemplateInput['type'], value: unknown, name: string): string | number | boolean {
  if (type === 'number') {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) throw new ValidationError(`Template input "${name}" must be a finite number`);
    return n;
  }
  if (type === 'boolean') {
    if (typeof value === 'boolean') return value;
    const s = String(value).toLowerCase();
    if (s === 'true' || s === '1') return true;
    if (s === 'false' || s === '0' || s === '') return false;
    throw new ValidationError(`Template input "${name}" must be a boolean (true/false)`);
  }
  return String(value);
}

/**
 * Build the concrete `vars` map from a template's declared inputs and the
 * user-supplied values. Applies defaults, enforces `required`, validates
 * `options`, and coerces each value to its declared type. Throws
 * `ValidationError` on any contract breach (surfaced as HTTP 400).
 */
export function buildTemplateVars(
  inputs: TemplateInput[],
  provided: Record<string, string | number | boolean> = {},
): Record<string, unknown> {
  const vars: Record<string, unknown> = {};
  for (const input of inputs) {
    let value: unknown = provided[input.name];
    if (value === undefined || value === '') {
      if (input.default !== undefined) value = input.default;
      else if (input.required) throw new ValidationError(`Missing required template input: "${input.name}"`);
      else continue;
    }
    if (input.options && input.options.length > 0 && !input.options.includes(String(value))) {
      throw new ValidationError(`Template input "${input.name}" must be one of: ${input.options.join(', ')}`);
    }
    vars[input.name] = coerceInput(input.type, value, input.name);
  }
  return vars;
}

/**
 * Instantiate a template into a concrete pipeline `props` (BuilderProps). Bakes
 * the requested project/organization/pipelineName and merges the resolved
 * `vars` over the template's own defaults. The `{{ vars.* }}` placeholders in the
 * body are left intact — they resolve at synth time like any pipeline var — so
 * the returned props flow straight into the normal create path (which runs the
 * usual compliance + quota checks and template validation).
 */
export function instantiateTemplateProps(template: TemplateLike, body: InstantiateBody): Record<string, unknown> {
  const inputs = (template.inputs ?? []) as TemplateInput[];
  const vars = buildTemplateVars(inputs, body.inputs ?? {});

  // Deep clone so we never mutate the stored template row.
  const props = JSON.parse(JSON.stringify(template.props ?? {})) as Record<string, unknown>;

  props.project = body.project;
  props.organization = body.organization;
  if (body.pipelineName) props.pipelineName = body.pipelineName;

  const existingVars = (props.vars && typeof props.vars === 'object') ? (props.vars as Record<string, unknown>) : {};
  props.vars = { ...existingVars, ...vars };

  return props;
}
