// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Rocket } from 'lucide-react';
import type { HelpTopic } from './types';

export const gettingStartedTopic: HelpTopic = {
  id: 'getting-started',
  title: 'Getting Started',
  description: 'Quick overview and creating your first pipeline',
  icon: Rocket,
  sections: [
    {
      id: 'overview',
      title: 'What is Pipeline Builder?',
      blocks: [
        {
          type: 'text',
          content:
            'Pipeline Builder turns plugin definitions and pipeline configs into fully deployed AWS CodePipeline infrastructure — all inside your AWS account with zero lock-in. Define pipelines as CDK constructs, manage them from the CLI or dashboard, or generate them from a natural language prompt.',
        },
      ],
    },
    {
      id: 'five-ways',
      title: 'Five Ways to Create a Pipeline',
      blocks: [
        {
          type: 'table',
          headers: ['Method', 'Best for', 'Example'],
          rows: [
            ['CDK Construct', 'Teams embedding pipelines in their own CDK stacks', 'new PipelineBuilder(stack, \'P\', { ... })'],
            ['CLI', 'Scripted/automated pipeline creation', 'pipeline-manager create-pipeline --file props.json'],
            ['REST API', 'Integration with other tooling', 'POST /api/pipelines'],
            ['Dashboard', 'Visual creation and management', 'Point, click, deploy'],
            ['AI Prompt', 'Fastest path from idea to pipeline', '"Build and deploy a Next.js app from GitHub"'],
          ],
        },
      ],
    },
    {
      id: 'quickstart-dashboard',
      title: 'Create a Pipeline from the Dashboard',
      blocks: [
        {
          type: 'text',
          content: 'The fastest way to get started is from the Dashboard home page:',
        },
        {
          type: 'list',
          items: [
            'Paste a Git repository URL into the hero input on the Dashboard home page.',
            'Click "Generate" — the AI analyzes your repo and generates a pipeline config.',
            'Review the auto-detected settings (source, stages, plugins).',
            'Click "Create" to save the pipeline configuration.',
            'Use the CLI to deploy: pipeline-manager deploy --id <pipeline-id>',
          ],
        },
      ],
    },
    {
      id: 'quickstart-cli',
      title: 'Create a Pipeline from the CLI',
      blocks: [
        {
          type: 'text',
          content: 'Install the CLI and authenticate with a JWT token from the dashboard:',
        },
        {
          type: 'code',
          language: 'bash',
          content: `npm install -g @mwashburn160/pipeline-manager
export PLATFORM_TOKEN=<jwt-from-login>

pipeline-manager create-pipeline --file my-pipeline.json --project my-app --organization my-org
pipeline-manager deploy --id <pipeline-id>`,
        },
        {
          type: 'note',
          content: 'Prerequisites: Node.js >= 24.9, pnpm >= 10.25, Docker',
        },
      ],
    },
    {
      id: 'architecture',
      title: 'How It Works',
      blocks: [
        {
          type: 'text',
          content:
            'Every API call flows through the Platform service. Platform handles user registration, login, JWT issuance, organization management, and role-based access control. When the CLI or dashboard makes a request, Platform validates the JWT, resolves your organization, and forwards the request to the appropriate backend service.',
        },
        {
          type: 'table',
          headers: ['Service', 'Purpose'],
          rows: [
            ['Platform', 'Auth, orgs, users, JWT tokens, RBAC — central gateway'],
            ['Pipeline', 'Pipeline config CRUD + AI generation'],
            ['Plugin', 'Plugin CRUD, Docker builds, AI generation'],
            ['Quota', 'Resource limits per organization'],
            ['Billing', 'Subscription plans and lifecycle'],
            ['Message', 'Org-to-org announcements and messaging'],
          ],
        },
      ],
    },
  ],
};
