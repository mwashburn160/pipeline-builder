// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Step manifest (W0.1): the (stage, action) → plugin map PipelineBuilder emits
 * after building the pipeline. The load-bearing property is that the stage and
 * action names are EXACTLY what the synthesized CodePipeline carries — those
 * are the names CodePipeline state-change events report, and event ingest joins
 * on them — so every assertion here is made against the real template.
 */

import { jest, describe, it, expect } from '@jest/globals';
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { apiCoreMock } from './helpers/mock-api-core.js';
import type { BuilderProps } from '../src/pipeline/pipeline-builder.js';

process.env.CODEBUILD_DEFAULT_IMAGE = 'aws/codebuild/standard:8.0';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

// Stub PluginLookup (the real one bundles a Lambda). Each name resolves to a
// distinct catalog row; `unresolved` stands in for a lookup that fell back to
// the synth-time placeholder, which the manifest must skip.
jest.unstable_mockModule('../src/pipeline/plugin-lookup.js', async () => {
  const { Construct } = await import('constructs');
  const { PLACEHOLDER_PLUGIN_ID } = await import('../src/core/step-manifest.js');
  const row = (name: string) => ({
    id: name === 'unresolved' ? PLACEHOLDER_PLUGIN_ID : `id-${name}`,
    orgId: 'org-a',
    name,
    version: name === 'jest' ? '2.1.0' : '1.0.0',
    metadata: {},
    pluginType: 'CodeBuildStep',
    computeType: 'SMALL',
    timeout: null,
    failureBehavior: 'fail',
    secrets: [],
    primaryOutputDirectory: name === 'cdk-synth' ? 'cdk.out' : null,
    env: {},
    buildArgs: {},
    installCommands: [],
    commands: ['echo run'],
    buildType: 'metadata_only',
    imageDigest: null,
    category: 'unknown',
  });
  class PluginLookup extends Construct {
    plugin(ref: { name: string }) { return row(ref.name); }
    bootstrap() { return row('unresolved'); }
  }
  return { PluginLookup };
});

const { PipelineBuilder } = await import('../src/pipeline/pipeline-builder.js');
const { pluginImageRepository } = await import('../src/core/step-manifest.js');

function build(props: Partial<BuilderProps>) {
  const stack = new Stack(new App(), 'PbManifestStack');
  const builder = new PipelineBuilder(stack, 'Pb', {
    project: 'shop',
    organization: 'acme',
    orgId: 'org-a',
    synth: {
      source: { type: 'github', options: { repo: 'acme/shop', branch: 'main' } },
      plugin: { name: 'cdk-synth' },
    },
    ...props,
  } as BuilderProps);
  const template = Template.fromStack(stack);
  const [pipeline] = Object.values(template.findResources('AWS::CodePipeline::Pipeline')) as Array<{
    Properties: { Stages: Array<{ Name: string; Actions: Array<{ Name: string }> }> };
  }>;
  const synthesized = new Set(
    pipeline.Properties.Stages.flatMap((s) => s.Actions.map((a) => `${s.Name}/${a.Name}`)),
  );
  return { builder, synthesized };
}

describe('PipelineBuilder.stepManifest', () => {
  it('records every plugin step under the stage/action names the synthesized pipeline carries', () => {
    const { builder, synthesized } = build({
      resolvedPlugins: { 'cdk-synth-alias': {} } as never,
      stages: [
        { stageName: 'Test', alias: 'test-wave', steps: [{ plugin: { name: 'jest' } }, { plugin: { name: 'eslint', alias: 'lint' } }] },
        { stageName: 'Scan', steps: [{ plugin: { name: 'trivy' } }] },
      ],
    });

    const manifest = builder.stepManifest as unknown as Array<Record<string, unknown>>;
    expect(manifest.map((e) => e.pluginName).sort()).toEqual(['cdk-synth', 'eslint', 'jest', 'trivy']);
    for (const e of manifest) {
      expect(synthesized.has(`${e.stageName}/${e.actionName}`)).toBe(true);
    }
    const jestStep = manifest.find((e) => e.pluginName === 'jest')!;
    expect(jestStep).toEqual({
      stageName: 'test-wave',
      actionName: expect.any(String),
      pluginId: 'id-jest',
      pluginName: 'jest',
      pluginVersion: '2.1.0',
      imageDigest: null,
    });
    // Default stage alias (`<stageName>-alias`) is the CodePipeline stage name.
    expect(manifest.find((e) => e.pluginName === 'trivy')!.stageName).toBe('Scan-alias');
  });

  it('skips steps whose plugin fell back to the synth-time placeholder', () => {
    const { builder } = build({
      // No resolvedPlugins → the synth step bootstraps (placeholder).
      stages: [{ stageName: 'Test', steps: [{ plugin: { name: 'unresolved' } }, { plugin: { name: 'jest' } }] }],
    });
    expect((builder.stepManifest as Array<{ pluginName: string }>).map((e) => e.pluginName)).toEqual(['jest']);
  });
});

describe('pluginImageRepository', () => {
  it('namespaces by the owner org (system catalog vs tenant)', () => {
    expect(pluginImageRepository({ orgId: '000000000000000000000001', name: 'jest', buildType: 'build_image' })).toBe('system/jest');
    expect(pluginImageRepository({ orgId: 'org-a', name: 'jest', buildType: 'prebuilt' })).toBe('org-org-a/jest');
  });

  it('is null for a metadata_only plugin (no image)', () => {
    expect(pluginImageRepository({ orgId: 'org-a', name: 'jest', buildType: 'metadata_only' })).toBeNull();
  });
});
