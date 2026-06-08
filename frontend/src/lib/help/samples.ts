// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { FolderGit2 } from 'lucide-react';
import type { HelpTopic } from './types';

export const samplesTopic: HelpTopic = {
  id: 'samples',
  title: 'Samples',
  description: 'Ready-to-use pipeline configurations and CDK examples',
  icon: FolderGit2,
  sections: [
    {
      id: 'overview',
      title: 'Overview',
      blocks: [
        {
          type: 'text',
          content:
            'Pipeline Builder ships with ready-to-use pipeline configurations and CDK examples that demonstrate its capabilities. Use these as starting points for your own pipelines or as reference implementations for advanced patterns.',
        },
        {
          type: 'note',
          content: 'All sample files live under deploy/samples/ in the repository.',
        },
      ],
    },
    {
      id: 'pipeline-samples',
      title: 'Pipeline Samples',
      blocks: [
        {
          type: 'text',
          content:
            'Language-specific CI/CD pipelines based on well-known open source repos. Each sample demonstrates idiomatic build, test, security, and packaging stages for its language. Located in deploy/samples/pipelines/.',
        },
        {
          type: 'table',
          headers: ['Sample', 'Language', 'Source Repo', 'Stages'],
          rows: [
            ['react-javascript', 'JS/TS', 'facebook/react', 'Build, Test, Lint, Security, Publish'],
            ['spring-boot-java', 'Java', 'spring-projects/spring-boot', 'Build, Test, Lint, Security'],
            ['django-python', 'Python', 'django/django', 'Test, Lint, Security, Publish'],
            ['gin-golang', 'Go', 'gin-gonic/gin', 'Build, Test, Lint, Security'],
            ['axum-rust', 'Rust', 'tokio-rs/axum', 'Build, Test, Lint, Security, Publish'],
            ['rails-ruby', 'Ruby', 'rails/rails', 'Test, Lint, Security, Publish'],
            ['aspnetcore-dotnet', 'C#/.NET', 'dotnet/aspnetcore', 'Build, Test, Lint, Security, Publish'],
          ],
        },
      ],
    },
    {
      id: 'pipeline-patterns',
      title: 'Pipeline Patterns',
      blocks: [
        {
          type: 'text',
          content: 'The pipeline samples consistently apply these patterns:',
        },
        {
          type: 'list',
          items: [
            'Plugin filters — every plugin reference includes a filter (version, accessModifier, isActive, isDefault) so the resolved plugin version is explicit and reproducible',
            'Failure behavior — advisory checks (e.g. dependency audits) use failureBehavior: "warn" so they report findings without failing the build',
            'Step positioning — primary steps use "pre", supplementary steps use "post"',
            'Compute sizing — heavier steps override the default compute to MEDIUM or LARGE via the aws:cdk:codebuild:buildenvironment:computetype metadata key',
          ],
        },
      ],
    },
    {
      id: 'cdk-examples',
      title: 'CDK TypeScript Examples',
      blocks: [
        {
          type: 'text',
          content:
            'Self-contained stack classes showing PipelineBuilder usage. Located in deploy/samples/cdk/.',
        },
        {
          type: 'table',
          headers: ['Sample', 'Pattern'],
          rows: [
            ['basic-pipeline-ts', 'Simplest usage — GitHub source, plugin filters, 4 stages'],
            ['vpc-isolated-pipeline-ts', 'VPC networking with NetworkConfig and step-level overrides'],
            ['multi-account-pipeline-ts', 'Cross-account with RoleConfig, CodeStar source, ManualApproval'],
            ['monorepo-pipeline-ts', 'Monorepo with factory functions, pnpm workspace, per-service Docker'],
            ['custom-iam-roles-ts', 'Three levels of IAM role control (pipeline, step project, step action)'],
            ['secrets-management-ts', 'Secrets Manager integration with orgId-scoped resolution'],
          ],
        },
        {
          type: 'text',
          content:
            'IAM role control operates at three levels: the pipeline (BuilderProps.role, trusted by codepipeline.amazonaws.com), the step project (aws:cdk:pipelines:codebuildstep:role metadata, trusted by codebuild.amazonaws.com), and the step action (aws:cdk:pipelines:codebuildstep:actionrole metadata).',
        },
        {
          type: 'text',
          content:
            'For secrets: set orgId on BuilderProps, declare secrets: [{ name, required }] on plugins, and at deploy each value resolves from pipeline-builder/{orgId}/{secretName} in Secrets Manager and is injected as SECRETS_MANAGER-type CodeBuild env vars automatically.',
        },
      ],
    },
    {
      id: 'loading-samples',
      title: 'Loading Samples',
      blocks: [
        {
          type: 'text',
          content:
            'Load all sample pipelines into a running Pipeline Builder instance. By default the script uploads every sample in a single bulk request (validating each pipeline.json first) and targets https://localhost:8443.',
        },
        {
          type: 'code',
          language: 'bash',
          content: `cd deploy
bash bin/load-pipelines.sh

# Custom platform URL
PLATFORM_BASE_URL=https://pipeline.example.com bash bin/load-pipelines.sh

# Validate the sample files without uploading
bash bin/load-pipelines.sh --dry-run

# Upload one at a time via the single-create endpoint (legacy)
bash bin/load-pipelines.sh --single`,
        },
        {
          type: 'note',
          content:
            'Samples are also loaded automatically by init-platform.sh during post-deploy setup.',
        },
      ],
    },
  ],
};
