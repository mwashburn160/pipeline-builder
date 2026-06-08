// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Boxes } from 'lucide-react';
import type { HelpTopic } from './types';

export const cdkUsageTopic: HelpTopic = {
  id: 'cdk-usage',
  title: 'CDK Usage',
  description: 'Define pipelines as infrastructure-as-code with the PipelineBuilder CDK construct',
  icon: Boxes,
  sections: [
    {
      id: 'overview',
      title: 'Overview',
      blocks: [
        {
          type: 'text',
          content:
            'Use the PipelineBuilder CDK construct to define pipelines as infrastructure-as-code. Pipelines deploy as native AWS CodePipeline + CodeBuild in your own AWS account, with build steps drawn from a catalog of 125 ready-to-use plugins.',
        },
        {
          type: 'code',
          language: 'bash',
          content: 'npm install @mwashburn160/pipeline-core',
        },
      ],
    },
    {
      id: 'quick-start',
      title: 'Quick Start',
      blocks: [
        {
          type: 'text',
          content:
            'Instantiate PipelineBuilder inside a CDK stack. A synth step is required; stages with build steps are optional.',
        },
        {
          type: 'code',
          language: 'typescript',
          content: `import { App, Stack } from 'aws-cdk-lib';
import { PipelineBuilder } from '@mwashburn160/pipeline-core';

const app = new App();
const stack = new Stack(app, 'MyPipelineStack', {
  env: { account: '123456789012', region: 'us-east-1' },
});

new PipelineBuilder(stack, 'MyPipeline', {
  project: 'my-app',
  organization: 'my-org',
  synth: {
    source: { type: 'github', options: { repo: 'my-org/my-app', branch: 'main' } },
    plugin: { name: 'cdk-synth', version: '1.0.0' },
  },
  stages: [
    { stageName: 'Test', steps: [{ plugin: { name: 'jest', version: '1.0.0' } }] },
    {
      stageName: 'Deploy',
      steps: [{ plugin: { name: 'cdk-deploy', version: '1.0.0' }, env: { ENVIRONMENT: 'production' } }],
    },
  ],
});`,
        },
      ],
    },
    {
      id: 'builder-props',
      title: 'BuilderProps Reference',
      blocks: [
        {
          type: 'table',
          headers: ['Property', 'Type', 'Required', 'Description'],
          rows: [
            ['project', 'string', 'Yes', 'Project identifier (sanitized to lowercase alphanumeric)'],
            ['organization', 'string', 'Yes', 'Organization identifier'],
            ['orgId', 'string', 'No', 'Tenant ID for resolving per-org secrets from Secrets Manager'],
            ['pipelineName', 'string', 'No', 'Custom name. Default: {organization}-{project}-pipeline'],
            ['synth', 'SynthOptions', 'Yes', 'Synthesis step configuration (source + plugin)'],
            ['stages', 'StageOptions[]', 'No', 'Pipeline stages, each with one or more build steps'],
            ['global', 'MetaDataType', 'No', 'Metadata inherited by all steps'],
            ['defaults', 'CodeBuildDefaults', 'No', 'Pipeline-level CodeBuild defaults (VPC, env vars)'],
            ['role', 'RoleConfig', 'No', 'IAM role for the CodePipeline (omit for auto-creation)'],
            ['schedule', 'string', 'No', 'Cron/rate expression for scheduled execution'],
            ['tags', 'Record<string, string>', 'No', 'Tags applied to all pipeline resources'],
          ],
        },
      ],
    },
    {
      id: 'sources',
      title: 'Source Types',
      blocks: [
        {
          type: 'text',
          content:
            'The synth step pulls source from one of four provider types: github, codestar (GitHub/Bitbucket/GitLab), s3, or codecommit. The trigger controls how runs start (AUTO, NONE, SCHEDULE).',
        },
        {
          type: 'code',
          language: 'typescript',
          content: `// GitHub
source: {
  type: 'github',
  options: { repo: 'my-org/my-app', branch: 'main', trigger: TriggerType.AUTO },
}

// CodeStar Connection (push-based webhook, no polling)
source: {
  type: 'codestar',
  options: {
    repo: 'my-org/my-app',
    branch: 'main',
    connectionArn: 'arn:aws:codestar-connections:us-east-1:123456789012:connection/abc-123',
    codeBuildCloneOutput: true,
    trigger: TriggerType.AUTO,
  },
}

// S3
source: {
  type: 's3',
  options: { bucketName: 'my-source-bucket', objectKey: 'source.zip', trigger: TriggerType.AUTO },
}

// CodeCommit
source: {
  type: 'codecommit',
  options: { repositoryName: 'my-repo', branch: 'main' },
}`,
        },
      ],
    },
    {
      id: 'stages-steps',
      title: 'Stages and Steps',
      blocks: [
        {
          type: 'text',
          content:
            'Each stage contains one or more steps, and each step references a plugin. Steps support per-step env vars, timeouts, failure behavior, and pre/post commands.',
        },
        {
          type: 'code',
          language: 'typescript',
          content: `stages: [
  {
    stageName: 'Quality',
    steps: [
      { plugin: { name: 'eslint', version: '1.0.0' }, failureBehavior: 'warn' },
      { plugin: { name: 'prettier', version: '1.0.0' }, failureBehavior: 'warn' },
    ],
  },
  {
    stageName: 'Test',
    steps: [{ plugin: { name: 'jest', version: '1.0.0' }, timeout: 30, env: { NODE_ENV: 'test' } }],
  },
];`,
        },
        {
          type: 'table',
          headers: ['Step Property', 'Type', 'Description'],
          rows: [
            ['plugin', 'PluginOptions', 'Plugin to run (name, version, alias, filter)'],
            ['env', 'Record<string, string>', 'Environment variables'],
            ['timeout', 'number', 'Max execution time in minutes'],
            ['position', "'pre' | 'post'", 'Before or after stage deployment (default: pre)'],
            ['failureBehavior', "'fail' | 'warn' | 'ignore'", 'Override plugin default'],
            ['network', 'NetworkConfig', 'Step-level VPC/subnet config'],
            ['inputArtifact', 'ArtifactKey', "Input from a previous step's output"],
          ],
        },
      ],
    },
    {
      id: 'network-roles',
      title: 'VPC and IAM Roles',
      blocks: [
        {
          type: 'text',
          content:
            'Set VPC networking at the pipeline level (via defaults.network) or override per step. Three network types are available: subnetIds (explicit), vpcId (lookup by ID), and vpcLookup (lookup by tags).',
        },
        {
          type: 'code',
          language: 'typescript',
          content: `defaults: {
  network: { type: 'vpcId', vpcId: 'vpc-abc123', subnetType: 'PRIVATE_WITH_EGRESS' },
}

// Step-level override
network: {
  type: 'subnetIds',
  vpcId: 'vpc-abc123',
  subnetIds: ['subnet-111', 'subnet-222'],
  securityGroupIds: ['sg-abc'],
}`,
        },
        {
          type: 'text',
          content: 'IAM control spans three levels, each with its own trust principal:',
        },
        {
          type: 'table',
          headers: ['Level', 'Config', 'Trust Principal'],
          rows: [
            ['Pipeline', 'BuilderProps.role', 'codepipeline.amazonaws.com'],
            ['Step project', 'codebuildstep:role metadata', 'codebuild.amazonaws.com'],
            ['Step action', 'codebuildstep:actionrole metadata', "Pipeline's role"],
          ],
        },
        {
          type: 'note',
          content:
            'Role types: roleArn (import by ARN), roleName (import by name), oidc (new role with OIDC federated trust), and codeBuildDefault (new role with codebuild trust, steps only).',
        },
      ],
    },
    {
      id: 'advanced',
      title: 'Secrets, Cross-Account, and Schedules',
      blocks: [
        {
          type: 'text',
          content:
            'Setting orgId enables per-org secret resolution from AWS Secrets Manager. Secrets a plugin declares are injected as SECRETS_MANAGER-type CodeBuild environment variables and resolved at build time from pipeline-builder/{orgId}/{SECRET_NAME}.',
        },
        {
          type: 'warning',
          content:
            'Secrets are injected at build time only — never stored in images or logs. Provide orgId for any pipeline whose plugins declare required secrets.',
        },
        {
          type: 'code',
          language: 'typescript',
          content: `// Cross-account: enable cross-account keys and set deploy target via env
global: { 'aws:cdk:pipelines:codepipeline:crossaccountkeys': 'true' },
// ...
steps: [{
  plugin: { name: 'cdk-deploy' },
  env: { CDK_DEPLOY_ACCOUNT: '222222222222', CDK_DEPLOY_REGION: 'us-west-2' },
}]

// Scheduled execution
schedule: 'cron(0 2 * * ? *)',   // Run at 2 AM UTC daily

// Artifact passing between steps
inputArtifact: {
  stageName: 'Build',
  pluginName: 'nodejs-build',
  pluginAlias: 'build-app',
  outputDirectory: 'dist',
}`,
        },
        {
          type: 'note',
          content:
            'Metadata keys (set at global, defaults, or step level) control fine-grained CDK behavior such as compute type, privileged mode, self-mutation, and notification topics. See the Metadata Keys doc for the full list of 80 keys.',
        },
      ],
    },
  ],
};
