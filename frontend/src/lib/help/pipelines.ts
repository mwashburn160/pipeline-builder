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
      title: 'Create via Dashboard',
      blocks: [
        {
          type: 'text',
          content: 'From the Pipelines page, click "Create Pipeline" and choose one of two tabs:',
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
          content: `pipeline-manager create-pipeline \\
  --file ./pipeline-props.json \\
  --project my-app \\
  --organization my-org \\
  --name my-app-pipeline \\
  --access private

# Preview without creating
pipeline-manager create-pipeline --file ./pipeline-props.json --project my-app --organization my-org --dry-run`,
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
    "accessModifier": "private",
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
pipeline-manager deploy --id <pipeline-id>

# Deploy with a specific AWS profile
pipeline-manager deploy --id <pipeline-id> --profile production

# Synth only (generate CloudFormation without deploying)
pipeline-manager deploy --id <pipeline-id> --synth`,
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
    "plugin": { "name": "cdk-synth", "version": "1.0.0" }
  },
  "stages": [
    {
      "stageName": "Test",
      "steps": [{ "name": "unit-tests", "plugin": { "name": "jest-test", "version": "1.0.0" } }]
    },
    {
      "stageName": "Deploy",
      "steps": [{ "name": "deploy", "plugin": { "name": "cdk-deploy", "version": "1.0.0" } }]
    }
  ]
}`,
        },
      ],
    },
    {
      id: 'metadata-keys',
      title: 'Metadata Keys Reference',
      blocks: [
        {
          type: 'text',
          content:
            'Metadata keys control pipeline behavior at the global or step level. Set these in the "metadata" or "global" fields of your pipeline configuration.',
        },
        {
          type: 'text',
          content: 'Pipeline Behavior',
        },
        {
          type: 'table',
          headers: ['Key', 'Values', 'Description'],
          rows: [
            ['SELF_MUTATION', 'true / false', 'Enable the pipeline to update itself when its definition changes'],
            ['CROSS_ACCOUNT_KEYS', 'true / false', 'Use KMS keys for cross-account deployments'],
            ['PUBLISH_ASSETS_IN_PARALLEL', 'true / false', 'Publish CDK assets in parallel for faster deployments'],
            ['USE_CHANGE_SETS', 'true / false', 'Use CloudFormation change sets instead of direct deployments'],
          ],
        },
        {
          type: 'text',
          content: 'Docker',
        },
        {
          type: 'table',
          headers: ['Key', 'Values', 'Description'],
          rows: [
            ['DOCKER_ENABLED_FOR_SYNTH', 'true / false', 'Enable Docker during the synth step (required for Docker-based builds)'],
            ['DOCKER_ENABLED_FOR_SELF_MUTATION', 'true / false', 'Enable Docker during the self-mutation step'],
            ['DOCKER_CREDENTIALS', 'string', 'ARN or name of the Docker Hub credentials secret'],
            ['PRIVILEGED', 'true / false', 'Run CodeBuild in privileged mode (needed for Docker-in-Docker)'],
          ],
        },
        {
          type: 'text',
          content: 'Network',
        },
        {
          type: 'table',
          headers: ['Key', 'Values', 'Description'],
          rows: [
            ['NETWORK_TYPE', 'string', 'Network configuration type (e.g., "VPC")'],
            ['NETWORK_VPC_ID', 'string', 'VPC ID to run CodeBuild actions in a private network'],
            ['NETWORK_SUBNET_IDS', 'string', 'Comma-separated list of subnet IDs for CodeBuild'],
          ],
        },
        {
          type: 'text',
          content: 'Notifications',
        },
        {
          type: 'table',
          headers: ['Key', 'Values', 'Description'],
          rows: [
            ['NOTIFICATION_TOPIC_ARN', 'string', 'SNS topic ARN to receive pipeline event notifications'],
          ],
        },
      ],
    },
  ],
};
