// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The pipeline props' own `{{ … }}` contract — ONE implementation shared by the
 * API (create/update validation, `GET /pipelines/:id?resolve=true`, template
 * instantiate), the CLI (`--show-resolved`, `template validate`) and synth
 * (`PipelineBuilder` resolves its props with it before anything reads them).
 *
 * Self-references (pass 1, before plugin templates see the pipeline scope):
 *  - `project`, every `vars.*` value, and `metadata.*` AS SYNTH SEES IT —
 *    `global` ← `defaults.metadata` ← `synth.metadata` (last wins), the one
 *    merge in {@link pipelineScopeMetadata}. A top-level `metadata` or
 *    `projectName` key is not a BuilderProps field and is never read.
 *  - A field may reference `metadata.*` and `vars.*` only.
 *
 * Source identity: `synth.source` fields other than `options.token` (the repo,
 * branch, connection, bucket …) are NOT resolved at synth — the stored pipeline
 * must name a real repository. A pipeline TEMPLATE may parameterize them with
 * `{{ vars.* }}`; instantiate bakes them ({@link bakeSourceTemplates}); a
 * pipeline carrying one is refused ({@link validatePipelineProps}). The token
 * keeps its own synth-time resolution against the `pipeline.*` scope.
 */

import { ErrorCode, ValidationError } from '@pipeline-builder/api-core';
import { resolveSelfReferencing, resolveTemplates } from './index.js';
import { allowedScopeRoots, detectCycles, validateTemplates, type TemplateError } from './validate.js';
import { visitStrings } from './walker.js';
import { pipelineScopeMetadata } from '../core/plugin-contract.js';

/** The scope roots a pipeline self-reference may address. */
export const PIPELINE_SELF_SCOPE_ROOTS: readonly string[] = ['metadata', 'vars'];

/**
 * Is `field` (a path in the {@link pipelineTemplatableView}) templatable?
 * `project`, `metadata.*` and `vars.*`.
 */
export function isPipelineTemplatableField(field: string): boolean {
  return field === 'project'
    || field.startsWith('metadata.') || field.startsWith('metadata[')
    || field.startsWith('vars.') || field.startsWith('vars[');
}

/** Each templatable view field writes the scope path it occupies (`metadata.env` → `metadata.env`). */
export function pipelineFieldScopePath(field: string): string | null {
  return isPipelineTemplatableField(field) ? field : null;
}

/** The templatable view of a pipeline's props. */
export interface PipelineTemplatableView {
  project: unknown;
  /** `global` ← `defaults.metadata` ← `synth.metadata`, merged as synth merges them. */
  metadata: Record<string, unknown>;
  vars: Record<string, unknown>;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
}

/** Plain-JSON deep copy (props are JSON documents; the copy keeps the input untouched). */
function clone<T>(v: T): T {
  return v === undefined ? v : JSON.parse(JSON.stringify(v)) as T;
}

/**
 * The templatable view of `props` — a fresh object, so resolving it never
 * touches `props`.
 */
export function pipelineTemplatableView(props: object): PipelineTemplatableView {
  const p = props as Record<string, unknown>;
  return {
    project: p.project,
    metadata: clone({ ...pipelineScopeMetadata(p) }) as Record<string, unknown>,
    vars: clone(asRecord(p.vars) ?? {}),
  };
}

/** The `synth.source` fields that are repository identity (everything but the token). */
function isSourceIdentityField(field: string): boolean {
  return field.startsWith('source.') && field !== 'source.options.token';
}

const isKnownSelfPath = allowedScopeRoots([...PIPELINE_SELF_SCOPE_ROOTS]);

/** Options for {@link validatePipelineProps}. */
export interface ValidatePipelinePropsOptions {
  /**
   * Validate a pipeline TEMPLATE body: its `synth.source` identity fields may
   * carry `{{ vars.* }}` (and only that root) — instantiate bakes them. Default
   * false: a pipeline's source must name a real repository.
   */
  readonly template?: boolean;
}

const isKnownSourcePath = allowedScopeRoots(['vars']);

/**
 * Validate a pipeline's props: template shape (parse, unknown root, reserved
 * `secrets.*`, size limits), self-reference cycles (only when the shape is
 * valid — the cycle walker tokenizes eagerly), and the `synth.source` identity
 * fields (refused in a pipeline; `vars.*`-only in a template). Returns every
 * error; empty means valid. Source fields are named as authored
 * (`synth.source.options.repo`); self-reference fields by the view's
 * `metadata.*` (the merged key).
 */
export function validatePipelineProps(props: object, opts: ValidatePipelinePropsOptions = {}): TemplateError[] {
  const view = pipelineTemplatableView(props);
  const { errors } = validateTemplates(view, isPipelineTemplatableField, isKnownSelfPath);
  if (errors.length === 0) {
    errors.push(...detectCycles(view, isPipelineTemplatableField, pipelineFieldScopePath));
  }
  const source = asRecord(asRecord((props as Record<string, unknown>).synth)?.source);
  if (!source) return errors;
  if (opts.template) {
    const sourceErrors = validateTemplates({ source }, isSourceIdentityField, isKnownSourcePath).errors;
    errors.push(...sourceErrors.map((e) => ({ ...e, field: `synth.${e.field}` })));
    return errors;
  }
  visitStrings({ source }, isSourceIdentityField, (field) => {
    errors.push({
      field: `synth.${field}`,
      code: ErrorCode.TEMPLATE_VALIDATION_FAILED,
      message: 'A pipeline\'s source must name a real repository: `{{ … }}` here is never resolved at synth '
        + '(only `token` is). Parameterize it in a pipeline template instead — instantiate fills it in.',
    });
  });
  return errors;
}

function formatErrors(title: string, errors: ReadonlyArray<{ field?: string; message: string }>): string {
  return `${title}:\n${errors.map((e) => `  • [${e.field ?? '?'}] ${e.message}`).join('\n')}`;
}

/**
 * Resolve a pipeline's self-references (pass 1) and return NEW props with the
 * values written back: `project`, every `vars.*`, and each metadata key into
 * the layer synth takes it from (the last of `global` / `defaults.metadata` /
 * `synth.metadata` that sets it — an overridden lower-layer value is left as
 * written). Never mutates `props`. Throws `ValidationError` on an unresolved
 * reference or a cycle.
 */
export function resolvePipelineProps<T extends object>(props: T): T {
  const view = pipelineTemplatableView(props);
  const { errors } = resolveSelfReferencing(
    view,
    { metadata: view.metadata, vars: view.vars },
    isPipelineTemplatableField,
    pipelineFieldScopePath,
  );
  if (errors.length) throw new ValidationError(formatErrors('Pipeline resolution failed', errors));

  const src = props as Record<string, unknown>;
  const out: Record<string, unknown> = { ...src };
  if (typeof view.project === 'string') out.project = view.project;
  if (asRecord(src.vars)) out.vars = view.vars;

  // Copy the three metadata layers, then write each merged key to its owner.
  const global = asRecord(src.global) ? { ...asRecord(src.global) } : undefined;
  const defaults = asRecord(src.defaults);
  const defaultsMeta = asRecord(defaults?.metadata) ? { ...asRecord(defaults!.metadata) } : undefined;
  const synth = asRecord(src.synth);
  const synthMeta = asRecord(synth?.metadata) ? { ...asRecord(synth!.metadata) } : undefined;
  const layers = [synthMeta, defaultsMeta, global];
  for (const [key, value] of Object.entries(view.metadata)) {
    const owner = layers.find((layer) => layer && Object.prototype.hasOwnProperty.call(layer, key));
    if (owner) owner[key] = value;
  }
  if (global) out.global = global;
  if (defaultsMeta) out.defaults = { ...defaults, metadata: defaultsMeta };
  if (synthMeta) out.synth = { ...synth, metadata: synthMeta };
  return out as T;
}

/**
 * Bake `{{ vars.* }}` into a template's `synth.source` identity fields (every
 * string under `synth.source` except `options.token`) against `vars`, so the
 * instantiated pipeline names a real repository. Returns NEW props; throws
 * `ValidationError` naming the field when a reference has no value.
 */
export function bakeSourceTemplates<T extends object>(props: T, vars: Record<string, unknown>): T {
  const synth = asRecord((props as Record<string, unknown>).synth);
  const source = asRecord(synth?.source);
  if (!source) return props;
  const holder = { source: clone(source) };
  let errors: ReturnType<typeof resolveTemplates>['errors'];
  try {
    ({ errors } = resolveTemplates(holder, { vars }, isSourceIdentityField));
  } catch (err) {
    // A malformed template throws while the walker tokenizes.
    throw new ValidationError(formatErrors('Template source could not be filled in', [{ message: (err as Error).message }]));
  }
  if (errors.length) {
    throw new ValidationError(formatErrors(
      'Template source could not be filled in',
      errors.map((e) => ({ ...e, field: e.field ? `synth.${e.field}` : undefined })),
    ));
  }
  return { ...props, synth: { ...synth, source: holder.source } } as T;
}
