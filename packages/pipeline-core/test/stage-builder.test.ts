// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for StageBuilder (src/pipeline/stage-builder.ts): the orchestration
 * layer that resolves stage step configs into CodeBuild steps and adds them as
 * waves. `createCodeBuildStep` (the heavy CDK leaf) is mocked so we can assert
 * StageBuilder's own logic precisely: pre/post partitioning, alias defaulting,
 * metadata merge order, timeout/failure fallback, and artifact guards. `merge`
 * is preserved with its real (Object.assign) semantics.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { App, Stack } from 'aws-cdk-lib';
import { apiCoreMock } from './helpers/mock-api-core.js';
import type { StageOptions } from '../src/pipeline/step-types.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

// Mock the heavy CDK leaf; keep merge real (last-wins Object.assign).
const createCodeBuildStepMock = jest.fn(
  (opts: Record<string, unknown>) => ({ __step: true, id: opts.id, opts }),
);
jest.unstable_mockModule('../src/core/pipeline-helpers.js', () => ({
  createCodeBuildStep: createCodeBuildStepMock,
  merge: (...sources: Array<Record<string, unknown>>) => Object.assign({}, ...sources),
  // Real-equivalent: scan/security categories pin to 'fail', else the authored value.
  resolveFailureBehavior: (category?: string, authored?: string) =>
    (category && /scan|security|sast|dast|vuln|secret/i.test(category) ? 'fail' : (authored ?? 'fail')),
  // Referenced by infrastructure-config (pulled in transitively via app-config).
  getComputeType: () => 'BUILD_GENERAL1_SMALL',
}));

const { StageBuilder } = await import('../src/pipeline/stage-builder.js');
const { UniqueId } = await import('../src/core/id-generator.js');

function mockPlugin(overrides: Record<string, unknown> = {}) {
  return {
    name: 'resolved-plugin',
    timeout: 45,
    failureBehavior: 'warn',
    metadata: {},
    ...overrides,
  };
}

function makeBuilder(opts: {
  globalMetadata?: Record<string, unknown>;
  artifactManager?: unknown;
  pluginResolver?: (ref: unknown) => unknown;
} = {}) {
  const pluginLookup = {
    plugin: jest.fn((ref: unknown) => (opts.pluginResolver ? opts.pluginResolver(ref) : mockPlugin())),
  };
  const scope = new Stack(new App(), 'StageTestStack');
  const builder = new StageBuilder({
    scope,
    pluginLookup: pluginLookup as any,
    uniqueId: new UniqueId({ organization: 'acme', project: 'checkout' }),
    globalMetadata: (opts.globalMetadata ?? {}) as any,
    artifactManager: opts.artifactManager as any,
    orgId: 'org-123',
    pipelineScope: { pipeline: { projectName: 'checkout' } },
  });
  const pipeline = { addWave: jest.fn() };
  return { builder, pipeline, pluginLookup };
}

beforeEach(() => {
  createCodeBuildStepMock.mockClear();
});

describe('StageBuilder.addStage', () => {
  it('partitions steps into pre (default) and post waves', () => {
    const { builder, pipeline } = makeBuilder();
    const stage: StageOptions = {
      stageName: 'Deploy',
      steps: [
        { plugin: { name: 'lint' } }, // default -> pre
        { plugin: { name: 'smoke' }, position: 'post' },
        { plugin: { name: 'build' }, position: 'pre' },
      ],
    };

    builder.addStage(pipeline as any, stage);

    expect(pipeline.addWave).toHaveBeenCalledTimes(1);
    const [alias, waveOpts] = pipeline.addWave.mock.calls[0] as [string, any];
    expect(alias).toBe('Deploy-alias'); // alias defaults to `${stageName}-alias`
    expect(waveOpts.pre).toHaveLength(2);
    expect(waveOpts.post).toHaveLength(1);
  });

  it('omits the pre/post keys when a partition is empty', () => {
    const { builder, pipeline } = makeBuilder();
    const stage: StageOptions = {
      stageName: 'PostOnly',
      steps: [{ plugin: { name: 'notify' }, position: 'post' }],
    };

    builder.addStage(pipeline as any, stage);

    const waveOpts = (pipeline.addWave.mock.calls[0] as [string, any])[1];
    expect(waveOpts.post).toHaveLength(1);
    expect('pre' in waveOpts).toBe(false);
  });

  it('uses the explicit stage alias when provided', () => {
    const { builder, pipeline } = makeBuilder();
    builder.addStage(pipeline as any, {
      stageName: 'Integration Tests',
      alias: 'integration',
      steps: [{ plugin: { name: 't' } }],
    });

    expect((pipeline.addWave.mock.calls[0] as [string, any])[0]).toBe('integration');
  });

  it('merges metadata in order: global < plugin-ref < step', () => {
    const { builder, pipeline } = makeBuilder({
      globalMetadata: { A: 'global', B: 'global', C: 'global' },
    });

    builder.addStage(pipeline as any, {
      stageName: 'S',
      steps: [
        {
          plugin: { name: 'p', metadata: { B: 'plugin-ref', C: 'plugin-ref' } },
          metadata: { C: 'step' },
        },
      ],
    });

    const passed = createCodeBuildStepMock.mock.calls[0][0] as any;
    expect(passed.metadata).toEqual({ A: 'global', B: 'plugin-ref', C: 'step' });
  });

  it('registers artifacts under the CANONICAL alias segment every key consumer builds', () => {
    // `alias || ${name}-alias` — what the UI picker, the CLI pre-resolver and
    // PluginLookup.normalize all use. This test used to lock in the bare name
    // (`bare`), which is exactly the key the picker never asked for: any step
    // whose input artifact came from an unaliased step failed synth with
    // "No artifact registered".
    const { builder, pipeline } = makeBuilder();
    builder.addStage(pipeline as any, {
      stageName: 'S',
      steps: [
        { plugin: { name: 'bare' } },
        { plugin: { name: 'e2e', alias: 'cypress' } },
      ],
    });

    const aliases = createCodeBuildStepMock.mock.calls.map(c => (c[0] as any).pluginAlias);
    expect(aliases).toEqual(['bare-alias', 'cypress']);
  });

  it('keeps the step CONSTRUCT id on the old alias rule, so no CodeBuild project is replaced', () => {
    // The construct id feeds the CloudFormation logical id. Moving it to the
    // artifact rule would rename every unaliased step's project and make CFN
    // replace it on the next deploy, for no gain — the ids stay put.
    const { builder, pipeline } = makeBuilder();
    builder.addStage(pipeline as any, {
      stageName: 'S',
      steps: [{ plugin: { name: 'bare' } }],
    });

    const id = (createCodeBuildStepMock.mock.calls[0][0] as any).id as string;
    expect(id).toContain('bare');
    expect(id).not.toContain('bare-alias');
  });

  it('falls back to the plugin timeout and failureBehavior when the step omits them', () => {
    const { builder, pipeline } = makeBuilder({
      pluginResolver: () => mockPlugin({ timeout: 99, failureBehavior: 'ignore' }),
    });

    builder.addStage(pipeline as any, {
      stageName: 'S',
      steps: [
        { plugin: { name: 'a' } }, // inherits plugin defaults
        { plugin: { name: 'b' }, timeout: 5, failureBehavior: 'fail' }, // step overrides win
      ],
    });

    const first = createCodeBuildStepMock.mock.calls[0][0] as any;
    const second = createCodeBuildStepMock.mock.calls[1][0] as any;
    expect(first.timeout).toBe(99);
    expect(first.failureBehavior).toBe('ignore');
    expect(second.timeout).toBe(5);
    expect(second.failureBehavior).toBe('fail');
  });

  describe('artifact guards', () => {
    it('throws when a step needs inputArtifact but no artifactManager is configured', () => {
      const { builder, pipeline } = makeBuilder(); // no artifactManager
      expect(() =>
        builder.addStage(pipeline as any, {
          stageName: 'S',
          steps: [{ plugin: { name: 'consumer' }, inputArtifact: { outputDirectory: 'dist' } as any }],
        }),
      ).toThrow(/requires inputArtifact but no artifactManager is configured/);
    });

    it('throws when a step needs additionalInputArtifacts but no artifactManager is configured', () => {
      const { builder, pipeline } = makeBuilder();
      expect(() =>
        builder.addStage(pipeline as any, {
          stageName: 'S',
          steps: [
            {
              plugin: { name: 'consumer' },
              additionalInputArtifacts: [{ artifact: { outputDirectory: 'dist' } as any }],
            },
          ],
        }),
      ).toThrow(/requires additionalInputArtifacts but no artifactManager is configured/);
    });

    it('resolves inputArtifact + additionalInputs through the artifactManager', () => {
      const getOutput = jest.fn((key: { outputDirectory: string }) => ({ __fileset: key.outputDirectory }));
      const { builder, pipeline } = makeBuilder({ artifactManager: { getOutput } });

      builder.addStage(pipeline as any, {
        stageName: 'S',
        steps: [
          {
            plugin: { name: 'consumer' },
            inputArtifact: { outputDirectory: 'build-out' } as any,
            additionalInputArtifacts: [
              { artifact: { outputDirectory: 'assets' } as any, directory: 'web' },
              { artifact: { outputDirectory: 'reports' } as any }, // directory defaults to outputDirectory
            ],
          },
        ],
      });

      const passed = createCodeBuildStepMock.mock.calls[0][0] as any;
      expect(passed.input).toEqual({ __fileset: 'build-out' });
      expect(passed.additionalInputs).toEqual({
        web: { __fileset: 'assets' },
        reports: { __fileset: 'reports' },
      });
      expect(getOutput).toHaveBeenCalledTimes(3);
    });
  });
});

describe('StageBuilder.addStages', () => {
  it('adds each stage as a wave, in order', () => {
    const { builder, pipeline } = makeBuilder();
    builder.addStages(pipeline as any, [
      { stageName: 'One', steps: [{ plugin: { name: 'a' } }] },
      { stageName: 'Two', steps: [{ plugin: { name: 'b' } }] },
    ]);

    expect(pipeline.addWave).toHaveBeenCalledTimes(2);
    expect((pipeline.addWave.mock.calls[0] as [string, any])[0]).toBe('One-alias');
    expect((pipeline.addWave.mock.calls[1] as [string, any])[0]).toBe('Two-alias');
  });
});

describe('StageBuilder — run-time vulnerability check (report-only)', () => {
  const DIGEST = `sha256:${'b'.repeat(64)}`;
  function checkBuilder(runtimeVulnCheck?: { platformSecretName: string }) {
    const scope = new Stack(new App(), 'RvcStack');
    const builder = new StageBuilder({
      scope,
      pluginLookup: { plugin: (ref: { name: string }) => mockPlugin({ name: ref.name, imageDigest: ref.name === 'meta' ? null : DIGEST, buildType: ref.name === 'meta' ? 'metadata_only' : 'build_image' }) } as any,
      uniqueId: new UniqueId({ organization: 'acme', project: 'checkout' }),
      globalMetadata: {} as any,
      orgId: 'org-123',
      pipelineScope: { pipeline: { projectName: 'checkout' } },
      ...(runtimeVulnCheck && { runtimeVulnCheck }),
    });
    return { builder, pipeline: { addWave: jest.fn() } };
  }

  it('adds one verify step per stage carrying the image-backed steps, without gating them', () => {
    const { builder, pipeline } = checkBuilder({ platformSecretName: 'pipeline-builder/org-123/platform' });
    builder.addStage(pipeline as any, {
      stageName: 'Build',
      steps: [{ plugin: { name: 'trivy' } }, { plugin: { name: 'meta' } }, { plugin: { name: 'smoke' }, position: 'post' }],
    });
    const waveOpts = (pipeline.addWave.mock.calls[0] as [string, any])[1];
    expect(waveOpts.pre).toHaveLength(3);
    const verify = waveOpts.pre[0];
    expect(verify.commands.join(' ')).toContain('pipeline-manager plugin verify --pipeline-id "${PIPELINE_ID}" --store-tokens');
    const env = (verify as any).buildEnvironment.environmentVariables.PB_VERIFY_STEPS.value as string;
    expect(JSON.parse(env)).toEqual([
      { stepKey: 'Build/trivy', imageDigest: DIGEST },
      { stepKey: 'Build/smoke', imageDigest: DIGEST },
    ]);
    // Visibility, never a gate: nothing waits on the verify step.
    for (const step of [...waveOpts.pre.slice(1), ...waveOpts.post]) {
      expect((step as { dependencies?: unknown[] }).dependencies ?? []).toHaveLength(0);
    }
  });

  it('adds nothing when the pipeline did not opt in', () => {
    const { builder, pipeline } = checkBuilder();
    builder.addStage(pipeline as any, { stageName: 'Build', steps: [{ plugin: { name: 'trivy' } }] });
    expect((pipeline.addWave.mock.calls[0] as [string, any])[1].pre).toHaveLength(1);
  });

  it('adds nothing for a stage with no image-backed step', () => {
    const { builder, pipeline } = checkBuilder({ platformSecretName: 'p' });
    builder.addStage(pipeline as any, { stageName: 'Meta', steps: [{ plugin: { name: 'meta' } }] });
    expect((pipeline.addWave.mock.calls[0] as [string, any])[1].pre).toHaveLength(1);
  });
});
