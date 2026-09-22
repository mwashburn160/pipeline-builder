// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { GitBranch } from 'lucide-react';
import type { HelpTopic } from './types';

export const pipelinesTopic: HelpTopic = {
  id: 'pipelines',
  title: 'Pipelines',
  description: 'Creating, managing, and deploying CI/CD pipelines',
  icon: GitBranch,
  sections: [
    {
      id: 'what-are-pipelines',
      title: 'What Are Pipelines?',
      blocks: [
        {
          type: 'text',
          content:
            'Pipelines define the full CI/CD workflow: source repository, synth step, and build/test/deploy stages. Each stage references plugins for its build steps. When deployed, a pipeline becomes a fully functional AWS CodePipeline in your AWS account.',
        },
      ],
    },
    {
      id: 'create-dashboard',
      title: 'Create via dashboard',
      blocks: [
        {
          type: 'text',
          content: 'From the Pipelines page, click "Create pipeline" and choose one of two tabs:',
        },
        {
          type: 'list',
          items: [
            'Manual — Fill in project, organization, source repo, and add stages/steps referencing plugins.',
            'AI Builder — Describe what you need in plain language and let AI generate the config. You can also paste a Git URL on the Dashboard home page for one-click generation.',
          ],
        },
      ],
    },
    {
      id: 'create-cli',
      title: 'Create via CLI',
      blocks: [
        {
          type: 'code',
          language: 'bash',
          content: `pipeline-manager pipeline create \\
  --file ./pipeline-props.json \\
  --project my-app \\
  --organization my-org \\
  --name my-app-pipeline \\
  --visibility private

# Create and deploy in one go
pipeline-manager pipeline create --file ./pipeline-props.json --deploy

# Preview without creating
pipeline-manager pipeline create --file ./pipeline-props.json --project my-app --organization my-org --dry-run`,
        },
      ],
    },
    {
      id: 'create-api',
      title: 'Create via REST API',
      blocks: [
        {
          type: 'code',
          language: 'bash',
          content: `curl -X POST https://localhost:8443/api/pipelines \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "x-org-id: $ORG_ID" \\
  -H "Content-Type: application/json" \\
  -d '{
    "project": "my-app",
    "organization": "my-org",
    "pipelineName": "my-app-pipeline",
    "visibility": "private",
    "props": { ... }
  }'`,
        },
      ],
    },
    {
      id: 'deploy',
      title: 'Deploy to AWS',
      blocks: [
        {
          type: 'text',
          content: 'Once created, deploy a pipeline to your AWS account using the CLI:',
        },
        {
          type: 'code',
          language: 'bash',
          content: `# Deploy a stored pipeline by ID
pipeline-manager pipeline deploy --id <pipeline-id>

# Deploy with a specific AWS profile
pipeline-manager pipeline deploy --id <pipeline-id> --profile production

# Synth only (generate CloudFormation without deploying)
pipeline-manager pipeline deploy --id <pipeline-id> --synth`,
        },
      ],
    },
    {
      id: 'pipeline-config',
      title: 'Pipeline Configuration Structure',
      blocks: [
        {
          type: 'text',
          content: 'A pipeline config JSON defines the source, synth step, and stages:',
        },
        {
          type: 'code',
          language: 'json',
          content: `{
  "project": "my-app",
  "organization": "my-org",
  "synth": {
    "source": {
      "type": "github",
      "options": {
        "repo": "my-org/my-app",
        "branch": "main",
        "connectionArn": "arn:aws:codestar-connections:..."
      }
    },
    "plugin": { "name": "cdk-synth", "filter": { "version": "1.0.0" } }
  },
  "stages": [
    {
      "stageName": "Test",
      "steps": [{ "name": "unit-tests", "plugin": { "name": "jest-test", "filter": { "version": "1.0.0" } } }]
    },
    {
      "stageName": "Deploy",
      "steps": [{ "name": "deploy", "plugin": { "name": "cdk-deploy", "filter": { "version": "1.0.0" } } }]
    }
  ]
}`,
        },
      ],
    },
    {
      id: 'plugin-references',
      title: 'Plugin References & Contracts',
      blocks: [
        {
          type: 'list',
          items: [
            'A step names its plugin: { "name": "trivy" }. Add "filter": { "version": "^1" } for a version range (exact, ^, ~, 1.x, 1.2 or latest); without one the plugin\'s default version is used. A new major never becomes the default on its own.',
            'To use another publisher\'s listing, add its handle: { "publisher": "acme", "name": "terraform-plan", "filter": { "version": "^1" } }. That resolves only acme\'s listing, and only through your organization\'s install; your own plugins are never considered. "publisher": "pipeline-builder" names the Official listing.',
            'Without a publisher, resolution goes: your organization\'s own plugin, then (for a team) the parent organization\'s shared plugin, then the Official listing through your install (Official plugins are installed implicitly).',
            'Shadowing: if your organization has its own plugin with an Official listing\'s name, yours wins. The pipeline editor flags each step that uses it and synth warns PLUGIN_SHADOWS_LISTING; add "publisher": "pipeline-builder" to use the listing instead.',
            'For a listing, the version range is the install\'s version policy, narrowed by filter.version (for an implicit Official install, filter.version replaces the default range). Yanked listing versions never resolve.',
            'Create and update refuse a publisher reference that isn\'t installed, is blocked by your organization\'s consumption policy or can\'t resolve (400, with each step\'s reason). See the Plugin Installing topic.',
            'If a plugin declares requiredMetadata / requiredVars (with types), the pipeline must supply them: a create or update that doesn\'t is refused with 400 TEMPLATE_CONTRACT_VIOLATION, listing each step\'s missing and ill-typed keys. Synth runs the same check.',
            'Deprecated plugin versions still resolve but print a warning at synth; yanked versions are skipped unless the step pins that exact version.',
            'Each deploy records which plugin version every step runs, so Reports → Plugins → Runs can show per-plugin success rates and durations.',
          ],
        },
      ],
    },
    {
      id: 'metadata-keys',
      title: 'Metadata',
      blocks: [
        {
          type: 'text',
          content:
            'Metadata keys override CodePipeline and CodeBuild defaults — compute, privileged mode, VPC networking, IAM roles, notifications, encryption. Later scopes win:',
        },
        {
          type: 'table',
          headers: ['Scope', 'Where to set', 'Applies to'],
          rows: [
            ['Pipeline', 'global, then defaults.metadata, then synth.metadata', 'Every step, including synth'],
            ['Plugin reference', 'a step\'s plugin.metadata', 'That step'],
            ['Step', 'a step\'s metadata', 'That step'],
          ],
        },
        {
          type: 'text',
          content: 'In a JSON pipeline use each key\'s string value; the MetadataKeys constant names are for TypeScript. For example:',
        },
        {
          type: 'code',
          language: 'json',
          content: `"global": {
  "aws:cdk:pipelines:codepipeline:selfmutation": "true",
  "aws:cdk:notifications:topic:arn": "arn:aws:sns:us-east-1:123456789012:pipeline-events"
},
"stages": [{
  "stageName": "Build",
  "steps": [{
    "plugin": { "name": "docker-build" },
    "metadata": {
      "aws:cdk:codebuild:buildenvironment:privileged": "true",
      "aws:cdk:codebuild:buildenvironment:computetype": "BUILD_GENERAL1_LARGE"
    }
  }]
}]`,
        },
        {
          type: 'note',
          content: 'The full key list, grouped by the construct each key configures, is in the Metadata Keys topic. There is no stage-level metadata.',
        },
      ],
    },
  ],
};
