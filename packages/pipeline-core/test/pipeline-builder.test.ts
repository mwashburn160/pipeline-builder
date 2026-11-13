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
import { BOOTSTRAP_DIGEST, TEST_AWS_CDK, TEST_CDK_ASSETS, TEST_REGISTRY, bootstrapFixture } from './helpers/bootstrap-fixture.js';
import { apiCoreMock } from './helpers/mock-api-core.js';
import type { BuilderProps } from '../src/pipeline/pipeline-builder.js';


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
    visibility: 'public',
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
    orgId: 'org-1',
    registry: TEST_REGISTRY,
    resolvedBootstrap: bootstrapFixture(),
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

    it('platform tags win over a caller trying to redefine them', () => {
      // `Tags.of` lets a later add replace an earlier one, and props.tags used
      // to be applied AFTER the platform tags — so a caller could set
      // pb.pipeline-id or OrgId and point another org's executions at their own
      // pipeline, since the events Lambda attributes by exactly those tags.
      const { template } = build(baseProps({
        orgId: 'org-42',
        pipelineId: 'pl-99',
        tags: { 'OrgId': 'org-ATTACKER', 'pb.pipeline-id': 'pl-ATTACKER', 'team': 'payments' },
      } as never));

      const pipelines = template.findResources('AWS::CodePipeline::Pipeline');
      const tags = (Object.values(pipelines)[0] as any).Properties.Tags as Array<{ Key: string; Value: string }>;
      const value = (k: string) => tags.find((t) => t.Key === k)?.Value;

      expect(value('OrgId')).toBe('org-42');
      expect(value('pb.pipeline-id')).toBe('pl-99');
      // A caller's ORDINARY tags still apply — the guard is narrow, not a ban.
      expect(value('team')).toBe('payments');
      // And the attacker's values appear nowhere at all.
      expect(tags.some((t) => t.Value === 'org-ATTACKER' || t.Value === 'pl-ATTACKER')).toBe(false);
    });

    it('drops a reserved tag even when no platform tag would overwrite it', () => {
      // Ordering alone is not enough: with no environment declared there is no
      // pb.deploys tag to win, so an unfiltered caller value would simply stand
      // and fabricate a deploy signal for DORA.
      const { template } = build(baseProps({
        orgId: 'org-42',
        tags: { 'pb.deploys': 'Deploy:prod' },
      } as never));
      const pipelines = template.findResources('AWS::CodePipeline::Pipeline');
      const tags = (Object.values(pipelines)[0] as any).Properties.Tags as Array<{ Key: string }>;
      expect(tags.some((t) => t.Key === 'pb.deploys')).toBe(false);
    });

    it('grants the synth role read on the org PLATFORM secret it is told to fetch', () => {
      // PLATFORM_SECRET_NAME is injected into the build environment, but the
      // synth process fetches that secret ITSELF with the AWS SDK — so the role
      // needs an explicit grant. Nothing granted it: the REGISTRY secret works
      // only because LinuxBuildImage.fromDockerRegistry({ secretsManagerCredentials })
      // makes CDK grant that one internally, which does not generalise. Every
      // synth then failed AccessDenied on GetSecretValue and the role had to be
      // patched by hand per account.
      const { template } = build(baseProps({ orgId: 'org-42', pipelineId: 'pl-99' }));

      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: 'Allow',
              Action: 'secretsmanager:GetSecretValue',
              // The `-*` suffix matters: Secrets Manager appends six random
              // characters to every ARN, so an exact-name resource never matches.
              Resource: Match.stringLikeRegexp('secret:pipeline-builder/org-42/platform-\\*$'),
            }),
          ]),
        }),
      });
    });

    it('grants the synth role read on the org REGISTRATION secret, and names it in the build env', () => {
      // The synth registers its step manifest with the `pipeline-register` key,
      // not the platform one (which reads pipelines and plugins only). It reads
      // that key itself, by NAME — never a SECRETS_MANAGER variable, which would
      // fail every build at DOWNLOAD_SOURCE when the key is not provisioned.
      const { template } = build(baseProps({ orgId: 'org-42', pipelineId: 'pl-99' }));

      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: 'Allow',
              Action: 'secretsmanager:GetSecretValue',
              Resource: Match.stringLikeRegexp('secret:pipeline-builder/org-42/pipeline-registry-write-\\*$'),
            }),
          ]),
        }),
      });
      template.hasResourceProperties('AWS::CodeBuild::Project', {
        Environment: Match.objectLike({
          EnvironmentVariables: Match.arrayWith([
            { Name: 'PIPELINE_REGISTRATION_SECRET_NAME', Type: 'PLAINTEXT', Value: 'pipeline-builder/org-42/pipeline-registry-write' },
          ]),
        }),
      });
    });

    it('refuses to synth without an orgId (the bootstrap pull credential is per org)', () => {
      // Without an orgId there is no per-org registry secret to pull the
      // toolchain image with — and no platform-secret grant could be scoped
      // either. The synth stops rather than fall back to any other image.
      expect(() => build(baseProps({ orgId: undefined }))).toThrow(/BOOTSTRAP_IMAGE_UNRESOLVED.*orgId/);
    });

    it('does not emit a pb.pipeline-id tag when pipelineId is omitted', () => {
      const { template } = build(baseProps());
      const pipelines = template.findResources('AWS::CodePipeline::Pipeline');
      const tags = (Object.values(pipelines)[0] as any).Properties.Tags as Array<{ Key: string }>;
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
        expect.arrayContaining([{ Key: 'pb.deploys', Value: 'Deploy-prod-alias:production' }]),
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
          { Key: 'pb.deploys', Value: 'Deploy-stg-alias:staging+Deploy-prod-alias:production' },
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
        expect.arrayContaining([{ Key: 'pb.deploys', Value: 'Ship-alias:production' }]),
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
      expect(value.startsWith('ProdDeploy-alias:production')).toBe(true);
      // At least one overflow pair was dropped (fewer than all 9 pairs remain).
      expect(value.split('+').length).toBeLessThan(9);
      // A synth warning names the 256-char cap and the dropped pairs.
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('256'));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('dropped'));
    });

    it('every pb.deploys stage key is the name of a synthesized CodePipeline stage', () => {
      // CodePipeline events carry `detail.stage` = the synthesized stage name;
      // the events Lambda looks that up in pb.deploys. A key that names no real
      // stage (the display name, when the wave id differs) never matches.
      const { template } = build(baseProps({
        stages: [
          { stageName: 'Staging', environment: 'staging', steps: [{ plugin: { name: 'cdk-synth' } }] },
          { stageName: 'Prod', alias: 'prod-wave', environment: 'production', steps: [{ plugin: { name: 'cdk-synth' } }] },
        ],
      }));
      const pipeline = Object.values(template.findResources('AWS::CodePipeline::Pipeline'))[0] as any;
      const stageNames = new Set((pipeline.Properties.Stages as Array<{ Name: string }>).map((st) => st.Name));
      const value = (pipeline.Properties.Tags as Array<{ Key: string; Value: string }>).find((t) => t.Key === 'pb.deploys')!.Value;
      const keys = value.split('+').map((pair) => pair.slice(0, pair.lastIndexOf(':')));
      expect(keys).toEqual(['Staging-alias', 'prod-wave']);
      for (const key of keys) expect(stageNames.has(key)).toBe(true);
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

    it.each(['false', 'FALSE'])('creates no alarm for the STRING %s', (value) => {
      // Metadata arrives as strings from pipeline.json and the API/CLI, and
      // "false" is truthy. Plain truthiness used to create the alarm anyway.
      const { template } = build(baseProps({ global: { [MetadataKeys.ENABLE_METRICS]: value } }));
      template.resourceCountIs('AWS::CloudWatch::Alarm', 0);
    });

    it('still creates it for the STRING "true"', () => {
      const { template } = build(baseProps({ global: { [MetadataKeys.ENABLE_METRICS]: 'true' } }));
      template.resourceCountIs('AWS::CloudWatch::Alarm', 1);
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

  describe('toolchain release (resolvedBootstrap)', () => {
    const projects = (template: Template) => Object.values(template.findResources('AWS::CodeBuild::Project')) as any[];
    const selfMutation = (template: Template) => projects(template).find((p) =>
      String(JSON.stringify(p.Properties.Source?.BuildSpec ?? '')).includes('cdk -a'));
    const buildSpecOf = (project: any) => JSON.parse(project.Properties.Source.BuildSpec);

    it('throws a clear error naming resolvedBootstrap when it is absent', () => {
      expect(() => build(baseProps({ resolvedBootstrap: undefined as never }))).toThrow(/BOOTSTRAP_IMAGE_UNRESOLVED.*resolvedBootstrap/);
    });

    it('carries no CODEBUILD_DEFAULT_IMAGE* anywhere in the template, even when the env sets them', () => {
      process.env.CODEBUILD_DEFAULT_IMAGE = 'pipeline-bootstrap:1.0';
      process.env.CODEBUILD_DEFAULT_IMAGE_DIGEST = `sha256:${'c'.repeat(64)}`;
      try {
        const { template } = build(baseProps({ pipelineId: 'pl-1' }));
        expect(JSON.stringify(template.toJSON())).not.toMatch(/CODEBUILD_DEFAULT_IMAGE/);
      } finally {
        delete process.env.CODEBUILD_DEFAULT_IMAGE;
        delete process.env.CODEBUILD_DEFAULT_IMAGE_DIGEST;
      }
    });

    it('pins the default image to system/pipeline-bootstrap@<digest> with the registry-push credential', () => {
      const { template } = build(baseProps());
      const ref = `registry.example.com/system/pipeline-bootstrap@${BOOTSTRAP_DIGEST}`;
      const onBootstrap = projects(template).filter((p) => p.Properties.Environment.Image === ref);
      // At least the synth (bootstrap synth plugin is metadata_only here) and asset publishing / shell actions.
      expect(onBootstrap.length).toBeGreaterThan(0);
      for (const p of onBootstrap) {
        expect(p.Properties.Environment.ImagePullCredentialsType).toBe('SERVICE_ROLE');
        expect(p.Properties.Environment.RegistryCredential).toEqual({
          Credential: expect.anything(),
          CredentialProvider: 'SECRETS_MANAGER',
        });
      }
      expect(JSON.stringify(template.toJSON())).toContain('pipeline-builder/org-1/registry-push');
    });

    it('runs self-mutation on the curated image with a pinned Node runtime and the release CLI', () => {
      const { template } = build(baseProps());
      const sm = selfMutation(template);
      expect(sm).toBeDefined();
      expect(sm.Properties.Environment.Image).toBe('aws/codebuild/standard:8.0');
      expect(sm.Properties.Environment.ImagePullCredentialsType).toBe('CODEBUILD');
      const spec = buildSpecOf(sm);
      expect(spec.phases.install['runtime-versions']).toEqual({ nodejs: '24' });
      expect(JSON.stringify(spec)).toContain(`npm install -g aws-cdk@${TEST_AWS_CDK}`);
      expect(JSON.stringify(spec)).not.toMatch(/aws-cdk@(latest|2)"/);
    });

    it('pins cdk-assets to the release (asset publishing never installs latest)', () => {
      const { builder } = build(baseProps());
      expect((builder.pipeline as any).cdkAssetsCliVersion).toBe(TEST_CDK_ASSETS);
      expect((builder.pipeline as any).cliVersion).toBe(TEST_AWS_CDK);
    });

    it('explicit pipeline metadata wins over the release pins', () => {
      const { template, builder } = build(baseProps({
        global: {
          'aws:cdk:pipelines:codepipeline:cliversion': '2.1000.0',
          'aws:cdk:pipelines:codepipeline:cdkassetscliversion': '3.0.0',
        },
      }));
      expect((builder.pipeline as any).cliVersion).toBe('2.1000.0');
      expect((builder.pipeline as any).cdkAssetsCliVersion).toBe('3.0.0');
      expect(JSON.stringify(buildSpecOf(selfMutation(template)))).toContain('npm install -g aws-cdk@2.1000.0');
    });

    it('refuses a release without CLI versions unless metadata pins them (never npm latest)', () => {
      const bare = bootstrapFixture({ versions: {} });
      expect(() => build(baseProps({ resolvedBootstrap: bare }))).toThrow(/carries no aws-cdk version/);
      expect(() => build(baseProps({
        resolvedBootstrap: bare,
        global: {
          'aws:cdk:pipelines:codepipeline:cliversion': '2.1000.0',
          'aws:cdk:pipelines:codepipeline:cdkassetscliversion': '3.0.0',
        },
      }))).not.toThrow();
    });

    it('refuses a bootstrap without a signed digest or outside system/pipeline-bootstrap', () => {
      expect(() => build(baseProps({ resolvedBootstrap: bootstrapFixture({ digest: '' }) }))).toThrow(/no signed image digest/);
      expect(() => build(baseProps({ resolvedBootstrap: bootstrapFixture({ repository: 'org-x/pipeline-bootstrap' }) })))
        .toThrow(/BOOTSTRAP_IMAGE_UNRESOLVED.*system\/pipeline-bootstrap/);
    });
  });
});
