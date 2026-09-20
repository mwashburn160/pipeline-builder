// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The pipeline METADATA KEY catalog — the single source of truth for both
 * sides of the product.
 *
 * Key format: `aws:cdk:{namespace}:{property}` (all lowercase). These match the
 * keys produced by `getCustomKey(namespace, property)` and looked up by
 * `buildConfigFromMetadata` in pipeline-core.
 *
 * One table drives everything: `MetadataKeys` (the synth-time constants
 * re-exported by `@pipeline-builder/pipeline-core`) and `METADATA_KEY_GROUPS`
 * (the grouped picker the pipeline form builder renders) are BOTH derived from
 * `METADATA_KEY_CATALOG`, so a key can never exist on one side only.
 *
 * This module is dependency-free so the browser can import it through the
 * `@pipeline-builder/api-core/metadata-keys` subpath.
 *
 * @example
 * ```typescript
 * const metadata = {
 *   [MetadataKeys.SELF_MUTATION]: true,
 *   [MetadataKeys.PUBLISH_ASSETS_IN_PARALLEL]: true
 * };
 * ```
 */

/** The value shape a metadata key accepts in the form builder. */
export type MetadataKeyType = 'boolean' | 'string';

/** One catalog entry: the wire key plus everything the picker needs to render it. */
export interface MetadataKeyEntry {
  /** The `aws:cdk:…` key written into a pipeline's metadata. */
  readonly key: string;
  /** Picker group heading. */
  readonly category: string;
  /** Human label shown in the picker. */
  readonly label: string;
  /** Value editor to render. */
  readonly type: MetadataKeyType;
}

/**
 * Every supported metadata key, keyed by its `MetadataKeys` constant name and
 * listed in picker order.
 */
export const METADATA_KEY_CATALOG = {
  // ── CodePipeline (namespace: pipelines:codepipeline) ──
  SELF_MUTATION: { key: 'aws:cdk:pipelines:codepipeline:selfmutation', category: 'CodePipeline', label: 'Self Mutation', type: 'boolean' },
  CROSS_ACCOUNT_KEYS: { key: 'aws:cdk:pipelines:codepipeline:crossaccountkeys', category: 'CodePipeline', label: 'Cross Account Keys', type: 'boolean' },
  DOCKER_ENABLED_FOR_SELF_MUTATION: { key: 'aws:cdk:pipelines:codepipeline:dockerenabledforselfmutation', category: 'CodePipeline', label: 'Docker Enabled for Self Mutation', type: 'boolean' },
  DOCKER_ENABLED_FOR_SYNTH: { key: 'aws:cdk:pipelines:codepipeline:dockerenabledforsynth', category: 'CodePipeline', label: 'Docker Enabled for Synth', type: 'boolean' },
  ENABLE_KEY_ROTATION: { key: 'aws:cdk:pipelines:codepipeline:enablekeyrotation', category: 'CodePipeline', label: 'Enable Key Rotation', type: 'boolean' },
  PUBLISH_ASSETS_IN_PARALLEL: { key: 'aws:cdk:pipelines:codepipeline:publishassetsinparallel', category: 'CodePipeline', label: 'Publish Assets in Parallel', type: 'boolean' },
  REUSE_CROSS_REGION_SUPPORT_STACKS: { key: 'aws:cdk:pipelines:codepipeline:reusecrossregionsupportstacks', category: 'CodePipeline', label: 'Reuse Cross Region Support Stacks', type: 'boolean' },
  USE_CHANGE_SETS: { key: 'aws:cdk:pipelines:codepipeline:usechangesets', category: 'CodePipeline', label: 'Use Change Sets', type: 'boolean' },
  USE_PIPELINE_ROLE_FOR_ACTIONS: { key: 'aws:cdk:pipelines:codepipeline:usepipelineroleforactions', category: 'CodePipeline', label: 'Use Pipeline Role for Actions', type: 'boolean' },
  ARTIFACT_BUCKET: { key: 'aws:cdk:pipelines:codepipeline:artifactbucket', category: 'CodePipeline', label: 'Artifact Bucket', type: 'string' },
  ASSET_PUBLISHING_CODE_BUILD_DEFAULTS: { key: 'aws:cdk:pipelines:codepipeline:assetpublishingcodebuilddefaults', category: 'CodePipeline', label: 'Asset Publishing CodeBuild Defaults', type: 'string' },
  CDK_ASSETS_CLI_VERSION: { key: 'aws:cdk:pipelines:codepipeline:cdkassetscliversion', category: 'CodePipeline', label: 'CDK Assets CLI Version', type: 'string' },
  CLI_VERSION: { key: 'aws:cdk:pipelines:codepipeline:cliversion', category: 'CodePipeline', label: 'CLI Version', type: 'string' },
  CODE_BUILD_DEFAULTS: { key: 'aws:cdk:pipelines:codepipeline:codebuilddefaults', category: 'CodePipeline', label: 'CodeBuild Defaults', type: 'string' },
  CODE_PIPELINE: { key: 'aws:cdk:pipelines:codepipeline:codepipeline', category: 'CodePipeline', label: 'CodePipeline', type: 'string' },
  CROSS_REGION_REPLICATION_BUCKETS: { key: 'aws:cdk:pipelines:codepipeline:crossregionreplicationbuckets', category: 'CodePipeline', label: 'Cross Region Replication Buckets', type: 'string' },
  DOCKER_CREDENTIALS: { key: 'aws:cdk:pipelines:codepipeline:dockercredentials', category: 'CodePipeline', label: 'Docker Credentials', type: 'string' },
  PIPELINE_NAME: { key: 'aws:cdk:pipelines:codepipeline:pipelinename', category: 'CodePipeline', label: 'Pipeline Name', type: 'string' },
  PIPELINE_TYPE: { key: 'aws:cdk:pipelines:codepipeline:pipelinetype', category: 'CodePipeline', label: 'Pipeline Type', type: 'string' },
  PIPELINE_ROLE: { key: 'aws:cdk:pipelines:codepipeline:role', category: 'CodePipeline', label: 'Pipeline Role', type: 'string' },
  SELF_MUTATION_CODE_BUILD_DEFAULTS: { key: 'aws:cdk:pipelines:codepipeline:selfmutationcodebuilddefaults', category: 'CodePipeline', label: 'Self Mutation CodeBuild Defaults', type: 'string' },
  SYNTH: { key: 'aws:cdk:pipelines:codepipeline:synth', category: 'CodePipeline', label: 'Synth', type: 'string' },
  SYNTH_CODE_BUILD_DEFAULTS: { key: 'aws:cdk:pipelines:codepipeline:synthcodebuilddefaults', category: 'CodePipeline', label: 'Synth CodeBuild Defaults', type: 'string' },

  // ── CodeBuildStep (namespace: pipelines:codebuildstep) ──
  ACTION_ROLE: { key: 'aws:cdk:pipelines:codebuildstep:actionrole', category: 'CodeBuildStep', label: 'Action Role', type: 'string' },
  ADDITIONAL_INPUTS: { key: 'aws:cdk:pipelines:codebuildstep:additionalinputs', category: 'CodeBuildStep', label: 'Additional Inputs', type: 'string' },
  BUILD_ENVIRONMENT: { key: 'aws:cdk:pipelines:codebuildstep:buildenvironment', category: 'CodeBuildStep', label: 'Build Environment', type: 'string' },
  CACHE: { key: 'aws:cdk:pipelines:codebuildstep:cache', category: 'CodeBuildStep', label: 'Cache', type: 'string' },
  COMMANDS: { key: 'aws:cdk:pipelines:codebuildstep:commands', category: 'CodeBuildStep', label: 'Commands', type: 'string' },
  CODE_BUILD_ENV: { key: 'aws:cdk:pipelines:codebuildstep:env', category: 'CodeBuildStep', label: 'Environment', type: 'string' },
  ENV_FROM_CFN_OUTPUTS: { key: 'aws:cdk:pipelines:codebuildstep:envfromcfnoutputs', category: 'CodeBuildStep', label: 'Env from CFN Outputs', type: 'string' },
  FILE_SYSTEM_LOCATIONS: { key: 'aws:cdk:pipelines:codebuildstep:filesystemlocations', category: 'CodeBuildStep', label: 'File System Locations', type: 'string' },
  INPUT: { key: 'aws:cdk:pipelines:codebuildstep:input', category: 'CodeBuildStep', label: 'Input', type: 'string' },
  INSTALL_COMMANDS: { key: 'aws:cdk:pipelines:codebuildstep:installcommands', category: 'CodeBuildStep', label: 'Install Commands', type: 'string' },
  LOGGING: { key: 'aws:cdk:pipelines:codebuildstep:logging', category: 'CodeBuildStep', label: 'Logging', type: 'string' },
  PARTIAL_BUILD_SPEC: { key: 'aws:cdk:pipelines:codebuildstep:partialbuildspec', category: 'CodeBuildStep', label: 'Partial Build Spec', type: 'string' },
  PRIMARY_OUTPUT_DIRECTORY: { key: 'aws:cdk:pipelines:codebuildstep:primaryoutputdirectory', category: 'CodeBuildStep', label: 'Primary Output Directory', type: 'string' },
  PROJECT_NAME: { key: 'aws:cdk:pipelines:codebuildstep:projectname', category: 'CodeBuildStep', label: 'Project Name', type: 'string' },
  STEP_ROLE: { key: 'aws:cdk:pipelines:codebuildstep:role', category: 'CodeBuildStep', label: 'Step Role', type: 'string' },
  ROLE_POLICY_STATEMENTS: { key: 'aws:cdk:pipelines:codebuildstep:rolepolicystatements', category: 'CodeBuildStep', label: 'Role Policy Statements', type: 'string' },
  TIMEOUT: { key: 'aws:cdk:pipelines:codebuildstep:timeout', category: 'CodeBuildStep', label: 'Timeout', type: 'string' },

  // ── ShellStep (namespace: pipelines:shellstep) ──
  SHELL_ADDITIONAL_INPUTS: { key: 'aws:cdk:pipelines:shellstep:additionalinputs', category: 'ShellStep', label: 'Additional Inputs', type: 'string' },
  SHELL_COMMANDS: { key: 'aws:cdk:pipelines:shellstep:commands', category: 'ShellStep', label: 'Commands', type: 'string' },
  SHELL_ENV: { key: 'aws:cdk:pipelines:shellstep:env', category: 'ShellStep', label: 'Environment', type: 'string' },
  SHELL_ENV_FROM_CFN_OUTPUTS: { key: 'aws:cdk:pipelines:shellstep:envfromcfnoutputs', category: 'ShellStep', label: 'Env from CFN Outputs', type: 'string' },
  SHELL_INPUT: { key: 'aws:cdk:pipelines:shellstep:input', category: 'ShellStep', label: 'Input', type: 'string' },
  SHELL_INSTALL_COMMANDS: { key: 'aws:cdk:pipelines:shellstep:installcommands', category: 'ShellStep', label: 'Install Commands', type: 'string' },
  SHELL_PRIMARY_OUTPUT_DIRECTORY: { key: 'aws:cdk:pipelines:shellstep:primaryoutputdirectory', category: 'ShellStep', label: 'Primary Output Directory', type: 'string' },

  // ── BuildEnvironment (namespace: codebuild:buildenvironment) ──
  PRIVILEGED: { key: 'aws:cdk:codebuild:buildenvironment:privileged', category: 'Build Environment', label: 'Privileged', type: 'boolean' },
  BUILD_IMAGE: { key: 'aws:cdk:codebuild:buildenvironment:buildimage', category: 'Build Environment', label: 'Build Image', type: 'string' },
  CERTIFICATE: { key: 'aws:cdk:codebuild:buildenvironment:certificate', category: 'Build Environment', label: 'Certificate', type: 'string' },
  COMPUTE_TYPE: { key: 'aws:cdk:codebuild:buildenvironment:computetype', category: 'Build Environment', label: 'Compute Type', type: 'string' },
  DOCKER_SERVER: { key: 'aws:cdk:codebuild:buildenvironment:dockerserver', category: 'Build Environment', label: 'Docker Server', type: 'string' },
  ENVIRONMENT_VARIABLES: { key: 'aws:cdk:codebuild:buildenvironment:environmentvariables', category: 'Build Environment', label: 'Environment Variables', type: 'string' },
  FLEET: { key: 'aws:cdk:codebuild:buildenvironment:fleet', category: 'Build Environment', label: 'Fleet', type: 'string' },

  // ── Network configuration (namespace: ec2:network) ──
  NETWORK_TYPE: { key: 'aws:cdk:ec2:network:type', category: 'Network', label: 'Network Type', type: 'string' },
  NETWORK_VPC_ID: { key: 'aws:cdk:ec2:network:vpcid', category: 'Network', label: 'VPC ID', type: 'string' },
  NETWORK_SUBNET_IDS: { key: 'aws:cdk:ec2:network:subnetids', category: 'Network', label: 'Subnet IDs', type: 'string' },
  NETWORK_SUBNET_TYPE: { key: 'aws:cdk:ec2:network:subnettype', category: 'Network', label: 'Subnet Type', type: 'string' },
  NETWORK_AVAILABILITY_ZONES: { key: 'aws:cdk:ec2:network:availabilityzones', category: 'Network', label: 'Availability Zones', type: 'string' },
  NETWORK_SUBNET_GROUP_NAME: { key: 'aws:cdk:ec2:network:subnetgroupname', category: 'Network', label: 'Subnet Group Name', type: 'string' },
  NETWORK_SECURITY_GROUP_IDS: { key: 'aws:cdk:ec2:network:securitygroupids', category: 'Network', label: 'Security Group IDs', type: 'string' },
  NETWORK_TAGS: { key: 'aws:cdk:ec2:network:tags', category: 'Network', label: 'VPC Lookup Tags', type: 'string' },
  NETWORK_VPC_NAME: { key: 'aws:cdk:ec2:network:vpcname', category: 'Network', label: 'VPC Name', type: 'string' },
  NETWORK_REGION: { key: 'aws:cdk:ec2:network:region', category: 'Network', label: 'Region', type: 'string' },

  // ── IAM role configuration (namespace: iam:role) ──
  ROLE_TYPE: { key: 'aws:cdk:iam:role:type', category: 'IAM Role', label: 'Role Type', type: 'string' },
  ROLE_ARN: { key: 'aws:cdk:iam:role:rolearn', category: 'IAM Role', label: 'Role ARN', type: 'string' },
  ROLE_NAME: { key: 'aws:cdk:iam:role:rolename', category: 'IAM Role', label: 'Role Name', type: 'string' },
  ROLE_MUTABLE: { key: 'aws:cdk:iam:role:mutable', category: 'IAM Role', label: 'Mutable', type: 'boolean' },

  // ── Security group configuration (namespace: ec2:securitygroup) ──
  SECURITY_GROUP_TYPE: { key: 'aws:cdk:ec2:securitygroup:type', category: 'Security Group', label: 'Security Group Type', type: 'string' },
  SECURITY_GROUP_IDS: { key: 'aws:cdk:ec2:securitygroup:securitygroupids', category: 'Security Group', label: 'Security Group IDs', type: 'string' },
  SECURITY_GROUP_MUTABLE: { key: 'aws:cdk:ec2:securitygroup:mutable', category: 'Security Group', label: 'Mutable', type: 'boolean' },
  SECURITY_GROUP_NAME: { key: 'aws:cdk:ec2:securitygroup:securitygroupname', category: 'Security Group', label: 'Security Group Name', type: 'string' },
  SECURITY_GROUP_VPC_ID: { key: 'aws:cdk:ec2:securitygroup:vpcid', category: 'Security Group', label: 'VPC ID', type: 'string' },

  // ── Notifications (namespace: notifications) ──
  NOTIFICATION_TOPIC_ARN: { key: 'aws:cdk:notifications:topic:arn', category: 'Notifications', label: 'SNS Topic ARN', type: 'string' },
  NOTIFICATION_EVENTS: { key: 'aws:cdk:notifications:events', category: 'Notifications', label: 'Notification Events', type: 'string' },

  // ── Pipeline operations (namespace: operations — custom synth in PipelineBuilder) ──
  ENABLE_EXECUTION_EVENTS: { key: 'aws:cdk:operations:executionevents', category: 'Operations', label: 'Enable execution event tracking', type: 'boolean' },
  ENABLE_METRICS: { key: 'aws:cdk:operations:metrics', category: 'Operations', label: 'Enable CloudWatch failure alarms', type: 'boolean' },
  ARTIFACT_RETENTION_DAYS: { key: 'aws:cdk:operations:artifactretentiondays', category: 'Operations', label: 'Artifact retention in days', type: 'string' },
  PIPELINE_VARIABLES: { key: 'aws:cdk:operations:variables', category: 'Operations', label: 'Pipeline runtime variables (JSON)', type: 'string' },

  // ── Encryption (namespace: encryption — custom synth in PipelineBuilder) ──
  KMS_KEY_ARN: { key: 'aws:cdk:encryption:kmskeyarn', category: 'Encryption', label: 'Custom KMS key ARN for artifacts', type: 'string' },
} as const satisfies Record<string, MetadataKeyEntry>;

/** Constant name → `aws:cdk:…` key, for typo-free synth-time authoring. */
export const MetadataKeys = Object.freeze(
  Object.fromEntries(
    Object.entries(METADATA_KEY_CATALOG).map(([name, entry]) => [name, entry.key]),
  ),
) as { readonly [K in keyof typeof METADATA_KEY_CATALOG]: (typeof METADATA_KEY_CATALOG)[K]['key'] };

/** Any supported metadata key. */
export type MetadataKey = (typeof MetadataKeys)[keyof typeof MetadataKeys];

/** One picker option. */
export interface MetadataKeyOption {
  key: string;
  label: string;
  type: MetadataKeyType;
}

/** One picker group. */
export interface MetadataKeyGroup {
  category: string;
  keys: MetadataKeyOption[];
}

/**
 * The catalog grouped by category, in declaration order — what the pipeline
 * form builder's metadata picker renders.
 */
export const METADATA_KEY_GROUPS: readonly MetadataKeyGroup[] = (() => {
  const groups: MetadataKeyGroup[] = [];
  for (const entry of Object.values(METADATA_KEY_CATALOG) as readonly MetadataKeyEntry[]) {
    let group = groups.find((g) => g.category === entry.category);
    if (!group) {
      group = { category: entry.category, keys: [] };
      groups.push(group);
    }
    group.keys.push({ key: entry.key, label: entry.label, type: entry.type });
  }
  return groups;
})();
