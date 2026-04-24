// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger } from '@pipeline-builder/api-core';
import { Duration, Tags } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { PipelineNotificationEvents, PipelineType } from 'aws-cdk-lib/aws-codepipeline';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as sns from 'aws-cdk-lib/aws-sns';
import { CodePipeline, type CodeBuildOptions } from 'aws-cdk-lib/pipelines';
import { Construct } from 'constructs';
import { PipelineConfiguration } from './pipeline-configuration';
import { PluginLookup } from './plugin-lookup';
import { SourceBuilder } from './source-builder';
import { StageBuilder } from './stage-builder';
import type { StageOptions, SynthOptions } from './step-types';
import { Config, CoreConstants } from '../config/app-config';
import { ArtifactManager } from '../core/artifact-manager';
import { UniqueId } from '../core/id-generator';
import { metadataForCodePipeline } from '../core/metadata-builder';
import { resolveNetwork } from '../core/network';
import type { CodeBuildDefaults } from '../core/network-types';
import { createCodeBuildStep } from '../core/pipeline-helpers';
import { MetadataKeys, TriggerType } from '../core/pipeline-types';
import type { MetaDataType } from '../core/pipeline-types';
import { resolveRole } from '../core/role';
import type { RoleConfig } from '../core/role-types';
import { resolveSecurityGroup } from '../core/security-group';

const PIPELINE_EVENT_MAP: Record<string, PipelineNotificationEvents> = {
  FAILED: PipelineNotificationEvents.PIPELINE_EXECUTION_FAILED,
  SUCCEEDED: PipelineNotificationEvents.PIPELINE_EXECUTION_SUCCEEDED,
  STARTED: PipelineNotificationEvents.PIPELINE_EXECUTION_STARTED,
  CANCELED: PipelineNotificationEvents.PIPELINE_EXECUTION_CANCELED,
  SUPERSEDED: PipelineNotificationEvents.PIPELINE_EXECUTION_SUPERSEDED,
};

function parseNotificationEvents(value: unknown): string[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return value.split(',').map(s => s.trim());
  return ['FAILED', 'SUCCEEDED'];
}

/**
 * Configuration properties for the PipelineBuilder construct
 */
export interface BuilderProps {
  /** Project identifier (will be sanitized to lowercase alphanumeric with underscores) */
  readonly project: string;

  /** Organization identifier (will be sanitized to lowercase alphanumeric with underscores) */
  readonly organization: string;

  /** Tenant identifier for resolving per-org secrets from AWS Secrets Manager */
  readonly orgId?: string;

  /** Pipeline database record ID — injected as PIPELINE_ID env var for autonomous synth */
  readonly pipelineId?: string;

  /** Optional custom pipeline name. Defaults to: {organization}-{project}-pipeline */
  readonly pipelineName?: string;

  /** Global metadata inherited by all pipeline steps */
  readonly global?: MetaDataType;

  /**
   * Pipeline-level CodeBuild defaults applied to all CodeBuild actions
   * (synth, self-mutation, asset publishing) via `codeBuildDefaults`.
   */
  readonly defaults?: CodeBuildDefaults;

  /**
   * Optional IAM role for the CodePipeline.
   * When provided, resolves to a CDK IRole and is passed to the CodePipeline construct.
   * When omitted, CDK auto-creates a role with the correct codepipeline.amazonaws.com principal.
   */
  readonly role?: RoleConfig;

  /** Synthesis configuration including source and plugin details */
  readonly synth: SynthOptions;

  /**
   * Optional pipeline stages, each containing one or more CodeBuild steps.
   * Stages are added as waves to the CodePipeline after the synth step.
   */
  readonly stages?: StageOptions[];

  /** Optional cron/rate expression for scheduled pipeline execution. */
  readonly schedule?: string;

  /** Custom tags applied to all pipeline resources. */
  readonly tags?: Record<string, string>;
}

/**
 * CDK construct that creates and configures a CodePipeline for continuous deployment.
 *
 * Features:
 * - Multi-source support (S3, GitHub, CodeStar)
 * - Plugin-based build steps
 * - Metadata-driven configuration
 * - Automatic tagging
 * - Automatic sanitization of project and organization names
 *
 * @example
 * ```typescript
 * new PipelineBuilder(this, 'MyPipeline', {
 *   project: 'my-app',
 *   organization: 'my-org',
 *   synth: {
 *     source: {
 *       type: 'github',
 *       options: { repo: 'owner/repo', branch: 'main' }
 *     },
 *     plugin: { name: 'synth' }
 *   }
 * });
 * ```
 */
export class PipelineBuilder extends Construct {
  public readonly pipeline: CodePipeline;
  public readonly config: PipelineConfiguration;

  constructor(scope: Construct, id: string, props: BuilderProps) {
    super(scope, id);

    // Use PipelineConfiguration for all business logic (validation, sanitization, metadata merging)
    this.config = new PipelineConfiguration(props);

    const serverConfig = Config.get('server');
    const awsConfig = Config.get('aws');
    const uniqueId = new UniqueId();
    const pluginLookup = new PluginLookup(
      this,
      uniqueId.generate('plugin:lookup'),
      {
        organization: this.config.organization,
        project: this.config.project,
        platformUrl: serverConfig.platformUrl,
        uniqueId,
        orgId: props.orgId,
        runtime: awsConfig.lambda.runtime,
        timeout: awsConfig.lambda.timeout,
        reservedConcurrentExecutions: awsConfig.lambda.reservedConcurrentExecutions,
      },
    );

    // Create source and build step
    const sourceBuilder = new SourceBuilder(this, this.config);
    const source = sourceBuilder.create(uniqueId);

    // RESOLVED_SYNTH_PLUGIN=true (CodePipeline): resolve plugin via custom resource Lambda
    // RESOLVED_SYNTH_PLUGIN=false (default/CLI): use fallback with pipeline-manager synth commands
    const plugin = awsConfig.resolvedSynthPlugin
      ? pluginLookup.plugin(this.config.plugin)
      : pluginLookup.fallbackSynth();
    const defaultComputeType = awsConfig.codeBuild.computeType;
    const artifactManager = new ArtifactManager();
    const synthAlias = this.config.plugin.alias ?? this.config.plugin.name;

    // Scope exposed to plugin-spec templates as `pipeline.*`. Built once
    // here so both the synth step and every stage step resolve against
    // the same snapshot.
    const pipelineScope: Record<string, unknown> = {
      pipeline: {
        projectName: this.config.project,
        project: this.config.project,
        orgId: this.config.organization,
        organization: this.config.organization,
        pipelineName: this.config.pipelineName,
        metadata: this.config.metadata.merged,
        vars: (props as { vars?: Record<string, unknown> }).vars ?? {},
      },
    };

    const synth = createCodeBuildStep({
      ...this.config.synthCustomization,
      id: uniqueId.generate('cdk:synth'),
      uniqueId,
      plugin,
      input: source,
      metadata: this.config.metadata.merged,
      network: this.config.network,
      scope: this,
      defaultComputeType,
      artifactManager,
      stageName: 'no-stage',
      stageAlias: 'no-stage-alias',
      pluginAlias: `${synthAlias}-alias`,
      orgId: props.orgId,
      pipelineScope,
    });

    // Resolve pipeline-level defaults into codeBuildDefaults
    // Build the per-org platform secret name for CodeBuild env vars
    const platformSecretName = props.orgId
      ? CoreConstants.secretPath(props.orgId, 'platform')
      : undefined;

    const codeBuildDefaults = this.resolveDefaults(this.config.defaults, uniqueId, props.pipelineId, platformSecretName, serverConfig.platformUrl);

    // Resolve IAM role if explicitly provided; otherwise let CDK auto-create
    // the pipeline role with the correct codepipeline.amazonaws.com principal.
    if (props.role?.type === 'codeBuildDefault') {
      createLogger('PipelineBuilder').warn(
        'codeBuildDefault role type uses codebuild.amazonaws.com trust principal — ' +
        'this is not suitable as the pipeline-level role. Consider using roleArn/roleName ' +
        'or omitting the role to let CDK auto-create one with codepipeline.amazonaws.com.',
      );
    }
    const role = props.role
      ? resolveRole(this, uniqueId, props.role)
      : undefined;

    // Create CodePipeline construct
    this.pipeline = new CodePipeline(this, uniqueId.generate('pipelines:codepipeline'), {
      ...(codeBuildDefaults && { codeBuildDefaults }),
      ...(role && { role }),
      pipelineType: PipelineType.V2,
      pipelineName: this.config.pipelineName,
      synth,
      ...metadataForCodePipeline(this.config.metadata.merged),
    });

    if (props.stages) {
      const stageBuilder = new StageBuilder({
        scope: this,
        pluginLookup,
        uniqueId,
        globalMetadata: this.config.metadata.merged,
        defaultComputeType,
        artifactManager,
        orgId: props.orgId,
        pipelineScope,
      });
      stageBuilder.addStages(this.pipeline, props.stages);
    }

    // ── Tags ──
    Tags.of(this.pipeline).add('project', this.config.project);
    Tags.of(this.pipeline).add('organization', this.config.organization);
    if (props.tags) {
      for (const [key, value] of Object.entries(props.tags)) {
        Tags.of(this.pipeline).add(key, value);
      }
    }

    // Build the internal pipeline before accessing its properties
    this.pipeline.buildPipeline();
    const cdkPipeline = this.pipeline.pipeline;
    const meta = this.config.metadata.merged;

    // ── SNS Notifications ──
    const notificationTopicArn = meta[MetadataKeys.NOTIFICATION_TOPIC_ARN];
    if (typeof notificationTopicArn === 'string') {
      const topic = sns.Topic.fromTopicArn(this, 'NotificationTopic', notificationTopicArn);
      const notificationEvents = parseNotificationEvents(meta[MetadataKeys.NOTIFICATION_EVENTS])
        .map(e => PIPELINE_EVENT_MAP[e.toUpperCase()])
        .filter(Boolean);
      if (notificationEvents.length > 0) {
        cdkPipeline.notifyOn('PipelineNotification', topic, { events: notificationEvents });
      }
    }

    // ── Scheduled Execution ──
    if (props.synth.source.options?.trigger === TriggerType.SCHEDULE || props.schedule) {
      const expr = props.schedule || (props.synth.source.options as { schedule?: string })?.schedule || 'rate(1 day)';
      new events.Rule(this, 'ScheduleRule', {
        schedule: events.Schedule.expression(expr),
        targets: [new targets.CodePipeline(cdkPipeline)],
      });
    }

    // ── Execution Event Tracking (forward pipeline state changes to SNS) ──
    if (meta[MetadataKeys.ENABLE_EXECUTION_EVENTS] && typeof notificationTopicArn === 'string') {
      new events.Rule(this, 'ExecutionEventRule', {
        eventPattern: {
          source: ['aws.codepipeline'],
          detailType: ['CodePipeline Pipeline Execution State Change'],
          resources: [cdkPipeline.pipelineArn],
        },
        targets: [new targets.SnsTopic(
          sns.Topic.fromTopicArn(this, 'ExecutionEventTopic', notificationTopicArn),
        )],
      });
    }

    // ── Artifact Encryption (KMS key) ──
    const kmsKeyArn = this.config.metadata.merged[MetadataKeys.KMS_KEY_ARN];
    if (typeof kmsKeyArn === 'string') {
      const key = kms.Key.fromKeyArn(this, 'ArtifactKey', kmsKeyArn);
      Tags.of(key).add('pipeline', this.config.pipelineName);
    }

    // ── Pipeline Metrics & Alarms ──
    const enableMetrics = this.config.metadata.merged[MetadataKeys.ENABLE_METRICS];
    if (enableMetrics) {
      new cloudwatch.Alarm(this, 'PipelineFailureAlarm', {
        metric: new cloudwatch.Metric({
          namespace: 'AWS/CodePipeline',
          metricName: 'FailedPipelineExecutionCount',
          dimensionsMap: { PipelineName: this.config.pipelineName },
          statistic: 'Sum',
          period: Duration.minutes(5),
        }),
        threshold: 1,
        evaluationPeriods: 1,
        alarmDescription: `Pipeline ${this.config.pipelineName} execution failed`,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
    }
  }

  /**
   * Resolves CodeBuildDefaults into the shape expected by CDK's codeBuildDefaults.
   * Combines network config, security groups, and pipeline-level environment variables
   * (PIPELINE_ID, EXECUTION_ID, PLATFORM_BASE_URL) available to all CodeBuild actions.
   */
  private resolveDefaults(
    defaults: CodeBuildDefaults | undefined,
    id: UniqueId,
    pipelineId: string | undefined,
    platformSecretName: string | undefined,
    platformUrl: string,
  ): CodeBuildOptions | undefined {
    const networkProps = defaults?.network
      ? resolveNetwork(this, id, defaults.network)
      : undefined;

    const standaloneSecurityGroups = defaults?.securityGroups
      ? resolveSecurityGroup(this, id, defaults.securityGroups)
      : undefined;

    // Pipeline-level env vars available to all CodeBuild actions
    // Note: #{codepipeline.*} resolved variables must go through CodeBuildStep.env
    // (action-level), not buildEnvironment.environmentVariables (project-level).
    const pipelineEnvVars: Record<string, { value: string }> = {
      PLATFORM_BASE_URL: { value: platformUrl },
      ...(pipelineId && { PIPELINE_ID: { value: pipelineId } }),
      ...(platformSecretName && { PLATFORM_SECRET_NAME: { value: platformSecretName } }),
      // Enable plugin resolution via custom resource Lambda inside CodePipeline
      RESOLVED_SYNTH_PLUGIN: { value: 'true' },
      // Propagate TLS verification setting so all CodeBuild steps can reach
      // the platform API when using self-signed certificates
      ...(process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0' && {
        NODE_TLS_REJECT_UNAUTHORIZED: { value: '0' },
      }),
    };

    const securityGroups = [
      ...(networkProps?.securityGroups ?? []),
      ...(standaloneSecurityGroups ?? []),
    ];

    return {
      ...(networkProps && { vpc: networkProps.vpc, subnetSelection: networkProps.subnetSelection }),
      ...(securityGroups.length > 0 && { securityGroups }),
      buildEnvironment: { environmentVariables: pipelineEnvVars },
    };
  }
}
