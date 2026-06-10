// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Terminal } from 'lucide-react';
import type { HelpTopic } from './types';

export const cliReferenceTopic: HelpTopic = {
  id: 'cli-reference',
  title: 'CLI Reference',
  description: 'Pipeline Manager CLI commands and usage',
  icon: Terminal,
  sections: [
    {
      id: 'overview',
      title: 'Pipeline Manager CLI',
      blocks: [
        {
          type: 'text',
          content:
            'The pipeline-manager CLI is the primary tool for managing plugins, pipelines, and deployments from the terminal. It authenticates against the Platform service using a JWT token — the same token you get when logging in through the dashboard.',
        },
      ],
    },
    {
      id: 'setup',
      title: 'Setup',
      blocks: [
        {
          type: 'code',
          language: 'bash',
          content: `# Install globally
npm install -g @pipeline-builder/pipeline-manager

# Authenticate with a token from Platform (register/login at the dashboard)
export PLATFORM_TOKEN=<jwt-from-platform>`,
        },
      ],
    },
    {
      id: 'workflow',
      title: 'End-to-End Workflow',
      blocks: [
        {
          type: 'code',
          language: 'bash',
          content: `# 1. Upload a reusable plugin
pipeline-manager upload-plugin --file ./node-build.zip --organization my-org --name node-build --version 1.0.0

# 2. Create a pipeline that references the plugin
pipeline-manager create-pipeline --file ./pipeline-props.json --project my-app --organization my-org

# 3. Deploy to the client's AWS account
pipeline-manager deploy --id <pipeline-id> --profile production`,
        },
      ],
    },
    {
      id: 'commands',
      title: 'Command Reference',
      blocks: [
        {
          type: 'table',
          headers: ['Command', 'Description'],
          rows: [
            ['login', 'Authenticate against the platform and persist the access token (--refresh, --org)'],
            ['bootstrap', 'Scaffold a new pipeline project with cdk.json and starter config'],
            ['synth', 'Run CDK synth to emit the CloudFormation template for the pipeline'],
            ['deploy --id <id>', 'Fetch pipeline config from Platform, run cdk deploy, and register the pipeline by pipelineId'],
            ['register --id <id>', 'Re-register a deployed pipeline and drain pending registration intents (recovery path)'],
            ['provision', 'Recommended installer for the PLATFORM (local/minikube/EC2/Fargate): prereq checks + assembles the exact bin/setup.sh command; --execute runs it (gated, then verifies health + init-platform). On failure it diagnoses + auto-fixes/retries known issues. --teardown removes a deployment (AWS targets need a typed confirmation; --force for CI). Flags: --target, --prompt, --execute, --yes, --retries, --teardown, --force, --no-init, --diagnose'],
            ['status --id <id>', 'Report the current deployment and execution status'],
            ['create-pipeline --file <json>', 'Create a pipeline from a props JSON file'],
            ['list-pipelines / get-pipeline --id <id>', 'List pipelines / get one by ID'],
            ['upload-plugin --file <zip>', 'Upload a plugin ZIP to the platform'],
            ['list-plugins / get-plugin --id <id>', 'Browse the plugin catalog / get one by ID'],
            ['validate-templates', 'Validate {{ … }} templates in a pipeline or plugin spec'],
            ['store-token', 'Generate a long-lived JWT and store it in AWS Secrets Manager (used by the events Lambda)'],
            ['setup-events', 'Deploy the EventBridge → SQS → Lambda stack that streams CodePipeline events into reporting'],
            ['audit-stacks', 'Diff CloudFormation stacks vs pipeline_registry to find orphaned/missing deployments (exit 1 on findings)'],
            ['audit-tokens', 'Flag platform tokens in Secrets Manager expiring within --warn-days (exit 1 if at-risk)'],
            ['org-export', 'Export an organization\'s data as JSON for GDPR portability'],
            ['version', 'Show version and environment info'],
          ],
        },
      ],
    },
    {
      id: 'output-formats',
      title: 'Output Options',
      blocks: [
        {
          type: 'text',
          content: 'All list and get commands support output formatting:',
        },
        {
          type: 'list',
          items: [
            '--format table|json|yaml|csv — Output format (default: table)',
            '--output <path> — Save output to a file',
            '--debug — Enable debug logging',
            '--verbose — Enable verbose output',
            '--quiet — Suppress non-essential output',
            '--no-color — Disable colored output',
          ],
        },
      ],
    },
    {
      id: 'env-vars',
      title: 'CLI Environment Variables',
      blocks: [
        {
          type: 'table',
          headers: ['Variable', 'Required', 'Description', 'Default'],
          rows: [
            ['PLATFORM_TOKEN', 'Yes', 'JWT access token from Platform login', '—'],
            ['PLATFORM_BASE_URL', 'No', 'Platform API base URL', 'https://localhost:8443'],
            ['CLI_CONFIG_PATH', 'No', 'Path to YAML config file', '../config.yml'],
            ['TLS_REJECT_UNAUTHORIZED', 'No', 'Set 0 to skip SSL verification (dev only)', '—'],
            ['ANTHROPIC_API_KEY (or other provider key)', 'No', 'Enables `provision`\'s NL goal parsing + failure diagnosis (else it falls back to the deterministic advisor)', '—'],
            ['AI_PROVIDER / AI_MODEL', 'No', 'Provider + model for `provision` (anthropic|openai|google|xai|bedrock)', 'anthropic'],
          ],
        },
      ],
    },
  ],
};
