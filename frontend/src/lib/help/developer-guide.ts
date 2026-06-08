// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Code2 } from 'lucide-react';
import type { HelpTopic } from './types';

export const developerGuideTopic: HelpTopic = {
  id: 'developer-guide',
  title: 'Developer Guide',
  description: 'Practical benefits and workflows for developers using Pipeline Builder',
  icon: Code2,
  sections: [
    {
      id: 'what-it-replaces',
      title: 'What Pipeline Builder Replaces',
      blocks: [
        {
          type: 'text',
          content:
            'Building a CI/CD pipeline for an AWS project by hand normally means writing 200-500 lines of CDK or CloudFormation, configuring CodeBuild buildspecs, maintaining Docker images per build tool, wiring IAM roles and source connections, researching and configuring security scanners, passing artifacts between stages, and debugging local-vs-CI differences.',
        },
        {
          type: 'text',
          content:
            'With Pipeline Builder the workflow collapses to two steps: select plugins from the catalog, then deploy.',
        },
      ],
    },
    {
      id: 'five-ways',
      title: 'Five Ways to Create a Pipeline',
      blocks: [
        {
          type: 'list',
          items: [
            'Dashboard (Visual Builder) — select a project, pick plugins per stage, click deploy. No code required.',
            'AI Prompt — paste a Git repo URL; the repo is analyzed (language, framework, test tools, Dockerfiles) and a complete pipeline definition is generated.',
            'CLI — create from a JSON definition and deploy with pipeline-manager.',
            'REST API — POST a pipeline definition to /api/pipeline with a bearer token.',
            'CDK Construct — define pipelines as infrastructure-as-code with PipelineBuilder.',
          ],
        },
      ],
    },
    {
      id: 'cli-quickstart',
      title: 'CLI Quickstart',
      blocks: [
        {
          type: 'code',
          language: 'bash',
          content: `# Login
pipeline-manager login --url https://your-instance --no-verify-ssl

# Create from a JSON definition
pipeline-manager create-pipeline --file pipeline.json --no-verify-ssl

# Deploy to AWS
pipeline-manager deploy --id <pipeline-id> --no-verify-ssl --store-tokens`,
        },
      ],
    },
    {
      id: 'rest-and-cdk',
      title: 'REST API and CDK Construct',
      blocks: [
        {
          type: 'text',
          content: 'Create and list pipelines over REST with a bearer token:',
        },
        {
          type: 'code',
          language: 'bash',
          content: `# Create pipeline
curl -X POST https://your-instance/api/pipeline \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "Content-Type: application/json" \\
  -d @pipeline.json

# List pipelines
curl https://your-instance/api/pipelines \\
  -H "Authorization: Bearer $TOKEN"`,
        },
        {
          type: 'text',
          content: 'Or define a pipeline as infrastructure-as-code with the CDK construct:',
        },
        {
          type: 'code',
          language: 'typescript',
          content: `import { PipelineBuilder } from '@mwashburn160/pipeline-core';

new PipelineBuilder(stack, 'MyPipeline', {
  project: 'my-app',
  organization: 'my-team',
  synth: {
    source: { type: 'github', options: { repo: 'org/repo', branch: 'main' } },
    plugin: { name: 'cdk-synth' },
  },
  stages: [
    { stageName: 'Test', steps: [{ plugin: { name: 'jest' } }] },
    { stageName: 'Security', steps: [{ plugin: { name: 'trivy-nodejs' } }] },
  ],
});`,
        },
      ],
    },
    {
      id: 'plugin-catalog',
      title: 'Plugin Catalog — Cut and Paste',
      blocks: [
        {
          type: 'text',
          content:
            'Every plugin is a reusable, containerized build step. Copy a plugin block into your pipeline definition. Each language stack ships Build, Test, Lint, and Security plugins. Example for Node.js (React/Next.js):',
        },
        {
          type: 'code',
          language: 'json',
          content: `{
  "stages": [
    {
      "stageName": "Build",
      "steps": [{
        "plugin": { "name": "nodejs" },
        "commands": ["npm ci", "npm run build"]
      }]
    },
    {
      "stageName": "Test",
      "steps": [
        { "plugin": { "name": "jest" }, "commands": ["npm test -- --coverage"] },
        { "plugin": { "name": "cypress" }, "commands": ["npx cypress run"] }
      ]
    },
    {
      "stageName": "Security",
      "steps": [
        { "plugin": { "name": "snyk-nodejs" } },
        { "plugin": { "name": "trivy-nodejs" } }
      ]
    }
  ]
}`,
        },
        {
          type: 'note',
          content:
            'Equivalent ready-to-paste stacks exist for Java (Spring Boot), Python (Django/FastAPI), Go (Gin/Echo), Rust (Axum/Actix), .NET (ASP.NET Core), and Ruby (Rails).',
        },
      ],
    },
    {
      id: 'common-patterns',
      title: 'Common Patterns',
      blocks: [
        {
          type: 'text',
          content:
            'Append these stages to extend any pipeline — Docker build/push (docker-build), Terraform deploy (terraform), manual approval before production (manual-approval), and Slack notifications (slack-notify). Example Docker publish stage:',
        },
        {
          type: 'code',
          language: 'json',
          content: `{
  "stageName": "Publish",
  "steps": [{
    "plugin": { "name": "docker-build" },
    "metadata": {
      "DOCKER_REPO": "your-account.dkr.ecr.us-east-1.amazonaws.com/your-app",
      "DOCKER_TAG": "latest"
    }
  }]
}`,
        },
        {
          type: 'text',
          content:
            'Each step accepts a failureBehavior controlling how a failing plugin affects the run:',
        },
        {
          type: 'table',
          headers: ['failureBehavior', 'Effect'],
          rows: [
            ['(omitted)', 'Fail the pipeline (default)'],
            ['warn', 'Log a warning and continue the pipeline'],
            ['ignore', 'Ignore the failure silently'],
          ],
        },
      ],
    },
    {
      id: 'compute-size',
      title: 'Custom Compute Size',
      blocks: [
        {
          type: 'text',
          content:
            'Override the CodeBuild compute type per step via plugin metadata using the key aws:cdk:codebuild:buildenvironment:computetype.',
        },
        {
          type: 'table',
          headers: ['Compute Type', 'Memory', 'vCPU'],
          rows: [
            ['SMALL', '3 GB', '2'],
            ['MEDIUM', '7 GB', '4'],
            ['LARGE', '15 GB', '8'],
            ['X2_LARGE', '145 GB', '72'],
          ],
        },
      ],
    },
    {
      id: 'complete-example',
      title: 'Complete Pipeline Example',
      blocks: [
        {
          type: 'text',
          content: 'A full Spring Boot definition with build, test, security, approval, and deploy stages:',
        },
        {
          type: 'code',
          language: 'json',
          content: `{
  "project": "my-api",
  "organization": "backend-team",
  "accessModifier": "public",
  "props": {
    "project": "my-api",
    "organization": "backend-team",
    "synth": {
      "source": {
        "type": "github",
        "options": { "repo": "my-org/my-api", "branch": "main", "trigger": "AUTO" }
      },
      "plugin": { "name": "cdk-synth" }
    },
    "stages": [
      { "stageName": "Build", "steps": [{ "plugin": { "name": "java-corretto" }, "commands": ["./gradlew assemble --no-daemon --parallel"], "timeout": 30 }] },
      { "stageName": "Test", "steps": [{ "plugin": { "name": "java-corretto" }, "commands": ["./gradlew test --no-daemon"], "timeout": 45 }] },
      { "stageName": "Security", "steps": [{ "plugin": { "name": "semgrep" } }, { "plugin": { "name": "trivy-java" } }] },
      { "stageName": "Approval", "steps": [{ "plugin": { "name": "manual-approval" }, "metadata": { "APPROVAL_COMMENT": "Deploy to production?" } }] },
      { "stageName": "Deploy", "steps": [{ "plugin": { "name": "cdk-deploy" }, "commands": ["cdk deploy --all --require-approval never"] }] }
    ]
  }
}`,
        },
        {
          type: 'code',
          language: 'bash',
          content: `# Save as pipeline.json, then create and deploy
pipeline-manager create-pipeline --file pipeline.json --no-verify-ssl
pipeline-manager deploy --id <returned-id> --no-verify-ssl --store-tokens`,
        },
      ],
    },
    {
      id: 'plugin-reference',
      title: 'Plugin Reference',
      blocks: [
        {
          type: 'text',
          content:
            'Pipeline Builder ships with 125 plugins across 10 categories. Every plugin runs as an isolated container step inside AWS CodePipeline, so build environments are reproducible and secrets never leak into image layers.',
        },
        {
          type: 'list',
          items: [
            'Language — base build environments for each language',
            'Security — vulnerability scanners and SAST/DAST tools',
            'Quality — linters, formatters, code analysis',
            'Testing — test runners, coverage, load testing',
            'Artifact — Docker builds, package publishing',
            'Deploy — Terraform, CloudFormation, Kubernetes, Helm',
            'Infrastructure — CDK synth, manual approval, S3 cache, shell',
            'Notification — Slack, Teams, PagerDuty, email',
            'Monitoring — Datadog, New Relic, Sentry',
            'AI — AI-powered Dockerfile generation (Anthropic, OpenAI, Google, xAI, Bedrock)',
          ],
        },
      ],
    },
  ],
};
