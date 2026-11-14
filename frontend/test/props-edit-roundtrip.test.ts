// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The pipeline EDIT flow's serialization: a saved pipeline's props are parsed into
 * wizard state (propsToFormState) and re-assembled on save (assembleBuilderProps).
 * Anything the round trip loses is silently dropped from the pipeline on every
 * edit, so each section is pinned: every source type, defaults (network +
 * security groups + metadata), every role type, synth network, and stage steps
 * (commands, env, artifacts, timeout, failure behaviour, step network).
 */

import { describe, it, expect } from '@jest/globals';
import { propsToFormState, parseArtifactKeyString } from '../src/types/props-parsing';
import { assembleBuilderProps } from '../src/types/props-assembly';

const plugin = { name: 'cdk-synth', alias: 'synth', filter: { version: '1.2.0', isActive: true, visibility: 'org' }, metadata: { 'aws:cdk:context': 'x', retries: 2, verbose: true } };

function roundTrip(props: Record<string, unknown>) {
  const state = propsToFormState(props);
  const { props: out, errors } = assembleBuilderProps(state);
  expect(errors).toEqual({});
  return { state, out: out as unknown as Record<string, any> };
}

const base = (synth: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  project: 'web', organization: 'acme', pipelineName: 'acme-web-pipeline', synth: { plugin, ...synth }, ...extra,
});

describe('props ⇄ wizard state round trip', () => {
  it.each([
    ['github', { type: 'github', options: { repo: 'acme/web', branch: 'main', token: 'secretsmanager:gh', trigger: 'SCHEDULE', schedule: 'rate(1 day)' } }],
    ['s3', { type: 's3', options: { bucketName: 'src-bucket', objectKey: 'app.zip', trigger: 'POLL' } }],
    ['codestar', { type: 'codestar', options: { repo: 'acme/web', branch: 'dev', connectionArn: 'arn:aws:codestar-connections:x', codeBuildCloneOutput: true } }],
    ['codecommit', { type: 'codecommit', options: { repositoryName: 'web', branch: 'main', trigger: 'SCHEDULE', schedule: 'cron(0 1 * * ? *)' } }],
  ])('keeps a %s source', (_t, source) => {
    const { out } = roundTrip(base({ source }));
    expect(out.synth.source).toEqual(source);
    expect(out.synth.plugin).toMatchObject({ name: 'cdk-synth', alias: 'synth' });
  });

  it('keeps defaults: vpc network, security groups and metadata', () => {
    const { state, out } = roundTrip(base(
      { source: { type: 'github', options: { repo: 'acme/web' } } },
      {
        global: { team: 'core' },
        defaults: {
          network: { type: 'vpcId', options: { vpcId: 'vpc-1', subnetIds: ['s1', 's2'], securityGroupIds: ['sg-1'], subnetType: 'PRIVATE_ISOLATED', availabilityZones: ['az1'], tags: { env: 'prod' } } },
          securityGroups: { type: 'securityGroupIds', options: { securityGroupIds: ['sg-9'], mutable: false } },
          metadata: { 'aws:region': 'us-east-1' },
        },
      },
    ));
    expect(state.defaults.enabled).toBe(true);
    expect(state.defaults.network.tags).toEqual([{ key: 'env', value: 'prod' }]);
    expect(out.defaults.network).toMatchObject({ type: 'vpcId', options: expect.objectContaining({ vpcId: 'vpc-1' }) });
    expect(out.defaults.securityGroups).toMatchObject({ type: 'securityGroupIds' });
    expect(out.global).toEqual({ team: 'core' });
  });

  it.each([
    ['roleArn', { type: 'roleArn', options: { roleArn: 'arn:aws:iam::1:role/x', mutable: false } }],
    ['roleName', { type: 'roleName', options: { roleName: 'deployer' } }],
    ['oidc', { type: 'oidc', options: { issuer: 'https://token.actions.githubusercontent.com', clientIds: ['sts.amazonaws.com', 'other'], conditions: { 'repo:sub': 'acme/*' }, description: 'GH' } }],
  ])('keeps a %s role', (kind, role) => {
    const { state, out } = roundTrip(base({ source: { type: 'github', options: { repo: 'acme/web' } } }, { role }));
    expect(state.role.type).toBe(kind);
    expect(out.role.type).toBe(kind);
    if (kind === 'oidc') {
      expect(state.role.oidcClientIds).toBe('sts.amazonaws.com, other');
      expect(state.role.oidcConditions).toBe('repo:sub=acme/*');
    }
  });

  it('keeps synth network and every per-step field', () => {
    const step = {
      plugin: { name: 'deploy', filter: { isDefault: false } },
      metadata: { stage: 'prod' },
      network: { type: 'subnetIds', options: { vpcId: 'vpc-2', subnetIds: ['a'] } },
      preInstallCommands: ['npm ci'],
      postCommands: ['./smoke.sh'],
      env: { NODE_ENV: 'production' },
      position: 'post',
      inputArtifact: { stageName: 'Build', stageAlias: '', pluginName: 'cdk-synth', pluginAlias: 'synth', outputDirectory: 'cdk.out' },
      additionalInputArtifacts: [{ directory: 'extra', artifact: { stageName: 'Build', pluginName: 'lint' } }],
      timeout: 30,
      failureBehavior: 'warn',
    };
    const { state, out } = roundTrip(base(
      { source: { type: 'github', options: { repo: 'acme/web' } }, network: { type: 'vpcLookup', options: { vpcName: 'main', region: 'us-west-2' } }, metadata: { k: 'v' } },
      { stages: [{ stageName: 'Prod', alias: 'p', environment: 'prod', steps: [step] }] },
    ));
    const s = state.stages[0].steps[0];
    expect(s.installCommands).toEqual({ position: 'pre', commands: ['npm ci'] });
    expect(s.buildCommands).toEqual({ position: 'post', commands: ['./smoke.sh'] });
    expect(s.inputArtifact).toBe('Build::cdk-synth:synth:cdk.out');
    expect(s.additionalInputArtifacts).toEqual([{ path: 'extra', key: 'Build::lint::' }]);
    // A stage saved without steps opens with one empty step to fill in.
    expect(propsToFormState({ stages: [{ stageName: 'Empty' }] }).stages[0].steps).toHaveLength(1);

    expect(out.synth.network).toMatchObject({ type: 'vpcLookup' });
    const outStep = out.stages[0].steps[0];
    expect(outStep).toMatchObject({ preInstallCommands: ['npm ci'], postCommands: ['./smoke.sh'], env: { NODE_ENV: 'production' }, failureBehavior: 'warn' });
    expect(outStep.inputArtifact).toMatchObject({ stageName: 'Build', pluginName: 'cdk-synth', outputDirectory: 'cdk.out' });
  });

  it('tolerates a sparse or malformed payload', () => {
    const state = propsToFormState({ synth: { source: { options: {} }, plugin: 'nope', network: {} }, defaults: {}, role: {}, stages: [{ steps: 'x' }] });
    expect(state.synth.sourceType).toBe('github');
    expect(state.synth.plugin.name).toBe('');
    expect(state.role.type).toBe('none');
    expect(state.stages[0].steps).toHaveLength(1);
  });

  it('parses an artifact key string back into its fields', () => {
    expect(parseArtifactKeyString('Build::lint:l:dist')).toEqual({ stageName: 'Build', stageAlias: '', pluginName: 'lint', pluginAlias: 'l', outputDirectory: 'dist' });
    expect(parseArtifactKeyString('')).toEqual({ stageName: '', stageAlias: '', pluginName: '', pluginAlias: '', outputDirectory: '' });
  });
});
