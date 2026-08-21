// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for PipelineBuilder (src/pipeline/pipeline-builder.ts) — the core
 * CDK construct that assembles a real CodePipeline from high-level props.
 *
 * The one genuinely un-unit-testable dependency is PluginLookup, which stands
 * up a bundled NodejsFunction + custom resource. We stub it with a lightweight
 * Construct that returns a fully-formed Plugin, so the rest of the builder
 * (source wiring, synth step, tags, notifications, schedule, metrics alarm,
 * KMS artifact bucket, stage waves) executes for real and is asserted against
 * the synthesized CloudFormation template.
 */

import { jest, describe, it, expect } from '@jest/globals';
import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { apiCoreMock } from './helpers/mock-api-core.js';
import type { BuilderProps } from '../src/pipeline/pipeline-builder.js';

// Use an AWS-curated default build image so synth resolves the CodeBuild image
// via the curated-image path instead of the platform registry. Without this,
// the default bare-tag image ('pipeline-bootstrap:1.0') plus an orgId trips the
// (intentional) in-cluster-pull-host guardrail. Set before any Config.get('aws').
process.env.CODEBUILD_DEFAULT_IMAGE = 'aws/codebuild/standard:8.0';

// Persistent logger so synth-time warnings (last-stage attribution, pb.deploys
// overflow) can be asserted. The default mock hands each createLogger() call a
// fresh spy set, which would lose the warning before a test could inspect it.
const warnSpy = jest.fn();
const sharedLogger = { info: jest.fn(), warn: warnSpy, error: jest.fn(), debug: jest.fn() };
jest.unstable_mockModule('@pipeline-builder/api-core', () =>
  apiCoreMock({ createLogger: () => sharedLogger }),
);

// Stub the heavy PluginLookup construct (real one bundles a Lambda).
jest.unstable_mockModule('../src/pipeline/plugin-lookup.js', async () => {
  const { Construct } = await import('constructs');
  const resolvedPlugin = () => ({
    id: '00000000-0000-0000-0000-000000000000',
    orgId: 'system',
    name: 'cdk-synth',
    description: null,
    keywords: [],
    category: 'infrastructure',
    version: '1.0.0',
    metadata: {},
    pluginType: 'CodeBuildStep',
    computeType: 'SMALL',
    timeout: null,
    failureBehavior: 'fail',
    secrets: [],
    primaryOutputDirectory: 'cdk.out',
    env: {},
    buildArgs: {},
    installCommands: [],
    commands: ['npx cdk synth'],
    dockerfile: null,
    buildType: 'metadata_only',
    accessModifier: 'public',
    isDefault: false,
    isActive: true,
  });
  class PluginLookup extends Construct {
    constructor(scope: any, id: string) {
      super(scope, id);
    }
    plugin() {
      return resolvedPlugin();
    }
    bootstrap() {
      return resolvedPlugin();
    }
  }
  return { PluginLookup };
});

const { PipelineBuilder } = await import('../src/pipeline/pipeline-builder.js');
const { MetadataKeys } = await import('../src/core/pipeline-types.js');

function baseProps(overrides: Partial<BuilderProps> = {}): BuilderProps {
  return {
    project: 'my-project',
    organization: 'my-org',
    synth: {
      source: { type: 'github', options: { repo: 'acme/checkout', branch: 'main' } },
      plugin: { name: 'cdk-synth' },
    },
    ...overrides,
  } as BuilderProps;
}

function build(props: BuilderProps): { template: Template; builder: any } {
  const stack = new Stack(new App(), 'PbTestStack');
  const builder = new PipelineBuilder(stack, 'Pb', props);
  return { template: Template.fromStack(stack), builder };
}

describe('PipelineBuilder', () => {
  describe('core pipeline', () => {
    it('creates one V2 CodePipeline with the derived name and a GitHub source', () => {
      const { template, builder } = build(baseProps());

      expect(builder.config.pipelineName).toBe('my_org-my_project-pipeline');
      template.resourceCountIs('AWS::CodePipeline::Pipeline', 1);
      template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
        Name: 'my_org-my_project-pipeline',
        PipelineType: 'V2',
        Stages: Match.arrayWith([
          Match.objectLike({
            Actions: Match.arrayWith([
              Match.objectLike({
                ActionTypeId: Match.objectLike({ Category: 'Source', Provider: 'GitHub' }),
                Configuration: Match.objectLike({ Owner: 'acme', Repo: 'checkout' }),
              }),
            ]),
          }),
        ]),
      });
    });

    it('applies the operations-essential tags (and OrgId / pb.pipeline-id when provided)', () => {
      const { template } = build(baseProps({ orgId: 'org-42', pipelineId: 'pl-99' }));

      const pipelines = template.findResources('AWS::CodePipeline::Pipeline');
      const tags = (Object.values(pipelines)[0] as any).Properties.Tags;
      // CDK sorts tags by key, so assert set membership rather than order.
      expect(tags).toEqual(
        expect.arrayContaining([
          { Key: 'pipeline-builder', Value: 'true' },
          { Key: 'project', Value: 'my_project' },
          { Key: 'organization', Value: 'my_org' },
          { Key: 'OrgId', Value: 'org-42' },
          { Key: 'pb.pipeline-id', Value: 'pl-99' },
        ]),
      );
      // The old event-reporting tag name is gone (no back-compat).
      expect(tags.some((t: { Key: string }) => t.Key === 'PIPELINE_EVENT_ID')).toBe(false);
    });

    it('does not emit an OrgId tag when orgId is omitted', () => {
      const { template } = build(baseProps());
      const pipelines = template.findResources('AWS::CodePipeline::Pipeline');
      const tags = (Object.values(pipelines)[0] as any).Properties.Tags as Array<{ Key: string }>;
      expect(tags.some(t => t.Key === 'OrgId')).toBe(false);
      expect(tags.some(t => t.Key === 'pb.pipeline-id')).toBe(false);
    });

    it('derives pb.deploys from the pipeline-level environment (single-env, one stage)', () => {
      const { template } = build(baseProps({
        environment: 'production',
        stages: [{ stageName: 'Deploy-prod', steps: [{ plugin: { name: 'cdk-synth' } }] }],
      }));
      const pipelines = template.findResources('AWS::CodePipeline::Pipeline');
      const tags = (Object.values(pipelines)[0] as any).Properties.Tags;
      expect(tags).toEqual(
        expect.arrayContaining([{ Key: 'pb.deploys', Value: 'Deploy-prod:production' }]),
      );
      // The old pipeline-level Environment tag is gone (no back-compat).
      expect(tags.some((t: { Key: string }) => t.Key === 'Environment')).toBe(false);
    });

    it('falls back to a literal Deploy stage for single-env when no stage can be named', () => {
      const { template } = build(baseProps({ environment: 'production' }));
      const pipelines = template.findResources('AWS::CodePipeline::Pipeline');
      const tags = (Object.values(pipelines)[0] as any).Properties.Tags;
      expect(tags).toEqual(
        expect.arrayContaining([{ Key: 'pb.deploys', Value: 'Deploy:production' }]),
      );
    });

    it('derives pb.deploys from per-stage environment (multi-env)', () => {
      const { template } = build(baseProps({
        stages: [
          { stageName: 'Deploy-stg', environment: 'staging', steps: [{ plugin: { name: 'cdk-synth' } }] },
          { stageName: 'Build', steps: [{ plugin: { name: 'cdk-synth' } }] },
          { stageName: 'Deploy-prod', environment: 'production', steps: [{ plugin: { name: 'cdk-synth' } }] },
        ],
      }));
      const pipelines = template.findResources('AWS::CodePipeline::Pipeline');
      const tags = (Object.values(pipelines)[0] as any).Properties.Tags;
      expect(tags).toEqual(
        expect.arrayContaining([
          { Key: 'pb.deploys', Value: 'Deploy-stg:staging+Deploy-prod:production' },
        ]),
      );
    });

    it('attributes a pipeline-level environment to the LAST stage of a multi-stage pipeline (with a synth warning)', () => {
      warnSpy.mockClear();
      const { template } = build(baseProps({
        environment: 'production',
        stages: [
          { stageName: 'Build', steps: [{ plugin: { name: 'cdk-synth' } }] },
          { stageName: 'Test', steps: [{ plugin: { name: 'cdk-synth' } }] },
          { stageName: 'Ship', steps: [{ plugin: { name: 'cdk-synth' } }] },
        ],
      }));
      const pipelines = template.findResources('AWS::CodePipeline::Pipeline');
      const tags = (Object.values(pipelines)[0] as any).Properties.Tags;
      // Last stage ("Ship") is the deploy — not the never-matching literal "Deploy".
      expect(tags).toEqual(
        expect.arrayContaining([{ Key: 'pb.deploys', Value: 'Ship:production' }]),
      );
      // Synth warning recommends explicit per-stage environment.
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('attributed to the last stage'),
      );
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Ship'));
    });

    it('caps the pb.deploys tag value at 256 chars, keeping the production pair and dropping overflow (with a warning)', () => {
      warnSpy.mockClear();
      // Many per-stage-env pairs whose joined length far exceeds 256 chars.
      const many = Array.from({ length: 8 }, (_, i) => ({
        stageName: `DeployStageNumber${i}`,
        environment: `environment-region-number-${i}`,
        steps: [{ plugin: { name: 'cdk-synth' } }],
      }));
      // The production (headline) pair is LAST — it must survive the cap, first.
      many.push({
        stageName: 'ProdDeploy',
        environment: 'production',
        steps: [{ plugin: { name: 'cdk-synth' } }],
      });
      const { template } = build(baseProps({ stages: many }));
      const pipelines = template.findResources('AWS::CodePipeline::Pipeline');
      const tags = (Object.values(pipelines)[0] as any).Properties.Tags as Array<{ Key: string; Value: string }>;
      const deploys = tags.find(t => t.Key === 'pb.deploys');
      expect(deploys).toBeDefined();
      const value = deploys!.Value;
      // Never exceeds AWS's 256-char tag-value limit.
      expect(value.length).toBeLessThanOrEqual(256);
      // Headline/production pair is kept, and placed first.
      expect(value.startsWith('ProdDeploy:production')).toBe(true);
      // At least one overflow pair was dropped (fewer than all 9 pairs remain).
      expect(value.split('+').length).toBeLessThan(9);
      // A synth warning names the 256-char cap and the dropped pairs.
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('256'));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('dropped'));
    });

    it('does not emit pb.deploys or Environment when no environment is declared', () => {
      const { template } = build(baseProps());
      const pipelines = template.findResources('AWS::CodePipeline::Pipeline');
      const tags = (Object.values(pipelines)[0] as any).Properties.Tags as Array<{ Key: string }>;
      expect(tags.some(t => t.Key === 'pb.deploys')).toBe(false);
      expect(tags.some(t => t.Key === 'Environment')).toBe(false);
    });

    it('honors a custom pipeline name', () => {
      const { template, builder } = build(baseProps({ pipelineName: 'custom-pipe' } as Partial<BuilderProps>));
      expect(builder.config.pipelineName).toBe('custom-pipe');
      template.hasResourceProperties('AWS::CodePipeline::Pipeline', { Name: 'custom-pipe' });
    });
  });

  describe('stages', () => {
    it('adds a wave for each configured stage', () => {
      const { template } = build(
        baseProps({
          stages: [{ stageName: 'Test', alias: 'test-wave', steps: [{ plugin: { name: 'jest' } }] }],
        }),
      );

      template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
        Stages: Match.arrayWith([Match.objectLike({ Name: 'test-wave' })]),
      });
    });
  });

  describe('scheduled execution', () => {
    it('creates an EventBridge rule targeting the pipeline when a schedule is given', () => {
      const { template } = build(baseProps({ schedule: 'rate(1 day)' }));

      template.hasResourceProperties('AWS::Events::Rule', {
        ScheduleExpression: 'rate(1 day)',
      });
    });

    it('creates no schedule rule by default', () => {
      const { template } = build(baseProps());
      const rules = template.findResources('AWS::Events::Rule', {
        Properties: { ScheduleExpression: Match.anyValue() },
      });
      expect(Object.keys(rules)).toHaveLength(0);
    });
  });

  describe('metrics alarm', () => {
    it('creates a FailedPipelineExecutionCount alarm when metrics are enabled', () => {
      const { template } = build(
        baseProps({ global: { [MetadataKeys.ENABLE_METRICS]: true } }),
      );

      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        Namespace: 'AWS/CodePipeline',
        MetricName: 'FailedPipelineExecutionCount',
        Threshold: 1,
      });
    });

    it('creates no alarm by default', () => {
      const { template } = build(baseProps());
      template.resourceCountIs('AWS::CloudWatch::Alarm', 0);
    });
  });

  describe('KMS artifact bucket', () => {
    it('creates a KMS-encrypted artifact bucket when a key ARN is set in metadata', () => {
      const { template } = build(
        baseProps({
          global: {
            [MetadataKeys.KMS_KEY_ARN]: 'arn:aws:kms:us-east-1:123456789012:key/abcd-1234',
          },
        }),
      );

      template.hasResourceProperties('AWS::S3::Bucket', {
        BucketEncryption: {
          ServerSideEncryptionConfiguration: Match.arrayWith([
            Match.objectLike({
              ServerSideEncryptionByDefault: Match.objectLike({ SSEAlgorithm: 'aws:kms' }),
            }),
          ]),
        },
      });
    });

    it('applies a lifecycle expiration rule when artifact retention days are set', () => {
      const { template } = build(
        baseProps({ global: { [MetadataKeys.ARTIFACT_RETENTION_DAYS]: 14 } }),
      );

      template.hasResourceProperties('AWS::S3::Bucket', {
        LifecycleConfiguration: {
          Rules: Match.arrayWith([Match.objectLike({ ExpirationInDays: 14, Status: 'Enabled' })]),
        },
      });
    });
  });

  describe('SNS notifications', () => {
    it('creates a CodeStar notification rule when a topic ARN is configured', () => {
      const { template } = build(
        baseProps({
          global: {
            [MetadataKeys.NOTIFICATION_TOPIC_ARN]: 'arn:aws:sns:us-east-1:123456789012:pipe-topic',
            [MetadataKeys.NOTIFICATION_EVENTS]: 'FAILED,SUCCEEDED',
          },
        }),
      );

      template.resourceCountIs('AWS::CodeStarNotifications::NotificationRule', 1);
    });
  });
});
