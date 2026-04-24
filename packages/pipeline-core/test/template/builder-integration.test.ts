// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end integration tests: exercise resolvePluginTemplates through
 * the same code path `createCodeBuildStep` takes. The plugin's templated
 * fields (commands, installCommands, env, buildArgs, description) are
 * resolved once against a pipeline scope, and the resolved clone is what
 * downstream CDK constructs see.
 *
 * Mocks heavy CDK deps to avoid pulling the full aws-cdk-lib at test time.
 */

jest.mock('@pipeline-builder/api-core', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
  ErrorCode: {
    TEMPLATE_UNKNOWN_PATH: 'TEMPLATE_UNKNOWN_PATH',
    TEMPLATE_CYCLE: 'TEMPLATE_CYCLE',
    TEMPLATE_PARSE_ERROR: 'TEMPLATE_PARSE_ERROR',
    TEMPLATE_TYPE_MISMATCH: 'TEMPLATE_TYPE_MISMATCH',
    TEMPLATE_SECRETS_RESERVED: 'TEMPLATE_SECRETS_RESERVED',
    TEMPLATE_CONTRACT_VIOLATION: 'TEMPLATE_CONTRACT_VIOLATION',
    TEMPLATE_SIZE_EXCEEDED: 'TEMPLATE_SIZE_EXCEEDED',
    TEMPLATE_VALIDATION_FAILED: 'TEMPLATE_VALIDATION_FAILED',
  },
}));

import type { Plugin } from '@pipeline-builder/pipeline-data';
import { resolvePluginTemplates } from '../../src/template/plugin-resolver';

function mkPlugin(overrides: Partial<Plugin> = {}): Plugin {
  return {
    id: 'p1',
    orgId: 'acmecorp',
    name: 'kubectl-deploy',
    version: '1.0.0',
    description: 'Deploy to k8s',
    pluginType: 'CodeBuildStep',
    computeType: 'SMALL',
    imageTag: 'p-kubectl-abc',
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

const pipelineScope = {
  pipeline: {
    projectName: 'checkout',
    orgId: 'acmecorp',
    metadata: { env: 'prod', region: 'us-east-1', replicas: 3, namespace: 'checkout-prod' },
    vars: { branch: 'main', slackChannel: '#deploys-prod' },
  },
};

describe('Builder integration: plugin template resolution', () => {
  it('resolves a kubectl-deploy-style plugin end-to-end', () => {
    const plugin = mkPlugin({
      description: 'Deploy to {{ pipeline.metadata.env }}',
      env: {
        NAMESPACE: '{{ pipeline.metadata.namespace }}',
        REGION: '{{ pipeline.metadata.region }}',
      },
      installCommands: ['aws eks update-kubeconfig --name acme-eks-{{ pipeline.metadata.env }}'],
      commands: [
        'kubectl apply -f k8s/{{ pipeline.metadata.env }}/',
        'kubectl scale deployment {{ pipeline.projectName }} --replicas={{ pipeline.metadata.replicas }}',
      ],
    });

    const resolved = resolvePluginTemplates(plugin, pipelineScope);

    expect(resolved.description).toBe('Deploy to prod');
    expect(resolved.env).toEqual({ NAMESPACE: 'checkout-prod', REGION: 'us-east-1' });
    expect(resolved.installCommands).toEqual(['aws eks update-kubeconfig --name acme-eks-prod']);
    expect(resolved.commands).toEqual([
      'kubectl apply -f k8s/prod/',
      'kubectl scale deployment checkout --replicas=3',
    ]);
  });

  it('resolves a slack-notify-style plugin with vars', () => {
    const plugin = mkPlugin({
      name: 'slack-notify',
      commands: ['curl -X POST "$WEBHOOK" -d \'{"channel":"{{ pipeline.vars.slackChannel }}","text":"{{ pipeline.projectName }} deployed to {{ pipeline.metadata.env }}"}\''],
    });

    const resolved = resolvePluginTemplates(plugin, pipelineScope);
    expect(resolved.commands![0]).toContain('"channel":"#deploys-prod"');
    expect(resolved.commands![0]).toContain('checkout deployed to prod');
  });

  it('resolves a docker-build-style plugin with buildArgs', () => {
    const plugin = mkPlugin({
      name: 'docker-build-push',
      buildArgs: {
        BUILD_ENV: '{{ pipeline.metadata.env }}',
        COMMIT_SHA: '$CODEBUILD_RESOLVED_SOURCE_VERSION', // runtime literal
      },
      commands: ['docker build --build-arg BUILD_ENV=$BUILD_ENV -t {{ pipeline.projectName }}:latest .'],
    });

    const resolved = resolvePluginTemplates(plugin, pipelineScope);
    expect(resolved.buildArgs).toEqual({
      BUILD_ENV: 'prod',
      COMMIT_SHA: '$CODEBUILD_RESOLVED_SOURCE_VERSION', // passed through literally
    });
    expect(resolved.commands).toEqual(['docker build --build-arg BUILD_ENV=$BUILD_ENV -t checkout:latest .']);
  });

  it('leaves a plugin with zero template tokens untouched', () => {
    const plugin = mkPlugin({
      commands: ['plain command'],
      env: { STAGE: 'literal' },
      installCommands: ['echo literal'],
    });

    const resolved = resolvePluginTemplates(plugin, pipelineScope);
    expect(resolved.commands).toEqual(['plain command']);
    expect(resolved.env).toEqual({ STAGE: 'literal' });
    expect(resolved.installCommands).toEqual(['echo literal']);
  });

  it('throws with field + path info on unknown template path', () => {
    const plugin = mkPlugin({ commands: ['echo {{ pipeline.nope }}'] });
    expect(() => resolvePluginTemplates(plugin, pipelineScope)).toThrow(/Template resolution failed in plugin "kubectl-deploy"/);
  });

  it('does not mutate the input plugin (structured-clone)', () => {
    const plugin = mkPlugin({
      commands: ['{{ pipeline.projectName }}'],
      env: { A: '{{ pipeline.metadata.env }}' },
    });
    const sourceSnapshot = JSON.stringify(plugin);
    resolvePluginTemplates(plugin, pipelineScope);
    expect(JSON.stringify(plugin)).toBe(sourceSnapshot);
  });
});
