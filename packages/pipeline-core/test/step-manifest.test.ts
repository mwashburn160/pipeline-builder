// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Step manifest: the (stage, action) → plugin map PipelineBuilder emits
 * after building the pipeline. The load-bearing property is that the stage and
 * action names are EXACTLY what the synthesized CodePipeline carries — those
 * are the names CodePipeline state-change events report, and event ingest joins
 * on them — so every assertion here is made against the real template.
 */

import { jest, describe, it, expect } from '@jest/globals';
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { BOOTSTRAP_DIGEST, TEST_REGISTRY, bootstrapFixture } from './helpers/bootstrap-fixture.js';
import { apiCoreMock } from './helpers/mock-api-core.js';
import type { BuilderProps } from '../src/pipeline/pipeline-builder.js';


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
const { pluginImageRepository, isBuildImageEntry } = await import('../src/core/step-manifest.js');
const { StepManifestRecorder } = await import('../src/pipeline/step-manifest-recorder.js');

function build(props: Partial<BuilderProps>) {
  const stack = new Stack(new App(), 'PbManifestStack');
  const builder = new PipelineBuilder(stack, 'Pb', {
    project: 'shop',
    organization: 'acme',
    orgId: 'org-a',
    registry: TEST_REGISTRY,
    resolvedBootstrap: bootstrapFixture(),
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

    const manifest = (builder.stepManifest as unknown as Array<Record<string, unknown>>).filter((e) => e.kind !== 'build-image');
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
      stepKey: 'Test/jest',
    });
    // Default stage alias (`<stageName>-alias`) is the CodePipeline stage name.
    expect(manifest.find((e) => e.pluginName === 'trivy')!.stageName).toBe('Scan-alias');
    // The step LABEL (`pluginStepLabel`) — the key the lookup context and the
    // platform's security view use — not the artifact alias.
    expect(manifest.find((e) => e.pluginName === 'cdk-synth')!.stepKey).toBe('synth');
    expect(manifest.find((e) => e.pluginName === 'eslint')!.stepKey).toBe('Test/lint');
  });

  it('skips steps whose plugin fell back to the synth-time placeholder', () => {
    const { builder } = build({
      // No resolvedPlugins → the synth step bootstraps (placeholder).
      stages: [{ stageName: 'Test', steps: [{ plugin: { name: 'unresolved' } }, { plugin: { name: 'jest' } }] }],
    });
    expect((builder.stepManifest as Array<{ pluginName: string }>).map((e) => e.pluginName)).toEqual(['jest', 'pipeline-bootstrap']);
  });
});

describe('build-image entry', () => {
  it('records the resolved bootstrap as one non-step entry, last, with the release it came from', () => {
    const { builder, synthesized } = build({
      resolvedBootstrap: { ...bootstrapFixture({ releaseVersion: '1.4.2' }), toolchain: { ...bootstrapFixture({ releaseVersion: '1.4.2' }).toolchain, resolvedVia: 'pin' } },
      stages: [{ stageName: 'Test', steps: [{ plugin: { name: 'jest' } }] }],
    });
    const manifest = builder.stepManifest;
    const entries = manifest.filter(isBuildImageEntry);
    expect(entries).toEqual([{
      kind: 'build-image',
      stageName: '(toolchain)',
      actionName: 'build-image',
      stepKey: 'build-image',
      pluginId: '00000000-0000-0000-0000-0000000000b0',
      pluginName: 'pipeline-bootstrap',
      pluginVersion: '1.4.2',
      imageDigest: BOOTSTRAP_DIGEST,
      releaseVersion: '1.4.2',
      imageRepository: 'system/pipeline-bootstrap',
      resolvedVia: 'pin',
    }]);
    expect(manifest[manifest.length - 1]).toBe(entries[0]);
    // Never a CodePipeline action: its (stage, action) can't collide with one.
    expect(synthesized.has('(toolchain)/build-image')).toBe(false);
    expect(manifest.filter((e) => !isBuildImageEntry(e)).every((e) => synthesized.has(`${e.stageName}/${e.actionName}`))).toBe(true);
  });

  it('a recorder with no build image (or a placeholder one) emits no build-image entry', () => {
    const recorder = new StepManifestRecorder();
    const pipeline = { stages: [] } as never;
    expect(recorder.entries(pipeline)).toEqual([]);
    recorder.recordBuildImage({ ...bootstrapFixture().plugin, id: '00000000-0000-0000-0000-000000000000' } as never, bootstrapFixture().toolchain);
    expect(recorder.entries(pipeline)).toEqual([]);
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
