// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';

/** Structured-output schema for AI pipeline generation — the BuilderProps shape the model must produce. */

const PluginFilterSchema = z.object({
  version: z.string().optional().describe('Semantic version of the plugin'),
  visibility: z.enum(['public', 'private']).optional().describe('Plugin visibility'),
  isActive: z.boolean().optional().describe('Whether the plugin is active'),
  isDefault: z.boolean().optional().describe('Whether to use the default version of this plugin'),
}).optional().describe('Optional filter criteria for plugin resolution');

const PluginOptionsSchema = z.object({
  name: z.string().describe('Plugin name (must match an available plugin)'),
  publisher: z.string().optional().describe('The plugin\'s publisher, exactly as listed — ONLY for a plugin listed with a publisher'),
  alias: z.string().optional().describe('Optional alias for the plugin instance'),
  filter: PluginFilterSchema.describe('Plugin filter — set isDefault: true to use the default version'),
});

const StepCustomizationSchema = z.object({
  preInstallCommands: z.array(z.string()).optional().describe('Commands to run before the plugin install commands'),
  postInstallCommands: z.array(z.string()).optional().describe('Commands to run after the plugin install commands'),
  preCommands: z.array(z.string()).optional().describe('Commands to run before the plugin build commands'),
  postCommands: z.array(z.string()).optional().describe('Commands to run after the plugin build commands'),
  env: z.record(z.string(), z.string()).optional().describe('Environment variables for this step'),
});

const SourceSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('github'),
    options: z.object({
      repo: z.string().describe('GitHub repository in format "owner/repo"'),
      branch: z.string().optional().describe('Branch name, defaults to "main"'),
      trigger: z.enum(['NONE', 'AUTO', 'SCHEDULE']).optional().describe('Trigger behavior'),
    }),
  }),
  z.object({
    type: z.literal('s3'),
    options: z.object({
      bucketName: z.string().describe('S3 bucket name'),
      objectKey: z.string().optional().describe('Object key, defaults to "source.zip"'),
      trigger: z.enum(['NONE', 'AUTO', 'SCHEDULE']).optional(),
    }),
  }),
  z.object({
    type: z.literal('codestar'),
    options: z.object({
      repo: z.string().describe('Repository in format "owner/repo"'),
      branch: z.string().optional().describe('Branch name, defaults to "main"'),
      connectionArn: z.string().describe('CodeStar connection ARN'),
      trigger: z.enum(['NONE', 'AUTO', 'SCHEDULE']).optional(),
      codeBuildCloneOutput: z.boolean().optional(),
    }),
  }),
  z.object({
    type: z.literal('codecommit'),
    options: z.object({
      repositoryName: z.string().describe('CodeCommit repository name'),
      branch: z.string().optional().describe('Branch name, defaults to "main"'),
      trigger: z.enum(['NONE', 'AUTO', 'SCHEDULE']).optional(),
    }),
  }),
]);

const StageStepSchema = StepCustomizationSchema.extend({
  plugin: PluginOptionsSchema,
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  position: z.enum(['pre', 'post']).optional().describe('Step position: "pre" (before deploy) or "post" (after deploy)'),
  timeout: z.number().optional().describe('CodeBuild timeout in minutes'),
  failureBehavior: z.enum(['fail', 'warn', 'ignore']).optional().describe('What happens when this step fails: fail (stop), warn (log and continue), ignore (silent continue)'),
  inputArtifact: z.string().optional().describe('Name of a previous stage step to use as input artifact for cross-stage file passing'),
});

const StageSchema = z.object({
  stageName: z.string().describe('Display name for this stage'),
  alias: z.string().optional().describe('Optional alias for construct ID generation'),
  steps: z.array(StageStepSchema).describe('Build steps within this stage'),
});

const SynthSchema = StepCustomizationSchema.extend({
  source: SourceSchema,
  plugin: PluginOptionsSchema,
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});

export const PipelineGenerationSchema = z.object({
  project: z.string().describe('Project identifier (lowercase, alphanumeric with hyphens)'),
  organization: z.string().describe('Organization identifier (lowercase, alphanumeric with hyphens)'),
  pipelineName: z.string().optional().describe('Optional custom pipeline name'),
  description: z.string().optional().describe('Human-readable description of the pipeline'),
  keywords: z.array(z.string()).optional().describe('Keywords for categorizing this pipeline'),
  synth: SynthSchema.describe('Synthesis step configuration'),
  stages: z.array(StageSchema).optional().describe('Pipeline stages after synth'),
  global: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe('Global metadata inherited by all steps'),
  vars: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe('Pipeline-level variables referenced as {{ pipeline.vars.NAME }} in step commands/env — populate ONLY when the user asks for a parameterized pipeline, declaring each variable here with a sensible default'),
  role: z.object({
    roleArn: z.string().optional().describe('ARN of an existing IAM role for the pipeline'),
    roleName: z.string().optional().describe('Name of an existing IAM role to look up'),
  }).optional().describe('Custom IAM role for the CodePipeline'),
  schedule: z.string().optional().describe('Cron or rate expression for scheduled pipeline execution (e.g., "rate(1 day)" or "cron(0 0 * * ? *)")'),
  defaults: z.object({
    network: z.object({
      vpcId: z.string().optional().describe('VPC ID for CodeBuild actions'),
      subnetIds: z.array(z.string()).optional().describe('Subnet IDs for CodeBuild'),
    }).optional(),
  }).optional().describe('Pipeline-level CodeBuild defaults'),
});
