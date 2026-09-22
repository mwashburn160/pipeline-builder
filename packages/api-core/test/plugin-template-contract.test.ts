// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for validation/plugin-template-contract — the `{{ ... }}` contract the
 * upload API and the CLI share (plugin-ecosystem W6). The real template engine
 * lives in pipeline-core (which depends on api-core); api/plugin and
 * pipeline-manager exercise it end-to-end. Here a small stand-in engine drives
 * the contract logic.
 */

import { describe, it, expect } from '@jest/globals';
import {
  PLUGIN_TEMPLATE_SCOPE_ROOTS, checkPluginTemplates, formatPluginTemplateIssue, isPluginTemplatableField,
  type PluginTemplateEngine,
} from '../src/validation/plugin-template-contract.js';

/** `{{ a.b.c | default: 'x' }}` / `{{ a.b | number }}` — enough of the grammar for the contract. */
function tokenize(source: string) {
  if (source.includes('{{!')) throw new Error('bad token');
  return [...source.matchAll(/\{\{\s*([^}|]+?)\s*(?:\|\s*([a-z]+)(?::\s*'([^']*)')?\s*)?\}\}/g)].map((m) => ({
    kind: 'expr',
    path: m[1]!.split('.'),
    ...(m[2] === 'default' ? { defaultValue: m[3] ?? '' } : {}),
    ...(m[2] && m[2] !== 'default' ? { coerce: m[2] } : {}),
  }));
}

const calls: Array<{ doc: object; roots: string[] }> = [];
const engine: PluginTemplateEngine = {
  allowedScopeRoots: (roots) => { calls.at(-1)!.roots = roots; return (p) => roots.includes(p[0]!); },
  validateTemplates: (doc, isTpl, isKnown) => {
    const errors: Array<{ field: string; line?: number; col?: number; message: string }> = [];
    const d = doc as Record<string, unknown>;
    (Array.isArray(d.commands) ? d.commands : []).forEach((c: unknown, i: number) => {
      const field = `commands[${i}]`;
      if (!isTpl(field) || typeof c !== 'string') return;
      try {
        for (const t of tokenize(c)) if (!isKnown(t.path)) errors.push({ field, line: 1, col: 3, message: `unknown scope root '${t.path[0]}'` });
      } catch { errors.push({ field, message: 'parse error' }); }
    });
    return { errors };
  },
  tokenize,
};
const run = (spec: object) => { calls.push({ doc: spec, roots: [] }); return checkPluginTemplates(spec, engine); };

describe('isPluginTemplatableField', () => {
  it.each(['description', 'commands[0]', 'installCommands[2]', 'env.STAGE', 'buildArgs.X'])('accepts %s', (f) => {
    expect(isPluginTemplatableField(f)).toBe(true);
  });
  it.each(['commandsX', 'name', 'metadata.x', 'secrets[0]', 'envelope'])('refuses %s', (f) => {
    expect(isPluginTemplatableField(f)).toBe(false);
  });
});

describe('checkPluginTemplates', () => {
  it('passes a spec without templates, and asks the engine for the plugin scope roots', () => {
    expect(run({ commands: ['echo hi'], env: { A: 'b' } })).toEqual([]);
    expect(calls.at(-1)!.roots).toEqual([...PLUGIN_TEMPLATE_SCOPE_ROOTS]);
  });

  it('maps engine errors to `template` issues (with and without a position)', () => {
    const issues = run({ commands: ['echo {{ bogus.x }}', 'echo {{! }}'] });
    expect(issues).toEqual([
      { kind: 'template', field: 'commands[0]', line: 1, col: 3, message: "unknown scope root 'bogus'" },
      { kind: 'template', field: 'commands[1]', message: 'parse error' },
    ]);
    expect(issues.map(formatPluginTemplateIssue)).toEqual([
      "[commands[0]:1:3] unknown scope root 'bogus'",
      '[commands[1]] parse error',
    ]);
  });

  it('requires every pipeline.metadata / pipeline.vars reference to be declared, unless it has a default', () => {
    const issues = run({
      description: 'uses {{ pipeline.metadata.env }}',
      commands: ['echo {{ pipeline.vars.n }} {{ pipeline.vars.opt | default: \'1\' }}', 'echo {{ pipeline.metadata.env }}'],
      installCommands: ['{{ pipeline.vars.declared }}'],
      env: { A: '{{ plugin.name }}' },
      buildArgs: { B: '{{ pipeline.metadata }}' },
      requiredVars: ['declared'],
    });
    expect(issues.map((i) => [i.kind, i.field])).toEqual([
      ['undeclared', 'pipeline.metadata.env'],
      ['undeclared', 'pipeline.vars.n'],
    ]);
    expect(formatPluginTemplateIssue(issues[0]!)).toBe("pipeline.metadata.env is not declared in 'requiredMetadata' (declare it, or add '| default: ...')");
  });

  it('checks a coercion filter against the declared type (undeclared = string, boolean = bool)', () => {
    const issues = run({
      commands: ['{{ pipeline.vars.n | number }} {{ pipeline.vars.f | bool }} {{ pipeline.metadata.j | json }} {{ pipeline.vars.u | upper }}'],
      requiredVars: ['n', 'f', 'u'],
      requiredMetadata: ['j'],
      varsTypes: { f: 'boolean' },
      metadataTypes: { j: 'number' },
    });
    expect(issues.map((i) => i.message)).toEqual([
      "pipeline.vars.n uses '| number' but declared type is 'string' (add 'n: number' to varsTypes)",
      "pipeline.metadata.j uses '| json' but declared type is 'number' (add 'j: json' to metadataTypes)",
    ]);
  });

  it('skips a source the tokenizer rejects and ignores non-string / malformed fields', () => {
    expect(run({ commands: ['{{! }}', 42], env: ['x'], requiredVars: 'n', varsTypes: [] }).map((i) => i.kind)).toEqual(['template']);
  });
});
