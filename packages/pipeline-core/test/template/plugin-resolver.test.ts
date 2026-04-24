// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Plugin } from '@pipeline-builder/pipeline-data';
import { resolvePluginTemplates, isPluginTemplatableField } from '../../src/template/plugin-resolver';

function mkPlugin(overrides: Partial<Plugin> = {}): Plugin {
  return {
    id: 'p1',
    orgId: 'acme',
    name: 'deploy',
    version: '1.0.0',
    description: 'Test plugin',
    pluginType: 'CodeBuildStep',
    computeType: 'SMALL',
    imageTag: 'p-deploy-abc',
    commands: [],
    installCommands: [],
    env: {},
    buildArgs: {},
    secrets: [],
    metadata: {},
    keywords: [],
    accessModifier: 'public',
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
      commands: [`echo {{ pipeline.metadata.missing | default: 'fallback' }}`],
    });
    expect(resolvePluginTemplates(plugin, scope).commands).toEqual(['echo fallback']);
  });

  it('throws for unknown path without default', () => {
    const plugin = mkPlugin({ commands: [`echo {{ pipeline.nope }}`] });
    expect(() => resolvePluginTemplates(plugin, scope)).toThrow(/Template resolution failed/);
  });

  it('does not mutate the input plugin', () => {
    const plugin = mkPlugin({ commands: [`echo {{ pipeline.projectName }}`] });
    const frozenCommands = [...plugin.commands!];
    resolvePluginTemplates(plugin, scope);
    expect(plugin.commands).toEqual(frozenCommands);
  });
});
