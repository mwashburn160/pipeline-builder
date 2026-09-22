// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The plugin spec's `{{ ... }}` TEMPLATE CONTRACT, exactly as the plugin
 * service checks an upload. Shared from api-core so the upload path
 * (api/plugin) and the CLI (`pipeline-manager plugin validate` / `test` /
 * `publish`) apply ONE check and can't drift (plugin-ecosystem W6).
 *
 * Pure: it returns issues and never throws. The template engine (tokenizer and
 * scope validator) lives in pipeline-core, which depends on api-core, so the
 * caller hands it in as {@link PluginTemplateEngine}; pipeline-core's module
 * satisfies the interface as-is.
 */

/** Scope roots a plugin template may reference. */
export const PLUGIN_TEMPLATE_SCOPE_ROOTS = ['pipeline', 'plugin', 'env'] as const;

/** Spec fields whose strings may carry `{{ ... }}` templates. */
export const PLUGIN_TEMPLATABLE_FIELDS = ['description', 'commands', 'installCommands', 'env', 'buildArgs'] as const;

/** True when a walked field path (`commands[2]`, `env.STAGE`) is templatable. */
export function isPluginTemplatableField(field: string): boolean {
  return PLUGIN_TEMPLATABLE_FIELDS.some((f) => field === f || field.startsWith(`${f}[`) || field.startsWith(`${f}.`));
}

/** The slice of pipeline-core's template engine this check uses. */
export interface PluginTemplateEngine {
  allowedScopeRoots(roots: string[]): (path: string[]) => boolean;
  validateTemplates(
    doc: object,
    isTemplatable: (field: string) => boolean,
    isKnownPath: (path: string[]) => boolean,
  ): { errors: ReadonlyArray<{ field: string; line?: number; col?: number; message: string }> };
  tokenize(source: string): ReadonlyArray<{ kind: string; path?: string[]; defaultValue?: string; coerce?: string }>;
}

/**
 * One template-contract problem.
 * - `template`: a parse error, unknown scope root or reserved `secrets.*` path.
 * - `undeclared`: `{{ pipeline.metadata.X }}` / `{{ pipeline.vars.X }}` without
 *   `X` in `requiredMetadata` / `requiredVars` (and no `| default:`).
 * - `type-mismatch`: a `| number|bool|json` filter whose declared type differs.
 */
export interface PluginTemplateIssue {
  kind: 'template' | 'undeclared' | 'type-mismatch';
  /** The spec field (`commands[0]`) for `template` issues; the scope path otherwise. */
  field: string;
  line?: number;
  col?: number;
  message: string;
}

const COERCE_TO_TYPE: Readonly<Record<string, string>> = { number: 'number', bool: 'bool', json: 'json' };

const stringList = (v: unknown): string[] =>
  (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const stringValues = (v: unknown): string[] =>
  (v && typeof v === 'object' && !Array.isArray(v)
    ? Object.values(v as Record<string, unknown>).filter((x): x is string => typeof x === 'string')
    : []);
const stringMap = (v: unknown): Record<string, string> =>
  (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, string> : {});

/**
 * Every `{{ ... }}` problem in a plugin spec: parse errors and scope roots
 * (only `pipeline`, `plugin`, `env`; `secrets` is reserved), then per
 * `{{ pipeline.metadata.X }}` / `{{ pipeline.vars.X }}` reference (a) that `X`
 * is declared in `requiredMetadata` / `requiredVars` unless it has a
 * `| default:`, and (b) that a coercion filter matches the declared type in
 * `metadataTypes` / `varsTypes` (undeclared = `string`; `boolean` = `bool`).
 *
 * Takes the raw spec object, so a spec that failed the schema is still checked.
 * Issues are de-duplicated; an empty array means the spec passes.
 */
export function checkPluginTemplates(spec: object, engine: PluginTemplateEngine): PluginTemplateIssue[] {
  const s = spec as Record<string, unknown>;
  const doc = {
    description: s.description,
    commands: s.commands,
    installCommands: s.installCommands,
    env: s.env,
    buildArgs: s.buildArgs,
  };
  const issues: PluginTemplateIssue[] = [];

  const { errors } = engine.validateTemplates(doc, isPluginTemplatableField, engine.allowedScopeRoots([...PLUGIN_TEMPLATE_SCOPE_ROOTS]));
  for (const e of errors) {
    issues.push({ kind: 'template', field: e.field, ...(e.line !== undefined && { line: e.line, col: e.col }), message: e.message });
  }

  const required = { metadata: new Set(stringList(s.requiredMetadata)), vars: new Set(stringList(s.requiredVars)) };
  const types = { metadata: stringMap(s.metadataTypes), vars: stringMap(s.varsTypes) };
  const sources = [
    ...(typeof s.description === 'string' ? [s.description] : []),
    ...stringList(s.commands), ...stringList(s.installCommands), ...stringValues(s.env), ...stringValues(s.buildArgs),
  ];
  const seen = new Set<string>();
  const add = (issue: PluginTemplateIssue) => {
    const key = `${issue.kind}\u0000${issue.message}`;
    if (!seen.has(key)) { seen.add(key); issues.push(issue); }
  };

  for (const source of sources) {
    if (!source.includes('{{')) continue;
    let tokens;
    try { tokens = engine.tokenize(source); } catch { continue; /* reported as a `template` issue above */ }
    for (const t of tokens) {
      if (t.kind !== 'expr' || !t.path) continue;
      const [root, sub, key] = t.path;
      if (root !== 'pipeline' || (sub !== 'metadata' && sub !== 'vars') || !key) continue;
      const scopePath = `pipeline.${sub}.${key}`;
      const declaredIn = sub === 'metadata' ? 'requiredMetadata' : 'requiredVars';
      const typesIn = sub === 'metadata' ? 'metadataTypes' : 'varsTypes';

      if (t.defaultValue === undefined && !required[sub].has(key)) {
        add({ kind: 'undeclared', field: scopePath, message: `${scopePath} is not declared in '${declaredIn}' (declare it, or add '| default: ...')` });
      }
      const expected = t.coerce ? COERCE_TO_TYPE[t.coerce] : undefined;
      if (expected) {
        // Shipped specs spell the boolean type both `bool` and `boolean`; the
        // stored contract (and the filter) use `bool`.
        const raw = types[sub][key] ?? 'string';
        const declared = raw === 'boolean' ? 'bool' : raw;
        if (declared !== expected) {
          add({
            kind: 'type-mismatch',
            field: scopePath,
            message: `${scopePath} uses '| ${t.coerce}' but declared type is '${declared}' (add '${key}: ${expected}' to ${typesIn})`,
          });
        }
      }
    }
  }
  return issues;
}

/** One line per issue: `[commands[0]:1:5] message` for template issues, the message otherwise. */
export function formatPluginTemplateIssue(issue: PluginTemplateIssue): string {
  if (issue.kind !== 'template') return issue.message;
  return `[${issue.field}${issue.line !== undefined ? `:${issue.line}:${issue.col}` : ''}] ${issue.message}`;
}
