// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from '@jest/globals';
import type { Plugin } from '@pipeline-builder/pipeline-data';
import { resolvePluginTemplates, isPluginTemplatableField } from '../../src/template/plugin-resolver.js';

function mkPlugin(overrides: Partial<Plugin> = {}): Plugin {
  return {
    id: 'p1',
    orgId: 'acme',
    name: 'deploy',
    version: '1.0.0',
    description: 'Test plugin',
    pluginType: 'CodeBuildStep',
    computeType: 'SMALL',
    commands: [],
    installCommands: [],
    env: {},
    buildArgs: {},
    secrets: [],
    metadata: {},
    keywords: [],
    visibility: 'public',
    isActive: true,
    isDefault: false,
    failureBehavior: 'fail',
    ...overrides,
  } as unknown as Plugin;
}

describe('isPluginTemplatableField', () => {
  it('accepts commands array entries', () => {
    expect(isPluginTemplatableField('commands[0]')).toBe(true);
  });
  it('accepts env child keys', () => {
    expect(isPluginTemplatableField('env.STAGE')).toBe(true);
  });
  it('rejects name/version/pluginType', () => {
    expect(isPluginTemplatableField('name')).toBe(false);
    expect(isPluginTemplatableField('version')).toBe(false);
    expect(isPluginTemplatableField('pluginType')).toBe(false);
  });
  it('rejects metadata', () => {
    expect(isPluginTemplatableField('metadata.CDK_KEY')).toBe(false);
  });
});

describe('resolvePluginTemplates', () => {
  const scope = {
    pipeline: {
      projectName: 'checkout',
      metadata: { env: 'prod', region: 'us-east-1' },
    },
  };

  it('substitutes {{ pipeline.* }} in commands and env', () => {
    const plugin = mkPlugin({
      commands: ['deploy --env {{ pipeline.metadata.env }}'],
      installCommands: ['echo {{ pipeline.projectName }}'],
      env: { REGION: '{{ pipeline.metadata.region }}' },
    });
    const resolved = resolvePluginTemplates(plugin, scope);
    expect(resolved.commands).toEqual(['deploy --env prod']);
    expect(resolved.installCommands).toEqual(['echo checkout']);
    expect(resolved.env).toEqual({ REGION: 'us-east-1' });
  });

  it('leaves plugin spec fields with no templates untouched', () => {
    const plugin = mkPlugin({
      commands: ['plain cmd'],
      env: { STAGE: 'literal' },
    });
    const resolved = resolvePluginTemplates(plugin, scope);
    expect(resolved.commands).toEqual(['plain cmd']);
    expect(resolved.env).toEqual({ STAGE: 'literal' });
  });

  it('applies default filter when path is missing', () => {
    const plugin = mkPlugin({
      commands: ['echo {{ pipeline.metadata.missing | default: \'fallback\' }}'],
    });
    expect(resolvePluginTemplates(plugin, scope).commands).toEqual(['echo fallback']);
  });

  it('throws for unknown path without default', () => {
    const plugin = mkPlugin({ commands: ['echo {{ pipeline.nope }}'] });
    expect(() => resolvePluginTemplates(plugin, scope)).toThrow(/Template resolution failed/);
  });

  it('does not mutate the input plugin', () => {
    const plugin = mkPlugin({ commands: ['echo {{ pipeline.projectName }}'] });
    const frozenCommands = [...plugin.commands!];
    resolvePluginTemplates(plugin, scope);
    expect(plugin.commands).toEqual(frozenCommands);
  });
});

/**
 * `env` values that reference other `env` values. The scope root used to be the
 * ORIGINAL, unresolved env map, so `{{ env.A }}` substituted A's raw template
 * text and a literal `{{ … }}` was baked into the CodeBuild environment and the
 * shell command with no error at all.
 */
describe('resolvePluginTemplates — env referencing env', () => {
  const plugin = (env: Record<string, string>, commands: string[] = []) =>
    ({ name: 'p', version: '1.0.0', commands, env } as any);
  const scope = { pipeline: { metadata: { env: 'prod' } } };

  it('resolves a chain in dependency order, whatever the declaration order', () => {
    const out = resolvePluginTemplates(
      plugin({ B: '{{ env.A }}-svc', A: '{{ pipeline.metadata.env }}' }, ['run {{ env.B }}']),
      scope,
    );
    expect(out.env).toEqual({ A: 'prod', B: 'prod-svc' });
    expect(out.commands).toEqual(['run prod-svc']);
  });

  it('reports a cycle instead of shipping template text', () => {
    expect(() => resolvePluginTemplates(plugin({ A: '{{ env.B }}', B: '{{ env.A }}' }), scope))
      .toThrow(/cycle/i);
  });

  it('does not re-tokenize an env value produced by an escape', () => {
    const out = resolvePluginTemplates(plugin({ FMT: '{{{{.State.Status}}' }, ['echo {{ env.FMT }}']), scope);
    expect(out.env).toEqual({ FMT: '{{.State.Status}}' });
    expect(out.commands).toEqual(['echo {{.State.Status}}']);
  });

  it('never mutates the caller\'s plugin', () => {
    const original = plugin({ A: '{{ pipeline.metadata.env }}' });
    resolvePluginTemplates(original, scope);
    expect(original.env.A).toBe('{{ pipeline.metadata.env }}');
  });
});
