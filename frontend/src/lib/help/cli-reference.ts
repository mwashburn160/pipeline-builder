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
npm install -g @mwashburn160/pipeline-manager

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
            ['upload-plugin --file <zip>', 'Upload a plugin ZIP to the platform'],
            ['list-plugins', 'List plugins (with filtering, pagination, sorting)'],
            ['get-plugin --id <id>', 'Get a plugin by ID'],
            ['create-pipeline --file <json>', 'Create a pipeline from a props JSON file'],
            ['list-pipelines', 'List pipelines (with filtering, pagination, sorting)'],
            ['get-pipeline --id <id>', 'Get a pipeline by ID'],
            ['deploy --id <id>', 'Fetch pipeline config from Platform, run cdk deploy to AWS'],
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
          ],
        },
      ],
    },
  ],
};
