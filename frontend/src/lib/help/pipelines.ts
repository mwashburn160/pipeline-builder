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
  ],
};
