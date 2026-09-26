// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger } from '@pipeline-builder/api-core';
import type { Plugin } from '@pipeline-builder/pipeline-data';
import { Duration, RemovalPolicy, Tags } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { PipelineNotificationEvents, PipelineType, Variable } from 'aws-cdk-lib/aws-codepipeline';
import * as events from 'aws-cdk-lib/aws-events';
import { Effect, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import { CodePipeline, type CodeBuildOptions } from 'aws-cdk-lib/pipelines';
import { Construct } from 'constructs';
import { describeDeployAttribution } from './deploy-attribution.js';
import { PipelineConfiguration } from './pipeline-configuration.js';
import { PluginLookup } from './plugin-lookup.js';
import { SourceBuilder } from './source-builder.js';
import { StageBuilder } from './stage-builder.js';
import { StepManifestRecorder } from './step-manifest-recorder.js';
import type { StageOptions, SynthOptions } from './step-types.js';
import { Config, CoreConstants, isReservedTagKey } from '../config/app-config.js';
import { lambdaArchitecture, lambdaRuntime, lambdaTimeout } from '../config/aws-config-cdk.js';
import type { RegistryConfig } from '../config/config-types.js';
import { ArtifactManager } from '../core/artifact-manager.js';
import { UniqueId } from '../core/id-generator.js';
import {
  asInt,
  isTrue,
  metadataForCodePipeline,
  networkConfigFromMetadata,
  parsePipelineVariables,
  roleConfigFromMetadata,
  securityGroupConfigFromMetadata,
} from '../core/metadata-builder.js';
import type { CodeBuildDefaults } from '../core/network-types.js';
import { resolveNetwork, networkConfigFromEnv } from '../core/network.js';
import { createCodeBuildStep, getComputeType, resolveDefaultBuildImage } from '../core/pipeline-helpers.js';
import { MetadataKeys, TriggerType } from '../core/pipeline-types.js';
import type { MetaDataType } from '../core/pipeline-types.js';
import { assertPluginContract, contractScopeFromTemplateScope, pluginArtifactAlias } from '../core/plugin-contract.js';
import type { RoleConfig } from '../core/role-types.js';
import { resolveRole } from '../core/role.js';
import { resolveSecurityGroup } from '../core/security-group.js';
import type { StepManifestEntry } from '../core/step-manifest.js';

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
 * Build the `pb.deploys` tag value and emit the synth-time warnings that come
 * with it. The derivation itself is CDK-free and lives in
 * {@link describeDeployAttribution}, so `POST /pipelines` and
 * `POST /pipelines/validate` report the same attribution without synthesizing.
 *
 * Returns undefined when nothing declares an environment (no deploy signal).
 */
function buildDeploysTag(props: BuilderProps): string | undefined {
  const { deploysTag, warnings } = describeDeployAttribution(props);
  const log = createLogger('pipeline-builder');
  for (const w of warnings) log.warn(w.message);
  return deploysTag;
}


/**
 * Configuration properties for the PipelineBuilder construct
 */
export interface BuilderProps {
  /** Project identifier (will be sanitized to lowercase alphanumeric with underscores) */
  readonly project: string;

  /** Organization identifier (will be sanitized to lowercase alphanumeric with underscores) */
  readonly organization: string;

  /**
   * Optional deploy environment (e.g. `production`, `staging`) for the
   * single-environment case. When set (and no stage declares its own
   * `environment`), pipeline-core derives the `pb.deploys` tag from it, marking
   * the sole stage — or the LAST stage of a multi-stage pipeline (with a synth
   * warning), or a literal `Deploy` stage when there are no stages to name — as
   * the deploy for DORA metrics. For multi-environment pipelines, declare
   * `environment` per stage instead (see `StageOptions.environment`).
   */
  readonly environment?: string;

  /** Tenant identifier for resolving per-org secrets from AWS Secrets Manager */
  readonly orgId?: string;

  /** Pipeline database record ID — injected as PIPELINE_ID env var for autonomous synth */
  readonly pipelineId?: string;

  /** Optional custom pipeline name. Defaults to: {organization}-{project}-pipeline */
  readonly pipelineName?: string;

  /** Global metadata inherited by all pipeline steps */
  readonly global?: MetaDataType;

  /**
   * Pipeline-level template variables, exposed to `{{ pipeline.vars.* }}` in
   * pipeline configs and plugin specs (see `PluginSpec.requiredVars`). Declared
   * here so the `pipeline.vars` template scope is type-checked end-to-end.
   */
  readonly vars?: Record<string, unknown>;

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

  /**
   * Plugins pre-resolved by `pipeline-manager pipeline synth` from the platform API,
   * keyed by `alias || name`. When present, `PluginLookup.plugin()` returns
   * the matching entry directly and skips the custom resource — so the
   * synthesized CFN template ships with the real CodeBuild image baked in.
   * Populated by the CLI before invoking the boilerplate app; CDK consumers
   * who construct PipelineBuilder directly normally leave this unset.
   */
  readonly resolvedPlugins?: Record<string, Plugin>;

  /**
   * Platform-sourced registry overrides, applied over the env-loaded `registry`
   * config at synth start. pipeline-manager populates this from the platform URL
   * it deploys against so the CodeBuild image URIs use a pull host AWS CodeBuild
   * can resolve (instead of the in-cluster `registry:5000` default). CDK
   * consumers constructing PipelineBuilder directly normally leave this unset.
   */
  readonly registry?: Partial<RegistryConfig>;
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
  /**
   * Which plugin each CodePipeline action runs, read off the built
   * pipeline. The CLI ships it with the registry registration so event ingest
   * can attribute action outcomes to a plugin version.
   */
  public readonly stepManifest: StepManifestEntry[];

  constructor(scope: Construct, id: string, props: BuilderProps) {
    super(scope, id);

    // Apply platform-sourced registry overrides BEFORE any Config.get('registry')
    // (plugin/default build-image resolution below) so the synth uses the pull
    // host the platform deploys against, not the in-cluster env default. The CLI
    // only sets props.registry when IMAGE_REGISTRY_PULL_HOST is unset, so an
    // explicit operator pull host is never clobbered (see bakePlatformRegistry).
    //
    // Scoped + restored so the override does NOT leak into the process-wide
    // Config cache: in a multi-pipeline CDK app, pipeline B's registry must not
    // bleed into pipeline A's image resolution. All registry reads happen
    // synchronously below (build-image resolution), so restoring at the end of
    // the constructor keeps single-pipeline behavior identical.
    const restoreRegistry = props.registry
      ? Config.overrideScoped('registry', props.registry)
      : undefined;
    try {
      // Use PipelineConfiguration for all business logic (validation, sanitization, metadata merging)
      this.config = new PipelineConfiguration(props);

      const serverConfig = Config.get('server');
      const awsConfig = Config.get('aws');
      // Pass org+project so log group / IAM role names get a stable hash
      // suffix per pipeline. Prevents `Resource already exists` collisions
      // across stacks deployed to the same AWS account.
      const uniqueId = new UniqueId({
        organization: this.config.organization,
        project: this.config.project,
      });
      const pluginLookup = new PluginLookup(
        this,
        uniqueId.generate('plugin:lookup'),
        {
          organization: this.config.organization,
          project: this.config.project,
          platformUrl: serverConfig.platformUrl,
          uniqueId,
          orgId: props.orgId,
          runtime: lambdaRuntime(awsConfig.lambda.runtime),
          timeout: lambdaTimeout(awsConfig.lambda.timeoutSeconds),
          architecture: lambdaArchitecture(awsConfig.lambda.architecture),
          reservedConcurrentExecutions: awsConfig.lambda.reservedConcurrentExecutions,
          resolvedPlugins: props.resolvedPlugins,
        },
      );

      // Create source and build step
      const sourceBuilder = new SourceBuilder(this, this.config);
      const source = sourceBuilder.create(uniqueId);

      // Synth-plugin resolution:
      //   1. Pre-resolved by `pipeline-manager pipeline synth/deploy` from the platform
      //      API → use it. Synth step runs on the real `cdk-synth` image with
      //      real commands baked into the template.
      //   2. Otherwise → `bootstrap()`: cold-start `pipeline-manager pipeline synth`
      //      on the configured CODEBUILD_DEFAULT_IMAGE (default
      //      pipeline-bootstrap:1.0). Used when the platform isn't reachable
      //      at synth time (CLI logs a warning per missed plugin).
      //
      // pluginLookup.plugin() reads `resolvedPlugins` internally and returns
      // the cached entry when present — so calling it always wins over
      // bootstrap() when pre-resolution succeeded.
      const synthCacheKey = pluginArtifactAlias(this.config.plugin);
      const plugin = props.resolvedPlugins?.[synthCacheKey]
        ? pluginLookup.plugin(this.config.plugin)
        : pluginLookup.bootstrap();
      const defaultComputeType = getComputeType(awsConfig.codeBuild.computeType);
      const artifactManager = new ArtifactManager();

      // Scope exposed to plugin-spec templates as `pipeline.*`. Sourced from the
      // config so the synth step, every stage step, and the source token all
      // resolve against the same snapshot (see PipelineConfiguration.getPipelineScope).
      const pipelineScope = this.config.getPipelineScope();
      // Contract — see StageBuilder.resolveStep.
      assertPluginContract(plugin, contractScopeFromTemplateScope(pipelineScope), 'synth');

      const stepManifest = new StepManifestRecorder();
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
        // The canonical key segment. `${alias ?? name}-alias` suffixed an
        // EXPLICIT alias too (`my-synth` → `my-synth-alias`), so a stage that
        // picked the synth output in the UI asked for a key never registered.
        pluginAlias: pluginArtifactAlias(this.config.plugin),
        orgId: props.orgId,
        pipelineScope,
      });
      stepManifest.record(synth, plugin);

      // Resolve pipeline-level defaults into codeBuildDefaults
      // Build the per-org platform secret name for CodeBuild env vars
      const platformSecretName = props.orgId
        ? CoreConstants.secretPath(props.orgId, 'platform')
        : undefined;

      const codeBuildDefaults = this.resolveDefaults(this.config.defaults, uniqueId, props.pipelineId, platformSecretName, serverConfig.platformUrl, props.orgId);

      // Resolve IAM role: explicit prop wins, else `iam:role` metadata, else let
      // CDK auto-create the pipeline role (codepipeline.amazonaws.com principal).
      const roleConfig = props.role ?? roleConfigFromMetadata(this.config.metadata.merged);
      if (roleConfig?.type === 'codeBuildDefault') {
        createLogger('pipeline-builder').warn(
          'codeBuildDefault role type uses codebuild.amazonaws.com trust principal — ' +
        'this is not suitable as the pipeline-level role. Consider using roleArn/roleName ' +
        'or omitting the role to let CDK auto-create one with codepipeline.amazonaws.com.',
        );
      }
      const role = roleConfig
        ? resolveRole(this, uniqueId, roleConfig)
        : undefined;

      // ── Artifact bucket (KMS encryption + retention) ──
      // When `encryption.kmsKeyArn` and/or `operations.artifactRetentionDays` are
      // set we create a custom artifact bucket and pass it to CodePipeline; that
      // is the only way to attach a customer-managed key (the L3 construct exposes
      // `artifactBucket`, not `encryptionKey`). Absent both keys, CDK auto-creates
      // the bucket and behavior is unchanged.
      const artifactBucket = this.buildArtifactBucket();

      // Create CodePipeline construct
      this.pipeline = new CodePipeline(this, uniqueId.generate('pipelines:codepipeline'), {
        ...(codeBuildDefaults && { codeBuildDefaults }),
        ...(role && { role }),
        ...(artifactBucket && { artifactBucket }),
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
          stepManifest,
        });
        stageBuilder.addStages(this.pipeline, props.stages);
      }

      // ── Tags ──
      // The first three are operations-essential and used by `pipeline-manager
      // audit stacks` to diff CFN stacks against the pipeline_registry table.
      // `OrgId` is the canonical key for cost attribution (AWS Cost Explorer
      // groups by tag key/value when activated in Billing settings).
      // USER TAGS FIRST, so the platform tags below overwrite rather than are
      // overwritten. `Tags.of` lets a later add replace an earlier one, and
      // these used to be applied LAST — which let a caller redefine
      // pb.pipeline-id, OrgId or pb.deploys and point another org's executions
      // at their own pipeline, since the events Lambda reads exactly those tags
      // to decide whose reports an execution belongs to.
      //
      // The reserved-key filter is the second half: ordering alone would let a
      // caller set `pb.deploys` on a pipeline that declares no environment (no
      // platform tag to overwrite it). The API refuses these keys too, but a
      // team using this construct directly never passes through the API, so
      // this is the check that always runs.
      if (props.tags) {
        for (const [key, value] of Object.entries(props.tags)) {
          if (isReservedTagKey(key)) continue;
          Tags.of(this.pipeline).add(key, value);
        }
      }
      Tags.of(this.pipeline).add('pipeline-builder', 'true');
      Tags.of(this.pipeline).add('project', this.config.project);
      Tags.of(this.pipeline).add('organization', this.config.organization);
      if (props.orgId) {
        Tags.of(this.pipeline).add('OrgId', props.orgId);
      }
      // Stable event-reporting key. Applied at synth (the pipelineId is known
      // here), so it's present from stack creation — the events Lambda reads this
      // tag to attribute CodePipeline state-change events to the pipeline without
      // ever handling the ARN/account. See packages/pipeline-events.
      if (props.pipelineId) {
        Tags.of(this.pipeline).add('pb.pipeline-id', props.pipelineId);
      }
      // Deploy-environment attribution for DORA metrics. `pb.deploys` lists every
      // deploy stage as `<stageName>:<environment>` pairs joined by `+`, read by
      // the events Lambda from the same ListTags call to mark which stages are
      // deploys and to which environment. Absent when no environment is declared
      // — such pipelines produce no DORA deploy signal until they re-synth.
      const deploysTag = buildDeploysTag(props);
      if (deploysTag) {
        Tags.of(this.pipeline).add('pb.deploys', deploysTag);
      }

      // Build the internal pipeline before accessing its properties
      this.pipeline.buildPipeline();

      // PLATFORM_SECRET_NAME is injected into the CodeBuild environment above,
      // but the synth process reads that secret itself with the AWS SDK
      // (handlers/platform-credential.ts GetSecretValue) — so the role needs an
      // explicit grant. Nothing was granting it: the REGISTRY secret works only
      // because `LinuxBuildImage.fromDockerRegistry({ secretsManagerCredentials })`
      // makes CDK grant that one internally, which does not generalise to a
      // secret the build reads for itself. Without this every synth fails with
      // AccessDeniedException on GetSecretValue, and the pipeline role has to be
      // patched by hand in each account.
      //
      // Scoped to this org's platform secret and mirroring the plugin-lookup
      // Lambda's grant (pipeline/plugin-lookup.ts), including the `-*` suffix —
      // Secrets Manager appends six random characters to every ARN.
      if (platformSecretName) {
        this.pipeline.synthProject.addToRolePolicy(new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ['secretsmanager:GetSecretValue'],
          resources: [`arn:aws:secretsmanager:*:*:secret:${platformSecretName}-*`],
        }));
      }

      const cdkPipeline = this.pipeline.pipeline;
      this.stepManifest = stepManifest.entries(cdkPipeline);
      const meta = this.config.metadata.merged;

      // ── Pipeline-level Variables (CodePipeline V2) ──
      for (const v of parsePipelineVariables(meta[MetadataKeys.PIPELINE_VARIABLES])) {
        cdkPipeline.addVariable(new Variable({
          variableName: v.name,
          ...(v.defaultValue !== undefined && { defaultValue: v.defaultValue }),
          ...(v.description !== undefined && { description: v.description }),
        }));
      }

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
      // `isTrue`, not truthiness: `"false"` is a truthy string, so the metadata
      // `"aws:cdk:operations:executionevents": "false"` used to CREATE the rule.
      if (isTrue(meta[MetadataKeys.ENABLE_EXECUTION_EVENTS]) && typeof notificationTopicArn === 'string') {
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

      // ── Pipeline Metrics & Alarms ──
      // Same trap: `"aws:cdk:operations:metrics": "false"` created the alarm.
      const enableMetrics = isTrue(this.config.metadata.merged[MetadataKeys.ENABLE_METRICS]);
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
    } finally {
      // Revert the per-builder registry override so it never leaks into the
      // process-wide Config cache (see the override at the top of the constructor).
      restoreRegistry?.();
    }
  }

  /**
   * Build a custom artifact bucket when `encryption.kmsKeyArn` and/or
   * `operations.artifactRetentionDays` are set. Returns undefined otherwise so
   * CDK auto-creates the default artifact bucket (unchanged behavior).
   */
  private buildArtifactBucket(): s3.IBucket | undefined {
    const meta = this.config.metadata.merged;
    const kmsKeyArn = typeof meta[MetadataKeys.KMS_KEY_ARN] === 'string'
      ? (meta[MetadataKeys.KMS_KEY_ARN] as string)
      : undefined;
    const retentionDays = asInt(meta[MetadataKeys.ARTIFACT_RETENTION_DAYS]);

    if (!kmsKeyArn && retentionDays === undefined) return undefined;

    const encryptionKey = kmsKeyArn
      ? kms.Key.fromKeyArn(this, 'ArtifactKey', kmsKeyArn)
      : undefined;

    const bucket = new s3.Bucket(this, 'ArtifactBucket', {
      encryption: encryptionKey ? s3.BucketEncryption.KMS : s3.BucketEncryption.S3_MANAGED,
      ...(encryptionKey && { encryptionKey }),
      ...(retentionDays !== undefined && {
        lifecycleRules: [{ expiration: Duration.days(retentionDays) }],
      }),
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    Tags.of(bucket).add('pipeline', this.config.pipelineName);
    return bucket;
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
    orgId: string | undefined,
  ): CodeBuildOptions | undefined {
    // Per-pipeline network config wins; otherwise fall back to an env-driven
    // global VPC (internal / inside-AWS-only mode) so every pipeline's
    // CodeBuild runs in the VPC and can reach the private gateway. Unset in
    // public deploys → CodeBuild stays in the AWS-managed network.
    // Precedence: explicit prop > `ec2:network` metadata > env-driven global VPC.
    const network = defaults?.network ?? networkConfigFromMetadata(this.config.metadata.merged) ?? networkConfigFromEnv();
    const networkProps = network
      ? resolveNetwork(this, id, network)
      : undefined;

    // Same precedence for standalone security groups (prop > `ec2:securitygroup` metadata).
    const securityGroupConfig = defaults?.securityGroups ?? securityGroupConfigFromMetadata(this.config.metadata.merged);
    const standaloneSecurityGroups = securityGroupConfig
      ? resolveSecurityGroup(this, id, securityGroupConfig)
      : undefined;

    // Pipeline-level env vars available to all CodeBuild actions
    // Note: #{codepipeline.*} resolved variables must go through CodeBuildStep.env
    // (action-level), not buildEnvironment.environmentVariables (project-level).
    const pipelineEnvVars: Record<string, { value: string }> = {
      PLATFORM_BASE_URL: { value: platformUrl },
      ...(pipelineId && { PIPELINE_ID: { value: pipelineId } }),
      ...(platformSecretName && { PLATFORM_SECRET_NAME: { value: platformSecretName } }),
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
      // buildImage at this level reaches CDK Pipelines' internally-wrapped
      // ShellStep CodeBuild action, which otherwise hardcodes
      // CDK's default curated standard image. Setting it here closes the gap
      // exposed in the same env var (`CODEBUILD_DEFAULT_IMAGE`) that the
      // CodeBuildStep path already honors via resolvePluginImage()'s
      // fallback. Per-step `buildImage` on a CodeBuildStep still wins.
      buildEnvironment: {
        buildImage: resolveDefaultBuildImage(this, orgId),
        environmentVariables: pipelineEnvVars,
      },
    };
  }
}
