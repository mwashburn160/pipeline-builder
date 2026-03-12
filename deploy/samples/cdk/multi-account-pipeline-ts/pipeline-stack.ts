import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
  PipelineBuilder,
  BuilderProps,
  RoleConfig,
  StageOptions,
} from '@mwashburn160/pipeline-core';

/**
 * Multi-account deployment pipeline.
 * Deploys through staging → approval → production across separate AWS accounts.
 * Features cross-account KMS keys, IAM role assumption, CodeStar connection,
 * ManualApprovalStep gate, and post-deploy health checks.
 */
export class MultiAccountPipelineStack extends Stack {
  public readonly pipeline: PipelineBuilder;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Accounts
    const TOOLING_ACCOUNT = '111111111111';
    const STAGING_ACCOUNT = '222222222222';
    const PRODUCTION_ACCOUNT = '333333333333';

    // IAM role for the CodePipeline (must trust codepipeline.amazonaws.com)
    const pipelineRole: RoleConfig = {
      type: 'roleArn',
      options: {
        roleArn: `arn:aws:iam::${TOOLING_ACCOUNT}:role/AcmeCorp-PipelineRole`,
        mutable: false,
      },
    };

    // Helper to create a deploy + health-check stage
    const createDeployStage = (
      stageName: string,
      account: string,
      region: string,
      healthUrl: string,
      alias: string,
    ): StageOptions => ({
      stageName,
      steps: [
        {
          plugin: {
            name: 'cdk-deploy',
            alias: `deploy-${alias}`,
            filter: { version: '1.0.0', accessModifier: 'public', isActive: true, isDefault: true },
            metadata: {
              NODE_VERSION: '20',
              TARGET_ACCOUNT: account,
              TARGET_REGION: region,
              DEPLOY_STAGE: alias,
            },
          },
          position: 'pre',
          timeout: 30,
          commands: ['npm ci', 'npx cdk deploy --all --require-approval never'],
        },
        {
          plugin: {
            name: 'health-check',
            alias: `health-${alias}`,
            filter: { version: '1.0.0', accessModifier: 'public', isActive: true },
            metadata: { HEALTH_CHECK_URL: healthUrl, EXPECTED_STATUS: '200' },
          },
          position: 'post',
          timeout: 10,
          commands: [`curl -sf ${healthUrl} || exit 1`],
        },
      ],
    });

    const pipelineProps: BuilderProps = {
      project: 'payment-service',
      organization: 'AcmeCorp',
      orgId: 'acmecorp-tenant-001',

      global: {
        'aws:cdk:pipelines:codepipeline:selfmutation': true,
        'aws:cdk:pipelines:codepipeline:dockerenabledforselfmutation': true,
        'aws:cdk:pipelines:codepipeline:publishassetsinparallel': true,
        'aws:cdk:pipelines:codepipeline:crossaccountkeys': true,
        'aws:cdk:pipelines:codepipeline:enablekeyrotation': true,
        'aws:cdk:pipelines:codepipeline:reusecrossregionsupportstacks': true,
        'aws:cdk:pipelines:codepipeline:usechangesets': false,
      },

      role: pipelineRole,

      synth: {
        source: {
          type: 'codestar',
          options: {
            repo: 'acmecorp/payment-service',
            branch: 'main',
            connectionArn: `arn:aws:codestar-connections:us-east-1:${TOOLING_ACCOUNT}:connection/abc12345-def6-7890-ghij-klmnopqrstuv`,
            trigger: 'AUTO',
            codeBuildCloneOutput: true,
          },
        },
        plugin: {
          name: 'cdk-synth',
          filter: { version: '1.0.0', accessModifier: 'public', isActive: true, isDefault: true },
          metadata: { NODE_VERSION: '20' },
        },
        env: {
          CDK_DEFAULT_REGION: 'us-east-1',
          CDK_DEFAULT_ACCOUNT: TOOLING_ACCOUNT,
        },
      },

      stages: [
        // Build and test
        {
          stageName: 'Build-Test',
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
              timeout: 20,
              commands: ['npm ci', 'npm run build', 'npm test -- --ci'],
            },
          ],
        },

        // Security gate
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

        // Deploy to staging
        createDeployStage(
          'Deploy-Staging',
          STAGING_ACCOUNT,
          'us-east-1',
          'https://staging.acmecorp.com/health',
          'staging',
        ),

        // Manual approval gate before production
        {
          stageName: 'Approval',
          steps: [
            {
              plugin: {
                name: 'manual-approval',
                filter: { version: '1.0.0', accessModifier: 'public', isActive: true, isDefault: true },
                metadata: {
                  APPROVAL_COMMENT: `Approve deployment to production (account ${PRODUCTION_ACCOUNT})?`,
                },
              },
              position: 'pre',
            },
          ],
        },

        // Deploy to production
        createDeployStage(
          'Deploy-Production',
          PRODUCTION_ACCOUNT,
          'us-east-1',
          'https://app.acmecorp.com/health',
          'production',
        ),
      ],
    };

    this.pipeline = new PipelineBuilder(this, 'Pipeline', pipelineProps);
  }
}
