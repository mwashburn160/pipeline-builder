// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Plugin contract enforcement. A plugin spec declares
 * the `{{ pipeline.metadata.X }}` / `{{ pipeline.vars.X }}` keys a pipeline
 * must supply (`requiredMetadata` / `requiredVars`) and the coercion type of
 * each (`metadataTypes` / `varsTypes`). The upload validates the spec against
 * its own templates; this module checks a PIPELINE against the contracts of
 * the plugins it references.
 *
 * CDK-free: shared by the pipeline service (create / update → 400 listing
 * every problem per step) and the synth (fail fast for a pipeline that never
 * went through the API, e.g. a CLI-authored props file).
 *
 * The checks mirror the template evaluator (`template/evaluator.ts`) exactly,
 * so "passes here" means "resolves at synth":
 *   - a key is MISSING when absent, null or the empty string (the evaluator
 *     falls to `| default:` or fails for all three);
 *   - an object/array value never interpolates;
 *   - `number` / `bool` / `json` accept what the `| number` / `| bool` /
 *     `| json` filters accept after stringification.
 */

import { merge } from './metadata-helpers.js';
import type { MetaDataType } from './pipeline-types.js';

/** Declared coercion type of a contract key. */
export type ContractValueType = 'string' | 'number' | 'bool' | 'json';

/** The contract fields of a plugin record (as `plugins` stores them). */
export interface PluginContract {
  readonly requiredMetadata?: readonly string[] | null;
  readonly requiredVars?: readonly string[] | null;
  readonly metadataTypes?: Readonly<Record<string, ContractValueType>> | null;
  readonly varsTypes?: Readonly<Record<string, ContractValueType>> | null;
}

/** What `{{ pipeline.metadata.* }}` and `{{ pipeline.vars.* }}` resolve against. */
export interface ContractScope {
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly vars: Readonly<Record<string, unknown>>;
}

/** One unmet contract key. */
export interface ContractIssue {
  readonly kind: 'metadata' | 'vars';
  readonly key: string;
  readonly problem: 'missing' | 'type';
  /** The declared type, for a `type` problem. */
  readonly expected?: ContractValueType;
  readonly message: string;
}

/** The pipeline-props fields the contract scope is built from (BuilderProps subset). */
export interface ContractScopeProps {
  readonly global?: unknown;
  readonly defaults?: unknown;
  readonly synth?: unknown;
  readonly vars?: unknown;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
}

/**
 * `pipeline.metadata` as synth builds it: `global` ← `defaults.metadata` ←
 * `synth.metadata` (last wins). The single definition — `PipelineConfiguration`
 * uses it too, so the API check and the synth scope cannot drift.
 */
export function pipelineScopeMetadata(props: ContractScopeProps): MetaDataType {
  return merge(
    asRecord(props.global) as MetaDataType,
    asRecord(asRecord(props.defaults).metadata) as MetaDataType,
    asRecord(asRecord(props.synth).metadata) as MetaDataType,
  );
}

/** The contract scope of a pipeline's props (see {@link pipelineScopeMetadata}). */
export function pipelineContractScope(props: ContractScopeProps): ContractScope {
  return { metadata: pipelineScopeMetadata(props), vars: asRecord(props.vars) };
}

/**
 * The contract scope inside a synth template scope (`{ pipeline: { metadata,
 * vars, … } }`, see `PipelineConfiguration.getPipelineScope`).
 */
export function contractScopeFromTemplateScope(templateScope: Readonly<Record<string, unknown>>): ContractScope {
  const pipeline = asRecord(templateScope.pipeline);
  return { metadata: asRecord(pipeline.metadata), vars: asRecord(pipeline.vars) };
}

/** Would the evaluator treat `value` as absent (missing / null / empty string)? */
function isMissing(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

/**
 * Does `value` satisfy the declared `type` once interpolated? Mirrors the
 * evaluator's `resolveOne` (objects never interpolate) and `applyCoercion`.
 */
export function isContractValueOfType(value: unknown, type: ContractValueType): boolean {
  if (typeof value === 'object' && value !== null) return false;
  const raw = String(value);
  switch (type) {
    case 'string':
      return true;
    case 'number':
      return Number.isFinite(Number(raw));
    case 'bool':
      return ['true', '1', 'yes', 'false', '0', 'no', ''].includes(raw.trim().toLowerCase());
    case 'json':
      try {
        JSON.parse(raw);
        return true;
      } catch {
        return false;
      }
  }
}

/** A value still carrying `{{ … }}` is resolved later (pipeline pass 1), so its type can't be judged yet. */
function isUnresolvedTemplate(value: unknown): boolean {
  return typeof value === 'string' && value.includes('{{');
}

function checkKind(
  kind: 'metadata' | 'vars',
  required: readonly string[] | null | undefined,
  types: Readonly<Record<string, ContractValueType>> | null | undefined,
  supplied: Readonly<Record<string, unknown>>,
): ContractIssue[] {
  const issues: ContractIssue[] = [];
  const where = kind === 'metadata' ? 'metadata (global / defaults.metadata / synth.metadata)' : 'vars';
  for (const key of new Set(required ?? [])) {
    if (isMissing(supplied[key])) {
      issues.push({ kind, key, problem: 'missing', message: `pipeline ${where} must supply '${key}'` });
    }
  }
  for (const [key, expected] of Object.entries(types ?? {})) {
    const value = supplied[key];
    if (isMissing(value) || isUnresolvedTemplate(value)) continue;
    if (!isContractValueOfType(value, expected)) {
      const got = typeof value === 'object' ? (Array.isArray(value) ? 'an array' : 'an object') : JSON.stringify(value);
      issues.push({ kind, key, problem: 'type', expected, message: `pipeline ${kind}.${key} must be a ${expected}, got ${got}` });
    }
  }
  return issues;
}

/**
 * Check one plugin's contract against the pipeline's scope. Returns every
 * issue (missing keys first, then ill-typed ones, metadata before vars);
 * empty when the contract is met. Declared types are checked for every
 * SUPPLIED key, required or not (an optional key with a `| default:` is still
 * coerced when it is supplied).
 */
export function checkPluginContract(contract: PluginContract, scope: ContractScope): ContractIssue[] {
  return [
    ...checkKind('metadata', contract.requiredMetadata, contract.metadataTypes, scope.metadata),
    ...checkKind('vars', contract.requiredVars, contract.varsTypes, scope.vars),
  ];
}

/**
 * Synth-time guard: throw when `plugin` (resolved for `step`) has unmet
 * contract keys. The API refuses such a pipeline at create/update; this
 * catches one that reached synth another way.
 */
export function assertPluginContract(
  plugin: PluginContract & { readonly name: string; readonly version?: string },
  scope: ContractScope,
  step: string,
): void {
  const issues = checkPluginContract(plugin, scope);
  if (issues.length === 0) return;
  throw new Error(
    `Step "${step}" uses plugin "${plugin.name}${plugin.version ? `@${plugin.version}` : ''}" whose contract is not met:\n`
    + issues.map((i) => `  • ${i.message}`).join('\n'),
  );
}

/** A plugin reference in pipeline props, with where it sits. */
export interface PluginStepRef {
  /** JSON path of the step: `synth` or `stages[i].steps[j]`. */
  readonly path: string;
  /** Human label: `synth` or `<stageName>/<alias ?? name>`. */
  readonly label: string;
  readonly name: string;
  /** Publisher handle of an installed listing. */
  readonly publisher?: string;
  readonly alias?: string;
  readonly filter?: Readonly<Record<string, unknown>>;
}

function toRef(raw: unknown, path: string, label: (name: string, alias?: string, publisher?: string) => string): PluginStepRef | null {
  const r = asRecord(raw);
  if (typeof r.name !== 'string' || r.name.length === 0) return null;
  const alias = typeof r.alias === 'string' ? r.alias : undefined;
  const publisher = typeof r.publisher === 'string' && r.publisher.length > 0 ? r.publisher : undefined;
  const filter = r.filter && typeof r.filter === 'object' ? r.filter as Record<string, unknown> : undefined;
  return {
    path,
    label: label(r.name, alias, publisher),
    name: r.name,
    ...(publisher ? { publisher } : {}),
    ...(alias ? { alias } : {}),
    ...(filter ? { filter } : {}),
  };
}

/**
 * Every plugin reference in a pipeline's props: `synth.plugin`, then each
 * `stages[].steps[].plugin` in order. One entry per STEP (not de-duplicated) —
 * the contract result is reported per step.
 */
export function collectPluginSteps(props: unknown): PluginStepRef[] {
  const p = asRecord(props);
  const out: PluginStepRef[] = [];
  const synth = toRef(asRecord(p.synth).plugin, 'synth', () => 'synth');
  if (synth) out.push(synth);
  const stages = Array.isArray(p.stages) ? p.stages : [];
  stages.forEach((stage, i) => {
    const s = asRecord(stage);
    const stageName = typeof s.stageName === 'string' ? s.stageName : `stage ${i + 1}`;
    const steps = Array.isArray(s.steps) ? s.steps : [];
    steps.forEach((step, j) => {
      const ref = toRef(asRecord(step).plugin, `stages[${i}].steps[${j}]`,
        (name, alias, publisher) => `${stageName}/${alias ?? (publisher ? `${publisher}/${name}` : name)}`);
      if (ref) out.push(ref);
    });
  });
  return out;
}

/**
 * The lookup filter synth sends for a reference (pipeline-manager
 * `resolvePluginsForProps`, the deploy-time custom resource, the pipeline
 * service's contract check): the ref's name — and its `publisher`, which
 * routes the lookup to that publisher's installed listing — overlaid by
 * an explicit `filter` (whose `name` wins), else the default active+default
 * version.
 */
export function pluginLookupFilter(ref: Pick<PluginStepRef, 'name' | 'filter' | 'publisher'>): Record<string, unknown> {
  return {
    name: ref.name,
    ...(ref.publisher ? { publisher: ref.publisher } : {}),
    ...(ref.filter ?? { isActive: true, isDefault: true }),
  };
}

// -----------------------------------------------------------------------------
// Reference identity (CDK-free: the CLI, the pipeline service and synth share it)
// -----------------------------------------------------------------------------

/**
 * The plugin-alias SEGMENT of an artifact key — and the resolver's cache key:
 * the explicit alias, or `${name}-alias` when there is none
 * (`${publisher}-${name}-alias` for a qualified reference). THE rule — the frontend's artifact picker
 * (`frontend/src/lib/artifact-keys.ts`), the CLI's pre-resolver and
 * `PluginLookup.normalize` all build keys this way.
 *
 * The places that REGISTER keys must use it too: a stage step registering the
 * bare name (`nodejs-build`) or a synth step suffixing an explicit alias
 * (`my-synth-alias`) would fail any UI-picked input artifact with "No artifact
 * registered", because the key it asks for is never the key that was stored.
 */
export function pluginArtifactAlias(plugin: PluginRefIdentity): string {
  if (plugin.alias) return plugin.alias;
  return plugin.publisher ? `${sanitizePublisher(plugin.publisher)}-${plugin.name}-alias` : `${plugin.name}-alias`;
}

/** The fields of a plugin REFERENCE that identify it. */
export interface PluginRefIdentity {
  readonly name: string;
  readonly alias?: string;
  /** Publisher handle of an installed listing; absent for an unqualified reference. */
  readonly publisher?: string;
}

/**
 * A publisher handle as it may appear in a construct id or a key: only
 * `[A-Za-z0-9_-]` (handles already are; this is the guarantee).
 */
export function sanitizePublisher(publisher: string): string {
  return publisher.replace(/[^A-Za-z0-9_-]/g, '-');
}

/**
 * The construct-id segment of a plugin step: the explicit alias, else
 * `<publisher>-<name>` for a qualified reference, else the bare name — so a
 * step using `acme`'s `lint` and one using the org's own `lint` never collide,
 * while an unqualified step keeps the id it always had (renaming it would make
 * CloudFormation replace its CodeBuild project).
 */
export function pluginStepIdAlias(plugin: PluginRefIdentity): string {
  // `??`, not `||`: an explicit (even empty) alias keeps the id it always had.
  return plugin.alias ?? (plugin.publisher ? `${sanitizePublisher(plugin.publisher)}-${plugin.name}` : plugin.name);
}
