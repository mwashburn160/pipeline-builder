// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Golden-path pipeline templates: a parameterized starter a developer
 * instantiates (fills inputs) to create a new pipeline. The template body is a
 * BuilderProps with `{{ vars.* }}` placeholders; each declared input maps to a
 * `vars.<name>` value. Instantiation bakes the supplied inputs into the new
 * pipeline's `props.vars` — the placeholders resolve at synth time like any
 * other pipeline var (no separate template runtime).
 */

/** Scalar types a template input can carry. */
export const TEMPLATE_INPUT_TYPES = ['string', 'number', 'boolean'] as const;
export type TemplateInputType = (typeof TEMPLATE_INPUT_TYPES)[number];

/**
 * One declared input of a pipeline template. `name` is the `vars.<name>` key the
 * template body references. This is the template's counterpart to a plugin's
 * `requiredVars` contract.
 */
export interface TemplateInput {
  /** Variable key — referenced in the template body as `{{ vars.<name> }}`. */
  readonly name: string;
  /** Human label for the instantiate form (falls back to `name`). */
  readonly label?: string;
  readonly description?: string;
  readonly type: TemplateInputType;
  /** When true, instantiation fails if no value (and no default) is supplied. */
  readonly required?: boolean;
  /** Default applied when the user leaves the input blank. */
  readonly default?: string | number | boolean;
  /** Optional fixed choice set (renders as a select in the UI). */
  readonly options?: string[];
}
