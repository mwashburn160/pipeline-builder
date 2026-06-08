// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Workflow } from 'lucide-react';
import type { HelpTopic } from './types';

export const architectureFlowTopic: HelpTopic = {
  id: 'architecture-flow',
  title: 'Architecture & Flow',
  description: 'How Pipeline Builder turns plugins and pipelines into running AWS CodePipelines',
  icon: Workflow,
  sections: [
    {
      id: 'overview',
      title: 'Overview',
      blocks: [
        {
          type: 'text',
          content:
            'Pipeline Builder is a multi-team platform for creating AWS CodePipeline CI/CD pipelines from reusable, containerized plugins. Users define pipelines through the UI or API, and the system synthesizes them into CloudFormation templates via AWS CDK.',
        },
        {
          type: 'note',
          content:
            'It ships with 125 ready-to-use plugins spanning build, test, security, quality, monitoring, and infrastructure, and can generate new plugins and pipelines from natural-language prompts via pluggable AI providers (Anthropic, OpenAI, Amazon Bedrock).',
        },
      ],
    },
    {
      id: 'system-architecture',
      title: 'System Architecture',
      blocks: [
        {
          type: 'text',
          content:
            'Clients (Next.js frontend, the pipeline-manager CLI, and the REST API) reach the platform through an Nginx reverse proxy. The Platform API acts as the auth gateway, fanning requests out to the backing services. Plugin and Pipeline requests are validated against Compliance (fail-closed) before being persisted.',
        },
        {
          type: 'list',
          items: [
            'Services: Platform API (auth/gateway), Pipeline API, Plugin API, Compliance, Quota, Billing, Message, Reporting, Image Registry.',
            'Data stores: MongoDB (users/orgs), PostgreSQL (pipelines/plugins), Redis (BullMQ queue + cache).',
            'Build tier: a rootless buildkitd sidecar builds plugin images; a Docker Registry v2 stores them.',
          ],
        },
        {
          type: 'text',
          content:
            'The Plugin API builds images with buildctl (build_image) or pushes prebuilt images with crane, while the Image Registry service mints scoped Bearer tokens that authorize pushes to the registry.',
        },
      ],
    },
    {
      id: 'plugin-upload-build',
      title: 'Flow 1: Plugin Upload & Build',
      blocks: [
        {
          type: 'text',
          content:
            'Plugins are containerized build tools (e.g. eslint, terraform, docker-build) packaged as ZIP files. The ZIP contains config.yaml (buildType, Dockerfile path), plugin-spec.yaml (name, version, commands, env), a Dockerfile, and — for prebuilt plugins — an image.tar.',
        },
        {
          type: 'text',
          content:
            'On upload, the Plugin API extracts the ZIP, runs a fail-closed compliance check, returns 202 Accepted, and enqueues a build job on BullMQ. The worker builds and pushes the image, stores the plugin record in PostgreSQL, and emits an SSE "build complete" event.',
        },
        {
          type: 'table',
          headers: ['Build Type', 'How It Builds', 'Result'],
          rows: [
            ['build_image', 'buildctl build the Dockerfile, then buildkit push', 'Image in Registry'],
            ['prebuilt', 'crane push the bundled image.tar', 'Image in Registry'],
            ['metadata_only', 'No Docker build — deploy the spec directly', 'Plugin record only'],
          ],
        },
      ],
    },
    {
      id: 'pipeline-creation',
      title: 'Flow 2: Pipeline Creation',
      blocks: [
        {
          type: 'text',
          content:
            'Users compose pipelines from plugins via the UI or API. The Platform API forwards a create request to the Pipeline API, which performs auth and quota checks, validates the pipeline props against Compliance (Allowed/Blocked), and on success stores the pipeline in PostgreSQL with its definition as JSON in the props column.',
        },
        {
          type: 'text',
          content:
            'The BuilderProps definition names the source repo/branch, the synth plugin, and an ordered list of stages, each with steps that reference plugins by name:',
        },
        {
          type: 'code',
          language: 'json',
          content: `{
  "project": "my-app",
  "organization": "acme-corp",
  "pipelineName": "main-pipeline",
  "synth": {
    "source": { "repo": "owner/repo", "branch": "main" },
    "plugin": { "name": "cdk-synth" }
  },
  "stages": [
    {
      "stageName": "Test",
      "steps": [
        { "plugin": { "name": "jest" } },
        { "plugin": { "name": "eslint" } }
      ]
    },
    {
      "stageName": "Deploy",
      "steps": [
        { "plugin": { "name": "cdk-deploy" } }
      ]
    }
  ]
}`,
        },
      ],
    },
    {
      id: 'cdk-synthesis',
      title: 'Flow 3: CDK Synthesis',
      blocks: [
        {
          type: 'text',
          content:
            'The pipeline-manager CLI runs cdk synth / cdk deploy, which invokes PipelineBuilder(props) and creates a PluginLookup custom resource backed by a Lambda. At deploy time, that Lambda calls POST /api/plugins/lookup to resolve each stage plugin, returning base64-encoded plugin config (commands, env, computeType).',
        },
        {
          type: 'text',
          content:
            'CDK then creates a CodeBuildStep per stage/step and assembles a CodePipeline (Source to Synth to Stages), emitting a CloudFormation template with these resources:',
        },
        {
          type: 'list',
          items: [
            'AWS::CodePipeline::Pipeline — the pipeline itself.',
            'AWS::CodeBuild::Project (x N) — one per stage/step, image + computeType + buildspec from the plugin.',
            'AWS::Lambda::Function — the plugin lookup resolver.',
            'AWS::IAM::Role — pipeline execution role.',
            'AWS::S3::Bucket — artifacts; AWS::CloudWatch::LogGroup — logs.',
          ],
        },
      ],
    },
    {
      id: 'codepipeline-execution',
      title: 'Flow 4: CodePipeline Execution',
      blocks: [
        {
          type: 'text',
          content:
            'When the generated pipeline runs (triggered by a source change, schedule, or manual start), CodePipeline fetches the source, then runs each stage in CodeBuild. Each step pulls its plugin container image and runs the plugin commands inside it.',
        },
        {
          type: 'list',
          items: [
            'Source — fetch code (e.g. GitHub push/webhook).',
            'Synth — pull the cdk-synth image and run pipeline-manager synth, producing cdk.out/.',
            'SelfMutation — update the pipeline if its definition changed.',
            'Stages (Test, Security, Deploy, ...) — pull each plugin image and run its commands/scans/deploy.',
          ],
        },
        {
          type: 'note',
          content:
            'A plugin DB record (name, version, commands, computeType) becomes a CodeBuildStep at synth time (image registry/org-acme/eslint:1.0.0, ComputeType BUILD_GENERAL1_SMALL, buildspec from commands), which CodeBuild then pulls and runs at pipeline runtime.',
        },
      ],
    },
    {
      id: 'components-isolation',
      title: 'Key Components & Multi-Team Isolation',
      blocks: [
        {
          type: 'table',
          headers: ['Component', 'Purpose', 'Key Location'],
          rows: [
            ['Frontend', 'Pipeline/plugin management UI', 'frontend/pages/dashboard/'],
            ['Platform API', 'Auth gateway, user/org management', 'platform/src/controllers/'],
            ['Pipeline API', 'Pipeline CRUD, compliance', 'api/pipeline/src/'],
            ['Plugin API', 'Plugin upload, build queue, AI generation', 'api/plugin/src/'],
            ['Image Registry', 'Bearer-token minting, image management/GC', 'api/image-registry/src/'],
            ['pipeline-core', 'CDK constructs, plugin lookup', 'packages/pipeline-core/src/pipeline/'],
            ['pipeline-data', 'DB schemas (Drizzle ORM)', 'packages/pipeline-data/src/database/'],
            ['pipeline-manager', 'CLI for cdk synth/deploy', 'packages/pipeline-manager/'],
            ['buildkitd sidecar', 'Rootless BuildKit daemon for plugin builds', 'K8s / ECS sidecar / compose'],
            ['Registry', 'Docker image storage', 'Docker Registry v2'],
          ],
        },
        {
          type: 'warning',
          content:
            'Everything is scoped per organization: plugins by orgId + accessModifier, pipelines by project/org/orgId, secrets under AWS SM path /prefix/<orgId>/secretName, plus per-org quotas and per-org compliance policy rules.',
        },
      ],
    },
  ],
};
