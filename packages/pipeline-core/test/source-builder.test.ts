// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for SourceBuilder (src/pipeline/source-builder.ts): it maps each
 * pipeline source type (S3 / GitHub / CodeStar / CodeCommit) into a real
 * CodePipelineSource. Because the produced source only becomes observable
 * infrastructure once wired into a CodePipeline, each test builds a minimal
 * CodePipeline around the source and asserts the synthesized CloudFormation
 * Source action via the CDK assertions library.
 */

import { jest, describe, it, expect } from '@jest/globals';
import { App, SecretValue, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { CodePipeline, ShellStep } from 'aws-cdk-lib/pipelines';
import { apiCoreMock } from './helpers/mock-api-core.js';
import type { BuilderProps } from '../src/pipeline/pipeline-builder.js';

// Stable warn spy so the plaintext-token opt-in warning is assertable (the
// default loggerMock hands out fresh spies per createLogger() call).
const warnSpy = jest.fn();
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  createLogger: () => ({ info: jest.fn(), warn: warnSpy, error: jest.fn(), debug: jest.fn() }),
}));

const { PipelineConfiguration } = await import('../src/pipeline/pipeline-configuration.js');
const { SourceBuilder } = await import('../src/pipeline/source-builder.js');
const { UniqueId } = await import('../src/core/id-generator.js');

/**
 * Build a source via SourceBuilder, wire it into a minimal CodePipeline, and
 * return the synthesized CloudFormation Template for assertion.
 */
function synthSource(source: BuilderProps['synth']['source']): Template {
  const stack = new Stack(new App(), 'SourceTestStack', {
    env: { account: '123456789012', region: 'us-east-1' },
  });
  const config = new PipelineConfiguration({
    project: 'checkout',
    organization: 'acme',
    synth: { source, plugin: { name: 'cdk-synth' } },
  } as BuilderProps);

  const builder = new SourceBuilder(stack, config);
  const uid = new UniqueId({ organization: 'acme', project: 'checkout' });
  const cpSource = builder.create(uid);

  const pipeline = new CodePipeline(stack, 'Pipeline', {
    synth: new ShellStep('Synth', {
      input: cpSource,
      commands: ['npx cdk synth'],
      primaryOutputDirectory: 'cdk.out',
    }),
  });
  pipeline.buildPipeline();

  return Template.fromStack(stack);
}

/** Assert the pipeline has a Source action matching the given ActionTypeId/Configuration. */
function expectSourceAction(
  template: Template,
  provider: string,
  configuration: Record<string, unknown>,
): void {
  template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
    Stages: Match.arrayWith([
      Match.objectLike({
        Actions: Match.arrayWith([
          Match.objectLike({
            ActionTypeId: Match.objectLike({ Category: 'Source', Provider: provider }),
            Configuration: Match.objectLike(configuration),
          }),
        ]),
      }),
    ]),
  });
}

describe('SourceBuilder', () => {
  describe('GitHub source', () => {
    it('maps repo/branch and enables polling for an AUTO trigger', () => {
      const template = synthSource({
        type: 'github',
        options: { repo: 'acme/checkout', branch: 'develop', trigger: 'AUTO' as any },
      });

      expectSourceAction(template, 'GitHub', {
        Owner: 'acme',
        Repo: 'checkout',
        Branch: 'develop',
        PollForSourceChanges: true,
      });
    });

    it('defaults branch to main and disables polling when trigger is NONE', () => {
      const template = synthSource({
        type: 'github',
        options: { repo: 'acme/checkout' },
      });

      expectSourceAction(template, 'GitHub', {
        Owner: 'acme',
        Repo: 'checkout',
        Branch: 'main',
        PollForSourceChanges: false,
      });
    });

    describe('token authentication', () => {
      const RAW_TOKEN = 'ghp_supersecretrawtoken1234567890';

      it('resolves a Secrets Manager ARN token to a reference, not plaintext', () => {
        const arn = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:github-token-AbCdEf';
        const template = synthSource({
          type: 'github',
          options: { repo: 'acme/checkout', token: arn as any },
        });

        // Only the resolvable reference — never the secret value — is embedded.
        const json = JSON.stringify(template.toJSON());
        expect(json).toContain('{{resolve:secretsmanager:');
        expect(json).toContain(arn);
        expectSourceAction(template, 'GitHub', {
          OAuthToken: `{{resolve:secretsmanager:${arn}:SecretString:::}}`,
        });
      });

      it('resolves a `secretsmanager:<name>` shorthand token to a reference', () => {
        const template = synthSource({
          type: 'github',
          options: { repo: 'acme/checkout', token: 'secretsmanager:github-token' as any },
        });

        const json = JSON.stringify(template.toJSON());
        expect(json).toContain('{{resolve:secretsmanager:github-token:SecretString:::}}');
        // The raw shorthand string itself is not what gets embedded verbatim.
        expect(json).not.toContain('"secretsmanager:github-token"');
      });

      it('passes a SecretValue token through as a reference (no plaintext)', () => {
        const template = synthSource({
          type: 'github',
          options: {
            repo: 'acme/checkout',
            token: SecretValue.secretsManager('github-token') as any,
          },
        });

        const json = JSON.stringify(template.toJSON());
        expect(json).toContain('{{resolve:secretsmanager:github-token:SecretString:::}}');
        expect(json).not.toContain(RAW_TOKEN);
      });

      it('rejects a genuine raw plaintext token by default', () => {
        expect(() => synthSource({
          type: 'github',
          options: { repo: 'acme/checkout', token: RAW_TOKEN as any },
        })).toThrow(/raw plaintext value/i);
      });

      it('embeds a raw token only behind the allowPlainTextToken opt-in, with a warning', () => {
        warnSpy.mockClear();
        const template = synthSource({
          type: 'github',
          options: {
            repo: 'acme/checkout',
            token: RAW_TOKEN as any,
            allowPlainTextToken: true as any,
          },
        });

        expect(JSON.stringify(template.toJSON())).toContain(RAW_TOKEN);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('PLAINTEXT'));
      });

      it('falls back to the CDK default github-token secret reference when no token is provided', () => {
        const template = synthSource({
          type: 'github',
          options: { repo: 'acme/checkout' },
        });

        // No explicit token → CDK's own default, which is itself a Secrets Manager
        // reference (`github-token`), never an embedded plaintext value.
        const json = JSON.stringify(template.toJSON());
        expect(json).toContain('{{resolve:secretsmanager:github-token:SecretString:::}}');
        expect(json).not.toContain(RAW_TOKEN);
      });
    });
  });

  describe('S3 source', () => {
    it('maps bucket + default object key with polling disabled', () => {
      const template = synthSource({
        type: 's3',
        options: { bucketName: 'my-source-bucket' },
      });

      expectSourceAction(template, 'S3', {
        S3Bucket: 'my-source-bucket',
        S3ObjectKey: 'source.zip',
        PollForSourceChanges: false,
      });
    });

    it('uses EventBridge (S3Trigger.EVENTS) for an AUTO trigger', () => {
      const template = synthSource({
        type: 's3',
        options: { bucketName: 'my-source-bucket', trigger: 'AUTO' as any },
      });

      // EVENTS wires an EventBridge rule that starts the pipeline on object change.
      template.resourceCountIs('AWS::Events::Rule', 1);
      expectSourceAction(template, 'S3', { PollForSourceChanges: false });
    });

    it('disables source triggers (S3Trigger.NONE) for a SCHEDULE trigger', () => {
      const template = synthSource({
        type: 's3',
        options: { bucketName: 'my-source-bucket', trigger: 'SCHEDULE' as any },
      });

      // NONE means no source-level EventBridge rule (the schedule rule, if any,
      // is created by PipelineBuilder, not the source).
      template.resourceCountIs('AWS::Events::Rule', 0);
      expectSourceAction(template, 'S3', { PollForSourceChanges: false });
    });
  });

  describe('CodeStar connection source', () => {
    it('maps connection ARN, full repository id, and branch', () => {
      const arn = 'arn:aws:codestar-connections:us-east-1:123456789012:connection/abc-123';
      const template = synthSource({
        type: 'codestar',
        options: { repo: 'acme/checkout', branch: 'release', connectionArn: arn },
      });

      expectSourceAction(template, 'CodeStarSourceConnection', {
        ConnectionArn: arn,
        FullRepositoryId: 'acme/checkout',
        BranchName: 'release',
      });
    });
  });

  describe('CodeCommit source', () => {
    it('maps repository name and defaults branch to main', () => {
      const template = synthSource({
        type: 'codecommit',
        options: { repositoryName: 'checkout-repo' },
      });

      expectSourceAction(template, 'CodeCommit', {
        RepositoryName: 'checkout-repo',
        BranchName: 'main',
      });
    });
  });

  describe('unsupported source', () => {
    it('throws for an unknown source type', () => {
      const stack = new Stack(new App(), 'Bad');
      const config = new PipelineConfiguration({
        project: 'p',
        organization: 'o',
        synth: { source: { type: 's3', options: { bucketName: 'b' } }, plugin: { name: 'x' } },
      } as BuilderProps);
      // Force an unsupported source type past the type system.
      (config as unknown as { source: unknown }).source = { type: 'svn', options: {} };
      const builder = new SourceBuilder(stack, config);
      const uid = new UniqueId({ organization: 'o', project: 'p' });

      expect(() => builder.create(uid)).toThrow('Unsupported source type: svn');
    });
  });
});
