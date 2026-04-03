import { Sparkles } from 'lucide-react';
import type { HelpTopic } from './types';

export const aiGenerationTopic: HelpTopic = {
  id: 'ai-generation',
  title: 'AI Generation',
  description: 'AI-powered pipeline and plugin creation',
  icon: Sparkles,
  sections: [
    {
      id: 'overview',
      title: 'AI-Powered Generation',
      blocks: [
        {
          type: 'text',
          content:
            'Pipeline Builder can generate complete pipeline and plugin configurations from a natural language prompt. Describe what you need and the AI creates the full config including source setup, build stages, and plugin references.',
        },
      ],
    },
    {
      id: 'providers',
      title: 'Supported AI Providers',
      blocks: [
        {
          type: 'table',
          headers: ['Provider', 'Models', 'Env Variable'],
          rows: [
            ['Anthropic', 'Claude Sonnet 4, Claude Haiku 4.5', 'ANTHROPIC_API_KEY'],
            ['OpenAI', 'GPT-4o, GPT-4o Mini', 'OPENAI_API_KEY'],
            ['Google', 'Gemini 2.0 Flash, Gemini 2.5 Pro', 'GOOGLE_GENERATIVE_AI_API_KEY'],
            ['xAI (Grok)', 'Grok 3, Grok 3 Fast, Grok 3 Mini', 'XAI_API_KEY'],
            ['Amazon Bedrock', 'Claude 3.5 Sonnet, Nova Pro, Nova Lite', 'AWS_ACCESS_KEY_ID'],
          ],
        },
        {
          type: 'note',
          content:
            'Providers are available when their API key is configured. Organization admins can configure API keys in Settings > AI Providers.',
        },
      ],
    },
    {
      id: 'generate-pipeline',
      title: 'Generate a Pipeline',
      blocks: [
        {
          type: 'text',
          content: 'From the dashboard, there are two ways to AI-generate a pipeline:',
        },
        {
          type: 'list',
          items: [
            'Dashboard Home — Paste a Git URL into the hero input. The AI analyzes the repo and streams a generated pipeline config.',
            'Create Pipeline Modal — Select the "AI Builder" tab, choose a provider/model, and describe your pipeline.',
          ],
        },
        {
          type: 'text',
          content: 'You can also generate via the API:',
        },
        {
          type: 'code',
          language: 'bash',
          content: `curl -X POST https://localhost:8443/api/pipelines/generate \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "x-org-id: $ORG_ID" \\
  -H "Content-Type: application/json" \\
  -d '{
    "prompt": "CI/CD pipeline for a Next.js app with unit tests and production deploy",
    "provider": "anthropic",
    "model": "claude-sonnet-4-20250514"
  }'`,
        },
      ],
    },
    {
      id: 'generate-plugin',
      title: 'Generate a Plugin',
      blocks: [
        {
          type: 'text',
          content: 'AI can also generate plugin configurations and Dockerfiles:',
        },
        {
          type: 'list',
          items: [
            'From the Plugins page, click "Create Plugin" and select the "AI Builder" tab.',
            'Describe the build environment and commands you need.',
            'The AI generates both the spec.yaml and Dockerfile.',
            'Review, edit if needed, then deploy the generated plugin.',
          ],
        },
      ],
    },
    {
      id: 'git-url-flow',
      title: 'Git URL Analysis Flow',
      blocks: [
        {
          type: 'text',
          content: 'When you paste a Git URL, the system streams SSE events through these stages:',
        },
        {
          type: 'list',
          items: [
            'analyzing — Fetching repository metadata from GitHub/GitLab/Bitbucket API.',
            'analyzed — Repository summary (languages, frameworks, project type).',
            'partial — Streaming AI-generated pipeline config chunks.',
            'done — Final complete pipeline configuration.',
            'checking-plugins — Verifying referenced plugins exist.',
            'creating-plugins — Auto-creating missing plugins (with build request IDs).',
          ],
        },
        {
          type: 'note',
          content: 'Supports GitHub, GitLab, Bitbucket, and self-hosted Git URLs (HTTPS, SSH, git@ formats).',
        },
      ],
    },
  ],
};
