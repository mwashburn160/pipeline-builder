import type { CodeStarSource, GitHubSource, S3Source } from '../pipeline/source-types';

// Re-export shared types from api-common to maintain backward compatibility
export { AccessModifier, ComputeType, PluginType, MetaDataType } from '@mwashburn160/api-core';

/**
 * Utility type to extract the union of all values from an object type
 */
type ValueOf<T> = T[keyof T];

/**
 * Pipeline trigger behavior
 *
 * @property NONE - Manual trigger only, pipeline does not start automatically
 * @property POLL - Automatic trigger on source changes (polls source for changes)
 */
export const TriggerType = {
  NONE: 'NONE',
  POLL: 'POLL',
} as const;
export type TriggerType = ValueOf<typeof TriggerType>;

/**
 * Union type of all supported pipeline source types
 *
 * Supported sources:
 * - S3Source: Source code from S3 bucket
 * - GitHubSource: Source code from GitHub repository
 * - CodeStarSource: Source code via CodeStar connection (GitHub, Bitbucket, GitLab)
 */
export type SourceType = S3Source | GitHubSource | CodeStarSource;

/**
 * Constants for metadata keys to avoid string typos.
 *
 * Key format: `aws:cdk:{namespace}:{property}` (all lowercase).
 * These match the keys produced by `getCustomKey(namespace, property)`
 * and looked up by `buildConfigFromMetadata`.
 *
 * @example
 * ```typescript
 * const metadata = {
 *   [MetadataKeys.SELF_MUTATION]: true,
 *   [MetadataKeys.PUBLISH_ASSETS_IN_PARALLEL]: true
 * };
 * ```
 */
export const MetadataKeys = {
  // ── CodePipeline (namespace: pipelines:codepipeline) ──
  SELF_MUTATION: 'aws:cdk:pipelines:codepipeline:selfmutation',
  CROSS_ACCOUNT_KEYS: 'aws:cdk:pipelines:codepipeline:crossaccountkeys',
  DOCKER_ENABLED_FOR_SELF_MUTATION: 'aws:cdk:pipelines:codepipeline:dockerenabledforselfmutation',
  DOCKER_ENABLED_FOR_SYNTH: 'aws:cdk:pipelines:codepipeline:dockerenabledforsynth',
  ENABLE_KEY_ROTATION: 'aws:cdk:pipelines:codepipeline:enablekeyrotation',
  PUBLISH_ASSETS_IN_PARALLEL: 'aws:cdk:pipelines:codepipeline:publishassetsinparallel',
  REUSE_CROSS_REGION_SUPPORT_STACKS: 'aws:cdk:pipelines:codepipeline:reusecrossregionsupportstacks',
  USE_CHANGE_SETS: 'aws:cdk:pipelines:codepipeline:usechangesets',
  USE_PIPELINE_ROLE_FOR_ACTIONS: 'aws:cdk:pipelines:codepipeline:usepipelineroleforactions',
  ARTIFACT_BUCKET: 'aws:cdk:pipelines:codepipeline:artifactbucket',
  ASSET_PUBLISHING_CODE_BUILD_DEFAULTS: 'aws:cdk:pipelines:codepipeline:assetpublishingcodebuilddefaults',
  CDK_ASSETS_CLI_VERSION: 'aws:cdk:pipelines:codepipeline:cdkassetscliversion',
  CLI_VERSION: 'aws:cdk:pipelines:codepipeline:cliversion',
  CODE_BUILD_DEFAULTS: 'aws:cdk:pipelines:codepipeline:codebuilddefaults',
  CODE_PIPELINE: 'aws:cdk:pipelines:codepipeline:codepipeline',
  CROSS_REGION_REPLICATION_BUCKETS: 'aws:cdk:pipelines:codepipeline:crossregionreplicationbuckets',
  DOCKER_CREDENTIALS: 'aws:cdk:pipelines:codepipeline:dockercredentials',
  PIPELINE_NAME: 'aws:cdk:pipelines:codepipeline:pipelinename',
  PIPELINE_TYPE: 'aws:cdk:pipelines:codepipeline:pipelinetype',
  PIPELINE_ROLE: 'aws:cdk:pipelines:codepipeline:role',
  SELF_MUTATION_CODE_BUILD_DEFAULTS: 'aws:cdk:pipelines:codepipeline:selfmutationcodebuilddefaults',
  SYNTH: 'aws:cdk:pipelines:codepipeline:synth',
  SYNTH_CODE_BUILD_DEFAULTS: 'aws:cdk:pipelines:codepipeline:synthcodebuilddefaults',

  // ── CodeBuildStep (namespace: pipelines:codebuildstep) ──
  ACTION_ROLE: 'aws:cdk:pipelines:codebuildstep:actionrole',
  ADDITIONAL_INPUTS: 'aws:cdk:pipelines:codebuildstep:additionalinputs',
  BUILD_ENVIRONMENT: 'aws:cdk:pipelines:codebuildstep:buildenvironment',
  CACHE: 'aws:cdk:pipelines:codebuildstep:cache',
  COMMANDS: 'aws:cdk:pipelines:codebuildstep:commands',
  CODE_BUILD_ENV: 'aws:cdk:pipelines:codebuildstep:env',
  ENV_FROM_CFN_OUTPUTS: 'aws:cdk:pipelines:codebuildstep:envfromcfnoutputs',
  FILE_SYSTEM_LOCATIONS: 'aws:cdk:pipelines:codebuildstep:filesystemlocations',
  INPUT: 'aws:cdk:pipelines:codebuildstep:input',
  INSTALL_COMMANDS: 'aws:cdk:pipelines:codebuildstep:installcommands',
  LOGGING: 'aws:cdk:pipelines:codebuildstep:logging',
  PARTIAL_BUILD_SPEC: 'aws:cdk:pipelines:codebuildstep:partialbuildspec',
  PRIMARY_OUTPUT_DIRECTORY: 'aws:cdk:pipelines:codebuildstep:primaryoutputdirectory',
  PROJECT_NAME: 'aws:cdk:pipelines:codebuildstep:projectname',
  STEP_ROLE: 'aws:cdk:pipelines:codebuildstep:role',
  ROLE_POLICY_STATEMENTS: 'aws:cdk:pipelines:codebuildstep:rolepolicystatements',
  TIMEOUT: 'aws:cdk:pipelines:codebuildstep:timeout',

  // ── ShellStep (namespace: pipelines:shellstep) ──
  SHELL_ADDITIONAL_INPUTS: 'aws:cdk:pipelines:shellstep:additionalinputs',
  SHELL_COMMANDS: 'aws:cdk:pipelines:shellstep:commands',
  SHELL_ENV: 'aws:cdk:pipelines:shellstep:env',
  SHELL_ENV_FROM_CFN_OUTPUTS: 'aws:cdk:pipelines:shellstep:envfromcfnoutputs',
  SHELL_INPUT: 'aws:cdk:pipelines:shellstep:input',
  SHELL_INSTALL_COMMANDS: 'aws:cdk:pipelines:shellstep:installcommands',
  SHELL_PRIMARY_OUTPUT_DIRECTORY: 'aws:cdk:pipelines:shellstep:primaryoutputdirectory',

  // ── BuildEnvironment (namespace: codebuild:buildenvironment) ──
  PRIVILEGED: 'aws:cdk:codebuild:buildenvironment:privileged',
  BUILD_IMAGE: 'aws:cdk:codebuild:buildenvironment:buildimage',
  CERTIFICATE: 'aws:cdk:codebuild:buildenvironment:certificate',
  COMPUTE_TYPE: 'aws:cdk:codebuild:buildenvironment:computetype',
  DOCKER_SERVER: 'aws:cdk:codebuild:buildenvironment:dockerserver',
  ENVIRONMENT_VARIABLES: 'aws:cdk:codebuild:buildenvironment:environmentvariables',
  FLEET: 'aws:cdk:codebuild:buildenvironment:fleet',

  // ── Network configuration (namespace: ec2:network) ──
  NETWORK_TYPE: 'aws:cdk:ec2:network:type',
  NETWORK_VPC_ID: 'aws:cdk:ec2:network:vpcid',
  NETWORK_SUBNET_IDS: 'aws:cdk:ec2:network:subnetids',
  NETWORK_SUBNET_TYPE: 'aws:cdk:ec2:network:subnettype',
  NETWORK_AVAILABILITY_ZONES: 'aws:cdk:ec2:network:availabilityzones',
  NETWORK_SUBNET_GROUP_NAME: 'aws:cdk:ec2:network:subnetgroupname',
  NETWORK_SECURITY_GROUP_IDS: 'aws:cdk:ec2:network:securitygroupids',
  NETWORK_TAGS: 'aws:cdk:ec2:network:tags',
  NETWORK_VPC_NAME: 'aws:cdk:ec2:network:vpcname',
  NETWORK_REGION: 'aws:cdk:ec2:network:region',

  // ── IAM role configuration (namespace: iam:role) ──
  ROLE_TYPE: 'aws:cdk:iam:role:type',
  ROLE_ARN: 'aws:cdk:iam:role:roleArn',
  ROLE_NAME: 'aws:cdk:iam:role:rolename',
  ROLE_MUTABLE: 'aws:cdk:iam:role:mutable',

  // ── Security group configuration (namespace: ec2:securitygroup) ──
  SECURITY_GROUP_TYPE: 'aws:cdk:ec2:securitygroup:type',
  SECURITY_GROUP_IDS: 'aws:cdk:ec2:securitygroup:securitygroupids',
  SECURITY_GROUP_MUTABLE: 'aws:cdk:ec2:securitygroup:mutable',
  SECURITY_GROUP_NAME: 'aws:cdk:ec2:securitygroup:securitygroupname',
  SECURITY_GROUP_VPC_ID: 'aws:cdk:ec2:securitygroup:vpcid',

  // ── Custom build keys (namespace: build — not wired into NAMESPACE_KEY_MAP) ──
  BUILD_PARALLEL: 'aws:cdk:build:parallel',
  BUILD_CACHE: 'aws:cdk:build:cache',
  BUILD_TIMEOUT: 'aws:cdk:build:timeout',
} as const;

/**
 * Type for MetadataKeys values
 */
export type MetadataKey = typeof MetadataKeys[keyof typeof MetadataKeys];