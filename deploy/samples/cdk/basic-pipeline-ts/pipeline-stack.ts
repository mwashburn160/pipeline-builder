import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { PipelineBuilder, BuilderProps } from '@mwashburn160/pipeline-core';

/**
 * Basic pipeline stack demonstrating the simplest PipelineBuilder usage.
 * Creates a GitHub-sourced pipeline with lint, test, build, and security stages.
 */
export class BasicPipelineStack extends Stack {
  public readonly pipeline: PipelineBuilder;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const pipelineProps: BuilderProps = {
      project: 'my-web-app',
      organization: 'AcmeCorp',

      // Global metadata applied to all steps
      global: {
        'aws:cdk:pipelines:codepipeline:selfmutation': true,
        'aws:cdk:pipelines:codepipeline:dockerenabledforselfmutation': true,
        'aws:cdk:pipelines:codepipeline:publishassetsinparallel': true,
        'aws:cdk:pipelines:codepipeline:usechangesets': false,
      },

      // Synth step: source + CDK synthesis plugin
      synth: {
        source: {
          type: 'github',
          options: {
            repo: 'acmecorp/my-web-app',
            branch: 'main',
            trigger: 'AUTO',
          },
        },
        plugin: {
          name: 'cdk-synth',
          filter: {
            version: '1.0.0',
            accessModifier: 'public',
            isActive: true,
            isDefault: true,
          },
          metadata: {
            NODE_VERSION: '20',
          },
        },
      },

      // Pipeline stages
      stages: [
        {
          stageName: 'Lint',
          steps: [
            {
              plugin: {
                name: 'eslint',
                filter: { version: '1.0.0', accessModifier: 'public', isActive: true },
                metadata: { NODE_VERSION: '20' },
              },
              position: 'pre',
              commands: ['npm ci', 'npm run lint'],
            },
            {
              plugin: {
                name: 'prettier',
                filter: { version: '1.0.0', accessModifier: 'public', isActive: true },
                metadata: { NODE_VERSION: '20' },
              },
              position: 'post',
              commands: ['npm ci', 'npx prettier --check .'],
            },
          ],
        },
        {
          stageName: 'Test',
          steps: [
            {
              plugin: {
                name: 'jest',
                filter: { version: '1.0.0', accessModifier: 'public', isActive: true, isDefault: true },
                metadata: { NODE_VERSION: '20' },
              },
              position: 'pre',
              timeout: 20,
              commands: ['npm ci', 'npm test -- --ci --coverage'],
            },
          ],
        },
        {
          stageName: 'Build',
          steps: [
            {
              plugin: {
                name: 'nodejs-build',
                filter: { version: '1.0.0', accessModifier: 'public', isActive: true, isDefault: true },
                metadata: {
                  NODE_VERSION: '20',
                  'aws:cdk:codebuild:buildenvironment:computetype': 'MEDIUM',
                },
              },
              position: 'pre',
              timeout: 15,
              commands: ['npm ci', 'npm run build'],
            },
          ],
        },
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
              commands: ['npm install -g snyk', 'snyk test --severity-threshold=high'],
            },
            {
              plugin: {
                name: 'git-secrets',
                filter: { version: '1.0.0', accessModifier: 'public', isActive: true },
              },
              position: 'post',
              commands: ['git secrets --scan'],
            },
          ],
        },
      ],
    };

    this.pipeline = new PipelineBuilder(this, 'Pipeline', pipelineProps);
  }
}
