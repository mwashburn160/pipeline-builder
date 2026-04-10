// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Code } from 'lucide-react';
import type { HelpTopic } from './types';

export const apiReferenceTopic: HelpTopic = {
  id: 'api-reference',
  title: 'API Reference',
  description: 'REST API endpoints and usage examples',
  icon: Code,
  sections: [
    {
      id: 'auth',
      title: 'Authentication',
      blocks: [
        {
          type: 'text',
          content: 'All API requests require:',
        },
        {
          type: 'list',
          items: [
            'Authorization: Bearer <JWT> — JWT token from the Platform service.',
            'x-org-id: <org-id> — Organization ID header.',
          ],
        },
      ],
    },
    {
      id: 'pipeline-endpoints',
      title: 'Pipeline Endpoints',
      blocks: [
        {
          type: 'table',
          headers: ['Method', 'Endpoint', 'Description'],
          rows: [
            ['GET', '/pipelines', 'List pipelines with filtering, pagination, sorting'],
            ['GET', '/pipelines/find', 'Find a single pipeline by query parameters'],
            ['GET', '/pipelines/:id', 'Get pipeline by ID'],
            ['POST', '/pipelines', 'Create a new pipeline'],
            ['PUT', '/pipelines/:id', 'Update an existing pipeline'],
            ['DELETE', '/pipelines/:id', 'Delete a pipeline'],
            ['GET', '/pipelines/providers', 'List configured AI providers'],
            ['POST', '/pipelines/generate', 'AI-generate pipeline config from a prompt'],
          ],
        },
      ],
    },
    {
      id: 'plugin-endpoints',
      title: 'Plugin Endpoints',
      blocks: [
        {
          type: 'table',
          headers: ['Method', 'Endpoint', 'Description'],
          rows: [
            ['GET', '/plugins', 'List plugins with filtering, pagination, sorting'],
            ['GET', '/plugins/find', 'Find a single plugin by query parameters'],
            ['GET', '/plugins/:id', 'Get plugin by ID'],
            ['POST', '/plugins', 'Upload a plugin (ZIP multipart)'],
            ['PUT', '/plugins/:id', 'Update an existing plugin'],
            ['DELETE', '/plugins/:id', 'Delete a plugin'],
            ['GET', '/plugins/providers', 'List configured AI providers'],
            ['POST', '/plugins/generate', 'AI-generate plugin config + Dockerfile'],
            ['POST', '/plugins/deploy-generated', 'Build and deploy an AI-generated plugin'],
          ],
        },
      ],
    },
    {
      id: 'query-params',
      title: 'Common Query Parameters',
      blocks: [
        {
          type: 'text',
          content: 'All list endpoints support these query parameters:',
        },
        {
          type: 'table',
          headers: ['Parameter', 'Type', 'Description'],
          rows: [
            ['limit', 'integer', 'Page size (1-100, default: 10)'],
            ['offset', 'integer', 'Records to skip (default: 0)'],
            ['sortBy', 'string', 'Field to sort by (default: createdAt)'],
            ['sortOrder', 'asc / desc', 'Sort direction (default: desc)'],
            ['accessModifier', 'public / private', 'Filter by visibility'],
            ['isActive', 'boolean', 'Filter by active status'],
            ['isDefault', 'boolean', 'Filter by default status'],
          ],
        },
      ],
    },
    {
      id: 'examples-plugin',
      title: 'Plugin Examples',
      blocks: [
        {
          type: 'code',
          language: 'bash',
          content: `# Upload a plugin
curl -X POST https://localhost:8443/api/plugins \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "x-org-id: $ORG_ID" \\
  -F "plugin=@./my-plugin.zip" \\
  -F "accessModifier=private"

# List plugins with filters
curl "https://localhost:8443/api/plugins?name=node-build&limit=10&sortBy=createdAt&sortOrder=desc" \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "x-org-id: $ORG_ID"

# Get by ID
curl "https://localhost:8443/api/plugins/<plugin-id>" \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "x-org-id: $ORG_ID"`,
        },
      ],
    },
    {
      id: 'examples-pipeline',
      title: 'Pipeline Examples',
      blocks: [
        {
          type: 'code',
          language: 'bash',
          content: `# Create a pipeline
curl -X POST https://localhost:8443/api/pipelines \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "x-org-id: $ORG_ID" \\
  -H "Content-Type: application/json" \\
  -d '{
    "project": "my-app",
    "organization": "my-org",
    "pipelineName": "my-app-pipeline",
    "accessModifier": "private",
    "props": { ... }
  }'

# List pipelines
curl "https://localhost:8443/api/pipelines?project=my-app&limit=10" \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "x-org-id: $ORG_ID"`,
        },
      ],
    },
    {
      id: 'examples-ai',
      title: 'AI Generation Examples',
      blocks: [
        {
          type: 'code',
          language: 'bash',
          content: `# Generate a pipeline from a prompt
curl -X POST https://localhost:8443/api/pipelines/generate \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "x-org-id: $ORG_ID" \\
  -H "Content-Type: application/json" \\
  -d '{
    "prompt": "Build a Node.js app from GitHub, run tests, and deploy with CDK",
    "provider": "anthropic",
    "model": "claude-sonnet-4-20250514"
  }'

# Generate a plugin config + Dockerfile
curl -X POST https://localhost:8443/api/plugins/generate \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "x-org-id: $ORG_ID" \\
  -H "Content-Type: application/json" \\
  -d '{
    "prompt": "A Node.js 20 build plugin that runs npm ci, npm test, and npm run build",
    "provider": "anthropic",
    "model": "claude-sonnet-4-20250514"
  }'`,
        },
      ],
    },
  ],
};
