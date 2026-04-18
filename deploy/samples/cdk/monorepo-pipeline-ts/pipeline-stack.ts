// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
  PipelineBuilder,
  BuilderProps,
  StageStepOptions,
} from '@mwashburn160/pipeline-core';

/**
 * Monorepo pipeline stack.
 * Builds and deploys multiple services (frontend, backend API, worker)
 * from a single repository using step command hooks, artifact chaining,
 * and environment variable customization per service.
 */
export class MonorepoPipelineStack extends Stack {
  public readonly pipeline: PipelineBuilder;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Reusable step factory for Node.js services
    const createNodeStep = (
      serviceName: string,
      workdir: string,
      overrides?: Partial<StageStepOptions>,
    ): StageStepOptions => ({
      plugin: {
        name: 'nodejs-build',
        alias: `build-${serviceName}`,
        filter: { version: '1.0.0', accessModifier: 'public', isActive: true, isDefault: true },
        metadata: { NODE_VERSION: '20' },
      },
      position: 'pre',
      timeout: 15,
      preCommands: [`cd ${workdir}`],
      commands: ['npm ci', 'npm run build', 'npm test -- --ci'],
      postCommands: ['cd ..'],
      env: { SERVICE_NAME: serviceName, WORKDIR: workdir },
      ...overrides,
    });

    // Reusable step factory for Docker container builds
    const createDockerStep = (
      serviceName: string,
      workdir: string,
      imageTag: string,
    ): StageStepOptions => ({
      plugin: {
        name: 'docker-build',
        alias: `docker-${serviceName}`,
        filter: { version: '1.0.0', accessModifier: 'public', isActive: true, isDefault: true },
        metadata: {
          DOCKERFILE: `${workdir}/Dockerfile`,
          IMAGE_TAG: imageTag,
          'aws:cdk:codebuild:buildenvironment:privileged': true,
        },
      },
      position: 'post',
      commands: [
        `docker build -f ${workdir}/Dockerfile -t acmecorp/${serviceName}:${imageTag} ${workdir}`,
      ],
    });

    const pipelineProps: BuilderProps = {
      project: 'platform-monorepo',
      organization: 'AcmeCorp',

      global: {
        'aws:cdk:pipelines:codepipeline:selfmutation': true,
        'aws:cdk:pipelines:codepipeline:dockerenabledforselfmutation': true,
        'aws:cdk:pipelines:codepipeline:publishassetsinparallel': true,
        'aws:cdk:pipelines:codepipeline:crossaccountkeys': true,
        'aws:cdk:pipelines:codepipeline:enablekeyrotation': true,
        'aws:cdk:pipelines:codepipeline:reusecrossregionsupportstacks': true,
        'aws:cdk:pipelines:codepipeline:usechangesets': false,
      },

      defaults: {
        metadata: {
          'aws:cdk:codebuild:buildenvironment:computetype': 'MEDIUM',
        },
      },

      synth: {
        source: {
          type: 'codestar',
          options: {
            repo: 'acmecorp/platform-monorepo',
            branch: 'main',
            connectionArn: 'arn:aws:codestar-connections:us-east-1:111111111111:connection/abc12345-def6-7890-ghij-klmnopqrstuv',
            trigger: 'AUTO',
            codeBuildCloneOutput: true, // Full git clone for monorepo dependency resolution
          },
        },
        plugin: {
          name: 'cdk-synth',
          filter: { version: '1.0.0', accessModifier: 'public', isActive: true, isDefault: true },
          metadata: { NODE_VERSION: '20' },
        },
        preInstallCommands: [
          'npm install -g pnpm',  // Install pnpm for workspace management
        ],
        env: {
          CDK_DEFAULT_REGION: 'us-east-1',
        },
      },

      stages: [
        // Lint all packages in parallel (pre position = same wave)
        {
          stageName: 'Lint',
          steps: [
            {
              plugin: {
                name: 'eslint',
                alias: 'lint-all',
                filter: { version: '1.0.0', accessModifier: 'public', isActive: true, isDefault: true },
                metadata: { NODE_VERSION: '20' },
              },
              position: 'pre',
              preInstallCommands: ['npm install -g pnpm'],
              commands: ['pnpm install --frozen-lockfile', 'pnpm -r run lint'],
            },
            {
              plugin: {
                name: 'typescript-check',
                alias: 'typecheck-all',
                filter: { version: '1.0.0', accessModifier: 'public', isActive: true },
                metadata: { NODE_VERSION: '20' },
              },
              position: 'pre',
              preInstallCommands: ['npm install -g pnpm'],
              commands: ['pnpm install --frozen-lockfile', 'pnpm -r run typecheck'],
            },
          ],
        },

        // Build and test each service
        {
          stageName: 'Build-Services',
          steps: [
            createNodeStep('frontend', 'packages/frontend'),
            createNodeStep('api', 'packages/api', {
              position: 'pre',
              timeout: 20,
            }),
            createNodeStep('worker', 'packages/worker', {
              position: 'pre',
              timeout: 20,
            }),
          ],
        },

        // Build Docker images for each service
        {
          stageName: 'Package',
          steps: [
            createDockerStep('frontend', 'packages/frontend', 'latest'),
            createDockerStep('api', 'packages/api', 'latest'),
            createDockerStep('worker', 'packages/worker', 'latest'),
          ],
        },

        // Security scan across the entire monorepo
        {
          stageName: 'Security',
          steps: [
            {
              plugin: {
                name: 'snyk-nodejs',
                filter: { version: '1.0.0', accessModifier: 'public', isActive: true, isDefault: true },
                metadata: { SNYK_SEVERITY_THRESHOLD: 'high' },
              },
              position: 'pre',
              failureBehavior: 'warn',
              preInstallCommands: ['npm install -g pnpm'],
              commands: [
                'pnpm install --frozen-lockfile',
                'npm install -g snyk',
                'snyk test --all-projects --severity-threshold=high',
              ],
            },
            {
              plugin: {
                name: 'trivy-nodejs',
                filter: { version: '1.0.0', accessModifier: 'public', isActive: true, isDefault: true },
                metadata: { TRIVY_SEVERITY: 'HIGH,CRITICAL' },
              },
              position: 'post',
              failureBehavior: 'warn',
              commands: [
                'trivy image --severity HIGH,CRITICAL acmecorp/frontend:latest',
                'trivy image --severity HIGH,CRITICAL acmecorp/api:latest',
                'trivy image --severity HIGH,CRITICAL acmecorp/worker:latest',
              ],
            },
          ],
        },

        // Deploy all services
        {
          stageName: 'Deploy',
          steps: [
            {
              plugin: {
                name: 'cdk-deploy',
                filter: { version: '1.0.0', accessModifier: 'public', isActive: true, isDefault: true },
                metadata: {
                  NODE_VERSION: '20',
                  DEPLOY_STAGE: 'production',
                },
              },
              position: 'pre',
              timeout: 30,
              preInstallCommands: ['npm install -g pnpm'],
              commands: [
                'pnpm install --frozen-lockfile',
                'npx cdk deploy --all --require-approval never',
              ],
            },
          ],
        },
      ],
    };

    this.pipeline = new PipelineBuilder(this, 'Pipeline', pipelineProps);
  }
}
