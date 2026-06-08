// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { KeyRound } from 'lucide-react';
import type { HelpTopic } from './types';

export const metadataKeysTopic: HelpTopic = {
  id: 'metadata-keys',
  title: 'Metadata Keys',
  description: 'Strongly-typed keys for customizing CodePipeline and CodeBuild resources at synth time',
  icon: KeyRound,
  sections: [
    {
      id: 'overview',
      title: 'Overview',
      blocks: [
        {
          type: 'text',
          content:
            'Metadata keys are strongly-typed configuration keys for customizing CodePipeline and CodeBuild resources at synth time. Import the MetadataKeys constant from @mwashburn160/pipeline-core. Both the typed constant and its raw string value are interchangeable, so you can use them from TypeScript or from JSON pipeline definitions.',
        },
        {
          type: 'text',
          content:
            'Keys override default behavior at three levels: pipeline-wide (via global), per-stage, or per-step (via metadata on individual plugin references). Every key is consumed by one of three mechanisms, noted per section below.',
        },
        {
          type: 'list',
          items: [
            'Construct prop — passed straight to a CDK construct via NAMESPACE_KEY_MAP.',
            'Typed config — parsed into a discriminated-union config (network / IAM role / security group) and resolved by the builder.',
            'Custom synth — read directly in PipelineBuilder to create or configure resources (notifications, operations, encryption).',
          ],
        },
      ],
    },
    {
      id: 'scope-levels',
      title: 'Scope Levels',
      blocks: [
        {
          type: 'text',
          content:
            'Keys can be applied at different scopes. More specific scopes override broader ones. At synth time, keys are merged global → stage → step into a single metadata map before being routed to their consumer.',
        },
        {
          type: 'table',
          headers: ['Scope', 'Where to set', 'Applies to'],
          rows: [
            ['Global', 'BuilderProps.global', 'All steps in the pipeline'],
            ['Stage', 'Stage-level metadata', 'All steps in that stage'],
            ['Step', 'Step-level metadata', 'That specific build step only'],
          ],
        },
      ],
    },
    {
      id: 'pipeline-build-config',
      title: 'Pipeline & Build Configuration',
      blocks: [
        {
          type: 'text',
          content:
            'Construct-prop keys spread directly into the matching CDK construct props. Boolean values are coerced from "true"/"false". CodePipeline keys control pipeline-level behavior; CodeBuild step keys customize individual build steps (CACHE and TIMEOUT are the canonical caching/timeout keys); Shell step keys override ShellStep behavior; Build environment keys configure compute, images, and Docker.',
        },
        {
          type: 'table',
          headers: ['MetadataKeys constant', 'String value'],
          rows: [
            ['SELF_MUTATION', 'aws:cdk:pipelines:codepipeline:selfmutation'],
            ['CROSS_ACCOUNT_KEYS', 'aws:cdk:pipelines:codepipeline:crossaccountkeys'],
            ['DOCKER_ENABLED_FOR_SYNTH', 'aws:cdk:pipelines:codepipeline:dockerenabledforsynth'],
            ['ENABLE_KEY_ROTATION', 'aws:cdk:pipelines:codepipeline:enablekeyrotation'],
            ['PUBLISH_ASSETS_IN_PARALLEL', 'aws:cdk:pipelines:codepipeline:publishassetsinparallel'],
            ['USE_CHANGE_SETS', 'aws:cdk:pipelines:codepipeline:usechangesets'],
            ['ARTIFACT_BUCKET', 'aws:cdk:pipelines:codepipeline:artifactbucket'],
            ['PIPELINE_NAME', 'aws:cdk:pipelines:codepipeline:pipelinename'],
            ['PIPELINE_TYPE', 'aws:cdk:pipelines:codepipeline:pipelinetype'],
            ['PIPELINE_ROLE', 'aws:cdk:pipelines:codepipeline:role'],
            ['SYNTH', 'aws:cdk:pipelines:codepipeline:synth'],
            ['CACHE', 'aws:cdk:pipelines:codebuildstep:cache'],
            ['TIMEOUT', 'aws:cdk:pipelines:codebuildstep:timeout'],
            ['COMMANDS', 'aws:cdk:pipelines:codebuildstep:commands'],
            ['INSTALL_COMMANDS', 'aws:cdk:pipelines:codebuildstep:installcommands'],
            ['STEP_ROLE', 'aws:cdk:pipelines:codebuildstep:role'],
            ['ROLE_POLICY_STATEMENTS', 'aws:cdk:pipelines:codebuildstep:rolepolicystatements'],
            ['PRIMARY_OUTPUT_DIRECTORY', 'aws:cdk:pipelines:codebuildstep:primaryoutputdirectory'],
            ['SHELL_COMMANDS', 'aws:cdk:pipelines:shellstep:commands'],
            ['SHELL_INSTALL_COMMANDS', 'aws:cdk:pipelines:shellstep:installcommands'],
            ['SHELL_ENV', 'aws:cdk:pipelines:shellstep:env'],
            ['COMPUTE_TYPE', 'aws:cdk:codebuild:buildenvironment:computetype'],
            ['BUILD_IMAGE', 'aws:cdk:codebuild:buildenvironment:buildimage'],
            ['PRIVILEGED', 'aws:cdk:codebuild:buildenvironment:privileged'],
            ['ENVIRONMENT_VARIABLES', 'aws:cdk:codebuild:buildenvironment:environmentvariables'],
            ['FLEET', 'aws:cdk:codebuild:buildenvironment:fleet'],
          ],
        },
        {
          type: 'note',
          content:
            'This table lists the most common keys. The full set also includes additional CodePipeline defaults (CODE_BUILD_DEFAULTS, SYNTH_CODE_BUILD_DEFAULTS, CLI_VERSION, etc.), step inputs (INPUT, ADDITIONAL_INPUTS, ENV_FROM_CFN_OUTPUTS), and build environment keys (CERTIFICATE, DOCKER_SERVER).',
        },
      ],
    },
    {
      id: 'typed-config',
      title: 'Typed Config: Network, IAM Role, Security Group',
      blocks: [
        {
          type: 'text',
          content:
            'These keys are parsed into discriminated-union configs and materialized by the builder. They follow prop > metadata > env precedence: an explicit BuilderProps value wins, then metadata, then environment defaults. Network keys place builds inside a VPC; IAM role keys import existing roles; security group keys attach security groups to build containers.',
        },
        {
          type: 'table',
          headers: ['MetadataKeys constant', 'String value'],
          rows: [
            ['NETWORK_TYPE', 'aws:cdk:ec2:network:type'],
            ['NETWORK_VPC_ID', 'aws:cdk:ec2:network:vpcid'],
            ['NETWORK_SUBNET_IDS', 'aws:cdk:ec2:network:subnetids'],
            ['NETWORK_SUBNET_TYPE', 'aws:cdk:ec2:network:subnettype'],
            ['NETWORK_SECURITY_GROUP_IDS', 'aws:cdk:ec2:network:securitygroupids'],
            ['NETWORK_AVAILABILITY_ZONES', 'aws:cdk:ec2:network:availabilityzones'],
            ['NETWORK_REGION', 'aws:cdk:ec2:network:region'],
            ['ROLE_TYPE', 'aws:cdk:iam:role:type'],
            ['ROLE_ARN', 'aws:cdk:iam:role:rolearn'],
            ['ROLE_NAME', 'aws:cdk:iam:role:rolename'],
            ['ROLE_MUTABLE', 'aws:cdk:iam:role:mutable'],
            ['SECURITY_GROUP_TYPE', 'aws:cdk:ec2:securitygroup:type'],
            ['SECURITY_GROUP_IDS', 'aws:cdk:ec2:securitygroup:securitygroupids'],
            ['SECURITY_GROUP_VPC_ID', 'aws:cdk:ec2:securitygroup:vpcid'],
            ['SECURITY_GROUP_MUTABLE', 'aws:cdk:ec2:securitygroup:mutable'],
          ],
        },
        {
          type: 'note',
          content:
            'VPC builds require a NAT Gateway or VPC endpoints for pulling dependencies and reporting status back to CodePipeline.',
        },
      ],
    },
    {
      id: 'custom-synth',
      title: 'Custom Synth: Notifications, Operations, Encryption',
      blocks: [
        {
          type: 'text',
          content:
            'These keys are read directly in PipelineBuilder to create or configure resources. Notifications trigger pipeline.notifyOn() with the parsed events; operations keys control execution tracking, metrics, retention, and pipeline variables; encryption attaches a customer-managed KMS key.',
        },
        {
          type: 'table',
          headers: ['MetadataKeys constant', 'String value', 'Effect'],
          rows: [
            ['NOTIFICATION_TOPIC_ARN', 'aws:cdk:notifications:topic:arn', 'SNS topic to notify on pipeline events'],
            ['NOTIFICATION_EVENTS', 'aws:cdk:notifications:events', 'Comma list: FAILED, SUCCEEDED, STARTED, CANCELED, SUPERSEDED (default FAILED,SUCCEEDED)'],
            ['ENABLE_EXECUTION_EVENTS', 'aws:cdk:operations:executionevents', 'Forwards execution state changes to the SNS topic. Requires NOTIFICATION_TOPIC_ARN.'],
            ['ENABLE_METRICS', 'aws:cdk:operations:metrics', 'Creates a CloudWatch alarm on FailedPipelineExecutionCount.'],
            ['ARTIFACT_RETENTION_DAYS', 'aws:cdk:operations:artifactretentiondays', 'Adds an S3 lifecycle expiration rule to a custom artifact bucket.'],
            ['PIPELINE_VARIABLES', 'aws:cdk:operations:variables', 'Declares CodePipeline V2 pipeline-level variables (JSON array or name=default comma list).'],
            ['KMS_KEY_ARN', 'aws:cdk:encryption:kmskeyarn', 'Attaches a customer-managed KMS key to a custom artifact bucket.'],
          ],
        },
        {
          type: 'note',
          content:
            'Setting ARTIFACT_RETENTION_DAYS and/or KMS_KEY_ARN causes PipelineBuilder to create a dedicated artifact bucket (enforceSSL, public access blocked, RemovalPolicy.DESTROY + autoDeleteObjects). With neither key set, CDK auto-creates the default artifact bucket.',
        },
      ],
    },
    {
      id: 'usage',
      title: 'Usage',
      blocks: [
        {
          type: 'text',
          content:
            'Both the typed constant and the raw string value are interchangeable. Use the constant from TypeScript, or the string value in JSON pipeline definitions.',
        },
        {
          type: 'code',
          language: 'typescript',
          content: `import { PipelineBuilder, MetadataKeys } from '@mwashburn160/pipeline-core';

new PipelineBuilder(stack, 'Pipeline', {
  project: 'secure-app',
  organization: 'enterprise',
  global: {
    [MetadataKeys.CROSS_ACCOUNT_KEYS]: true,
    [MetadataKeys.DOCKER_ENABLED_FOR_SYNTH]: true,
    [MetadataKeys.SELF_MUTATION]: true,
  },
  synth: {
    source: { /* ... */ },
    plugin: { name: 'cdk-synth', version: '1.0.0' },
    metadata: {
      [MetadataKeys.COMPUTE_TYPE]: 'BUILD_GENERAL1_LARGE',
      [MetadataKeys.TIMEOUT]: '60',
    },
  },
});`,
        },
        {
          type: 'code',
          language: 'json',
          content: `"metadata": {
  "aws:cdk:codebuild:buildenvironment:computetype": "BUILD_GENERAL1_LARGE"
}`,
        },
      ],
    },
  ],
};
