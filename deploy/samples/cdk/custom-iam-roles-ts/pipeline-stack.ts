import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
  PipelineBuilder,
  BuilderProps,
  RoleConfig,
} from '@mwashburn160/pipeline-core';

/**
 * Custom IAM roles pipeline.
 * Demonstrates role configuration at two levels:
 *   1. Pipeline-level role (global) — the IAM role assumed by CodePipeline itself
 *   2. Step-level roles — per-step CodeBuild project and action roles via metadata
 *
 * The pipeline-level `role` controls who CodePipeline runs as.
 * Step-level roles control individual CodeBuild project permissions using
 * `aws:cdk:pipelines:codebuildstep:role` and `aws:cdk:pipelines:codebuildstep:actionrole` metadata keys.
 */
export class CustomIamRolesPipelineStack extends Stack {
  public readonly pipeline: PipelineBuilder;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const ACCOUNT_ID = '111111111111';

    // ─── Global: Pipeline-level IAM role ───────────────────────────────
    // This role is assumed by CodePipeline itself.
    // Must have a trust policy for codepipeline.amazonaws.com.
    // Set mutable: false to prevent CDK from adding permissions automatically.
    const pipelineRole: RoleConfig = {
      type: 'roleArn',
      options: {
        roleArn: `arn:aws:iam::${ACCOUNT_ID}:role/AcmeCorp-CodePipeline-Role`,
        mutable: false,
      },
    };

    // ─── Alternative: OIDC-based pipeline role (dynamic, no static ARN) ─
    // Creates an IAM role with an OIDC trust policy for federated access.
    // Use this when your CI/CD provider (GitHub Actions, GitLab CI, etc.)
    // supports OIDC tokens, eliminating the need for static credentials.
    //
    // Option A: Create a new OIDC provider inline
    // const pipelineRole: RoleConfig = {
    //   type: 'oidc',
    //   options: {
    //     issuer: 'https://token.actions.githubusercontent.com',
    //     clientIds: ['sts.amazonaws.com'],
    //     thumbprints: ['6938fd4d98bab03faadb97b34396831e3780aea1'],
    //     conditions: {
    //       'token.actions.githubusercontent.com:sub': 'repo:acmecorp/secure-api:ref:refs/heads/main',
    //       'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
    //     },
    //     roleName: 'AcmeCorp-CodePipeline-OIDC-Role',
    //   },
    // };
    //
    // Option B: Reference an existing OIDC provider by ARN
    // const pipelineRole: RoleConfig = {
    //   type: 'oidc',
    //   options: {
    //     providerArn: `arn:aws:iam::${ACCOUNT_ID}:oidc-provider/token.actions.githubusercontent.com`,
    //     conditions: {
    //       'token.actions.githubusercontent.com:sub': 'repo:acmecorp/secure-api:ref:refs/heads/main',
    //     },
    //   },
    // };
    //
    // Option C: Wildcard matching for multiple repos/branches
    // const pipelineRole: RoleConfig = {
    //   type: 'oidc',
    //   options: {
    //     providerArn: `arn:aws:iam::${ACCOUNT_ID}:oidc-provider/token.actions.githubusercontent.com`,
    //     conditionsLike: {
    //       'token.actions.githubusercontent.com:sub': 'repo:acmecorp/*',
    //     },
    //   },
    // };

    const pipelineProps: BuilderProps = {
      project: 'secure-api',
      organization: 'AcmeCorp',

      global: {
        'aws:cdk:pipelines:codepipeline:selfmutation': true,
        'aws:cdk:pipelines:codepipeline:dockerenabledforselfmutation': true,
        'aws:cdk:pipelines:codepipeline:publishassetsinparallel': true,
        'aws:cdk:pipelines:codepipeline:crossaccountkeys': true,
        'aws:cdk:pipelines:codepipeline:enablekeyrotation': true,
        'aws:cdk:pipelines:codepipeline:usechangesets': false,
      },

      // Pipeline-level role — applies globally to the CodePipeline construct
      role: pipelineRole,

      synth: {
        source: {
          type: 'codestar',
          options: {
            repo: 'acmecorp/secure-api',
            branch: 'main',
            connectionArn: `arn:aws:codestar-connections:us-east-1:${ACCOUNT_ID}:connection/abc12345-def6-7890-ghij-klmnopqrstuv`,
            trigger: 'AUTO',
            codeBuildCloneOutput: true,
          },
        },
        plugin: {
          name: 'cdk-synth',
          filter: { version: '1.0.0', accessModifier: 'public', isActive: true, isDefault: true },
          metadata: { NODE_VERSION: '20' },
        },
      },

      stages: [
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

                  // ─── Step-level: CodeBuild project role ──────────────────
                  // This role is assumed by the CodeBuild project itself.
                  // Must trust codebuild.amazonaws.com.
                  // Use this when the build step needs specific AWS permissions
                  // (e.g., read from a private ECR registry, access DynamoDB).
                  'aws:cdk:pipelines:codebuildstep:role': `arn:aws:iam::${ACCOUNT_ID}:role/AcmeCorp-CodeBuild-BuildTest-Role`,
                },
              },
              position: 'pre',
              timeout: 20,
              commands: ['npm ci', 'npm run build', 'npm test -- --ci'],
            },
          ],
        },

        {
          stageName: 'Security',
          steps: [
            {
              plugin: {
                name: 'snyk',
                filter: { version: '1.0.0', accessModifier: 'public', isActive: true, isDefault: true },
                metadata: {
                  SNYK_SEVERITY_THRESHOLD: 'high',

                  // ─── Step-level: CodePipeline action role ────────────────
                  // This role is assumed by the CodePipeline action that
                  // triggers this CodeBuild step. Controls what CodePipeline
                  // can do when invoking this specific action (e.g., pass
                  // artifacts cross-account, access specific S3 buckets).
                  'aws:cdk:pipelines:codebuildstep:actionrole': `arn:aws:iam::${ACCOUNT_ID}:role/AcmeCorp-Action-SecurityScan-Role`,
                },
              },
              position: 'pre',
              commands: ['npm install -g snyk', 'snyk test --severity-threshold=high'],
            },
            {
              plugin: {
                name: 'trivy',
                filter: { version: '1.0.0', accessModifier: 'public', isActive: true, isDefault: true },
                metadata: {
                  TRIVY_SEVERITY: 'HIGH,CRITICAL',

                  // ─── Step-level: Both project role AND action role ───────
                  // You can set both on the same step when the CodeBuild
                  // project needs different permissions than the CodePipeline
                  // action that triggers it.
                  'aws:cdk:pipelines:codebuildstep:role': `arn:aws:iam::${ACCOUNT_ID}:role/AcmeCorp-CodeBuild-ContainerScan-Role`,
                  'aws:cdk:pipelines:codebuildstep:actionrole': `arn:aws:iam::${ACCOUNT_ID}:role/AcmeCorp-Action-ContainerScan-Role`,
                },
              },
              position: 'post',
              failureBehavior: 'warn',
              commands: ['trivy fs --severity HIGH,CRITICAL .'],
            },
          ],
        },

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

                  // Deploy step needs broad permissions for CloudFormation
                  'aws:cdk:pipelines:codebuildstep:role': `arn:aws:iam::${ACCOUNT_ID}:role/AcmeCorp-CodeBuild-Deploy-Role`,

                  // Action role with cross-account artifact access
                  'aws:cdk:pipelines:codebuildstep:actionrole': `arn:aws:iam::${ACCOUNT_ID}:role/AcmeCorp-Action-Deploy-Role`,
                },
              },
              position: 'pre',
              timeout: 30,
              commands: ['npm ci', 'npx cdk deploy --all --require-approval never'],
            },
          ],
        },
      ],
    };

    this.pipeline = new PipelineBuilder(this, 'Pipeline', pipelineProps);
  }
}
