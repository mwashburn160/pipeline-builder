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
      id: 'browse-plugins',
      title: 'Browse plugins',
      blocks: [
        {
          type: 'text',
          content:
            'The plugin directory at /plugins is public: anyone can search it, browse the 10 categories and open a plugin page (README, versions, configuration, supply chain) without an account. "Browse plugins" on the home page goes there. Official plugins are available in every workspace without installing — copy the pipeline reference from a plugin page into your pipeline config.',
        },
        {
          type: 'list',
          items: [
            'Press / anywhere in the directory to jump to the search box; results update as you type and the address bar is always a shareable link.',
            '"Sign in" and "Sign in to install" bring you back to the same plugin or search after you sign in, whichever method you use (password, passkey, MFA, OAuth or SSO).',
            'Bookmarkable sign-in link: /login?returnTo=/plugins/<publisher>/<name> signs you in and returns you to that page. Only paths on this site are honoured; anything else is ignored.',
          ],
        },
      ],
    },
    {
      id: 'five-ways',
      title: 'Five ways to create a pipeline',
      blocks: [
        {
          type: 'table',
          headers: ['Method', 'Best for', 'Example'],
          rows: [
            ['CDK Construct', 'Teams embedding pipelines in their own CDK stacks', 'new PipelineBuilder(stack, \'P\', { ... })'],
            ['CLI', 'Scripted/automated pipeline creation', 'pipeline-manager pipeline create --file props.json'],
            ['REST API', 'Integration with other tooling', 'POST /api/pipelines'],
            ['Dashboard', 'Visual creation and management', 'Point, click, deploy'],
            ['AI Prompt', 'Fastest path from idea to pipeline', '"Build and deploy a Next.js app from GitHub"'],
          ],
        },
      ],
    },
    {
      id: 'quickstart-dashboard',
      title: 'Create a pipeline from the dashboard',
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
            'Use the CLI to deploy: pipeline-manager pipeline deploy --id <pipeline-id>',
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
          content: 'Install the CLI and sign in through your browser (the CLI shows a short code you approve on the platform — SSO, MFA and passkeys all apply):',
        },
        {
          type: 'code',
          language: 'bash',
          content: `npm install -g @pipeline-builder/pipeline-manager
pipeline-manager auth login --url https://<your-platform>

pipeline-manager pipeline create --file my-pipeline.json --project my-app --organization my-org
pipeline-manager pipeline deploy --id <pipeline-id>`,
        },
        {
          type: 'list',
          items: [
            'In CI, create an access key with pipeline-manager auth pat (shown once) and set it as PLATFORM_TOKEN — it always wins over a stored sign-in.',
            'Stored sign-ins appear under Settings → Sessions and devices, where you can sign them out.',
          ],
        },
        {
          type: 'note',
          content: 'Prerequisites: Node.js >= 24.14. Deploying a pipeline locally also needs esbuild and pnpm on PATH (the CLI checks and tells you).',
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
            'Requests from the dashboard, CLI and API enter through one ingress (nginx), which routes each path straight to the service that owns it. Platform signs you in and issues short-lived ES256 access tokens; every service verifies those tokens itself against Platform\'s published signing keys (JWKS), resolves your organization and checks your role\'s permissions. Services call each other with their own signed service tokens.',
        },
        {
          type: 'table',
          headers: ['Service', 'Purpose'],
          rows: [
            ['Platform', 'Sign-in, sessions, access keys, users, organizations, roles, audit log'],
            ['Pipeline', 'Pipeline config CRUD, templates, AI generation, plugin contract checks'],
            ['Plugin', 'Plugin CRUD, image builds, signing and SBOMs, vulnerability scans, the public plugin directory'],
            ['Image Registry', 'Registry tokens, image browsing, plugin image signing and the public/* namespace'],
            ['Compliance', 'Per-organization rules evaluated on pipelines and plugins'],
            ['Reporting', 'Execution, plugin and DORA reports'],
            ['Quota', 'Resource limits per organization'],
            ['Billing', 'Plans, add-ons and subscription lifecycle'],
            ['Message', 'Announcements, messaging and in-app notifications'],
            ['Ask', 'Answers questions grounded on these docs'],
          ],
        },
      ],
    },
  ],
};
