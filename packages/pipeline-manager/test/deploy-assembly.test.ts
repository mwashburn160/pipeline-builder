// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * What the deploy job reads from the synthesized cloud assembly before it
 * deploys (utils/deploy-assembly.ts), and change 7's invariant: the stacks
 * this product synthesizes carry NO Docker image asset — so the runner's
 * deploy build runs unprivileged (no Docker daemon) and the runner stack needs
 * no DeployPrivileged parameter. Proved here by synthesizing real pipelines
 * through PipelineBuilder (the boilerplate's construct) in the shapes the
 * product produces, with a positive control showing the same check does see a
 * Docker asset when one exists.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from '@jest/globals';

const WORK = mkdtempSync(join(tmpdir(), 'pm-deploy-assembly-'));
process.env.HOME = WORK;
process.env.CLI_CONFIG_PATH = join(WORK, 'none.yml');
afterAll(() => rmSync(WORK, { recursive: true, force: true }));

const { App, Stack } = await import('aws-cdk-lib');
const { DockerImageAsset } = await import('aws-cdk-lib/aws-ecr-assets');
const { PipelineBuilder } = await import('@pipeline-builder/pipeline-core/cdk');
const { fetchPipelineProps } = await import('../src/utils/pipeline-config.js');
const { pipelineStackName } = await import('../src/config/cli.constants.js');
const { assemblyStack, dockerImageAssetCount, templateSecretNames } = await import('../src/utils/deploy-assembly.js');
type ApiClient = import('../src/utils/api-client.js').ApiClient;

const digest = (c: string) => `sha256:${c.repeat(64)}`;
const record = (name: string, over: Record<string, unknown> = {}) => ({
  id: `id-${name}`,
  orgId: 'system',
  name,
  version: '1.4.0',
  pluginType: name === 'cdk-synth' ? 'CodeBuildStep' : name === 'pipeline-bootstrap' ? 'BuildImage' : 'CodeBuildStep',
  buildType: 'prebuilt',
  imageDigest: digest(name.length.toString(16).slice(0, 1)),
  imageRepository: `system/${name}`,
  commands: name === 'cdk-synth' ? ['pipeline-manager pipeline synth --id ${PIPELINE_ID} --store-tokens --quiet'] : ['make test'],
  installCommands: [],
  env: {},
  metadata: {},
  secrets: [],
  primaryOutputDirectory: name === 'cdk-synth' ? 'cdk.out' : null,
  computeType: 'SMALL',
  failureBehavior: 'fail',
  ...over,
});
const lookup = (rec: Record<string, unknown>) => ({
  success: true,
  statusCode: 200,
  data: { plugin: rec, warnings: [], toolchain: { releaseVersion: '1.4.0', resolvedVia: 'default', versions: { awsCdk: '2.1148.0', cdkAssets: '4.8.0' } } },
});

/** The platform as fetchPipelineProps sees it: one pipeline, every plugin resolving. */
function platform(pipeline: Record<string, unknown>, extra: Record<string, Record<string, unknown>> = {}): ApiClient {
  return {
    getConfig: () => ({ api: { baseUrl: 'https://platform.example.com', pipelineUrl: '/api/pipelines' } }),
    get: async () => ({ success: true, data: { pipeline } }),
    post: async (_u: string, body: { filter: { name: string } }) => lookup(extra[body.filter.name] ?? record(body.filter.name)),
  } as unknown as ApiClient;
}

const source = { type: 'github', options: { repo: 'acme/shop', branch: 'main' } };
/** The pipeline shapes the product deploys: synth only; stages of plugin steps; the cdk-synth plugin's own Docker-enabled metadata; secrets. */
const SHAPES: Record<string, Record<string, unknown>> = {
  'synth only': { project: 'shop', organization: 'acme', synth: { source, plugin: { name: 'cdk-synth' } } },
  'stages of plugin steps': {
    project: 'shop',
    organization: 'acme',
    synth: { source, plugin: { name: 'cdk-synth' } },
    stages: [{ stageName: 'test', steps: [{ plugin: { name: 'unit-tests' } }] }, { stageName: 'scan', steps: [{ plugin: { name: 'secret-scan' } }] }],
  },
  'docker-enabled self-mutation and privileged steps (still no asset)': {
    project: 'shop',
    organization: 'acme',
    synth: { source, plugin: { name: 'cdk-synth' }, metadata: { 'aws:cdk:pipelines:codepipeline:dockerenabledforsynth': true } },
    stages: [{ stageName: 'build', steps: [{ plugin: { name: 'docker-build' } }] }],
  },
};

async function synthesize(props: Record<string, unknown>, extra: Record<string, Record<string, unknown>> = {}) {
  const { pipeline, propsWithIds } = await fetchPipelineProps(
    platform({ id: 'pipe-1', orgId: 'org-1', project: 'shop', organization: 'acme', props }, extra), 'pipe-1');
  const outdir = mkdtempSync(join(WORK, 'cdk.out-'));
  const app = new App({ outdir });
  const stackName = pipelineStackName(String(propsWithIds.project), String(propsWithIds.organization));
  new PipelineBuilder(new Stack(app, stackName, { env: { account: '123456789012', region: 'eu-west-2' } }), 'pipeline-builder', propsWithIds as never);
  app.synth();
  return { outdir, stackName, pipeline };
}

describe('change 7: synthesized pipelines carry no Docker image asset', () => {
  it.each(Object.entries(SHAPES))('%s', async (_n, props) => {
    const extra = { 'docker-build': record('docker-build', { metadata: { 'aws:cdk:codebuild:buildenvironment:privileged': true } }) };
    const { outdir, stackName } = await synthesize(props, extra);
    expect(dockerImageAssetCount(outdir)).toBe(0);
    // The stack is there under the name the registry records, in the region asked for.
    const stack = assemblyStack(outdir, stackName)!;
    expect(stack).toMatchObject({ stackName, region: 'eu-west-2' });
    // The stage steps really synthesized (on their registry images, pinned by digest — never built here).
    for (const st of (props.stages ?? []) as Array<{ steps: Array<{ plugin: { name: string } }> }>) {
      for (const step of st.steps) expect(JSON.stringify(stack.template)).toContain(`/system/${step.plugin.name}@sha256:`);
    }
  });

  it('positive control: the same check sees a Docker image asset when a stack has one', () => {
    const outdir = mkdtempSync(join(WORK, 'cdk.out-docker-'));
    const app = new App({ outdir });
    const stack = new Stack(app, 'WithDocker', { env: { account: '123456789012', region: 'eu-west-2' } });
    const ctx = mkdtempSync(join(WORK, 'ctx-'));
    writeFileSync(join(ctx, 'Dockerfile'), 'FROM scratch\n');
    new DockerImageAsset(stack, 'Img', { directory: ctx });
    app.synth();
    expect(dockerImageAssetCount(outdir)).toBe(1);
  });
});

describe('assemblyStack', () => {
  it('undefined for a stack name the assembly does not hold', async () => {
    const { outdir } = await synthesize(SHAPES['synth only']!);
    expect(assemblyStack(outdir, 'someone-else')).toBeUndefined();
  });
});

describe('templateSecretNames', () => {
  it('every Secrets Manager name the template makes CodeBuild read: SECRETS_MANAGER env vars, registry credentials, PLATFORM_SECRET_NAME', () => {
    const template = {
      Resources: {
        P1: {
          Type: 'AWS::CodeBuild::Project',
          Properties: {
            Environment: {
              RegistryCredential: { Credential: 'pipeline-builder/org-1/registry-push', CredentialProvider: 'SECRETS_MANAGER' },
              EnvironmentVariables: [
                { Name: 'PLATFORM_SECRET_NAME', Type: 'PLAINTEXT', Value: 'pipeline-builder/org-1/platform' },
                { Name: 'SONAR_TOKEN', Type: 'SECRETS_MANAGER', Value: 'pipeline-builder/org-1/sonar:token::' },
                { Name: 'PLAIN', Type: 'PLAINTEXT', Value: 'not-a-secret' },
              ],
            },
          },
        },
        P2: {
          Type: 'AWS::CodeBuild::Project',
          Properties: {
            Environment: {
              RegistryCredential: { Credential: { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':secretsmanager:eu-west-2:1:secret:pipeline-builder/org-1/registry-push']] } },
              EnvironmentVariables: [{ Name: 'X', Type: 'SECRETS_MANAGER', Value: 'pipeline-builder/org-1/sonar' }],
            },
          },
        },
        Other: { Type: 'AWS::S3::Bucket', Properties: {} },
      },
    };
    expect(templateSecretNames(template)).toEqual(['pipeline-builder/org-1/platform', 'pipeline-builder/org-1/registry-push', 'pipeline-builder/org-1/sonar']);
  });

  it('a real synthesized pipeline needs its org\'s registry pull credential', async () => {
    const { outdir, stackName } = await synthesize(SHAPES['synth only']!);
    const stack = assemblyStack(outdir, stackName)!;
    expect(templateSecretNames(stack.template)).toContain('pipeline-builder/org-1/registry-push');
  });
});
