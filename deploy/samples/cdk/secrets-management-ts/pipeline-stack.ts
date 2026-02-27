import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
  PipelineBuilder,
  BuilderProps,
} from '@mwashburn160/pipeline-core';

/**
 * Secrets management pipeline.
 * Demonstrates how secrets are injected at two levels:
 *
 *   1. Global (pipeline-level via `orgId`) — enables per-tenant secret resolution
 *      for ALL plugins that declare `secrets` in their plugin definition. Secrets
 *      are resolved from AWS Secrets Manager at: pipeline-builder/{orgId}/{secretName}
 *
 *   2. Step-level — individual steps can reference secrets through:
 *      - Plugin `secrets` declarations (resolved automatically when orgId is set)
 *      - Environment variables pointing to secret paths
 *      - Metadata keys for secret-dependent configuration
 *
 * Plugin secrets are declared in the plugin database record and automatically
 * injected as SECRETS_MANAGER-type CodeBuild environment variables when `orgId`
 * is provided. No manual secret wiring is needed — just ensure the secrets
 * exist in Secrets Manager at the expected path.
 */
export class SecretsManagementPipelineStack extends Stack {
  public readonly pipeline: PipelineBuilder;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const pipelineProps: BuilderProps = {
      project: 'payment-gateway',
      organization: 'AcmeCorp',

      // ─── Global: orgId enables tenant-scoped secret resolution ───────
      // When orgId is set, ALL plugins that declare `secrets` in their
      // plugin definition will have those secrets automatically injected
      // as SECRETS_MANAGER environment variables.
      //
      // Secret path convention: pipeline-builder/{orgId}/{secretName}
      //
      // Example: A plugin declaring secrets: [{ name: 'API_KEY', required: true }]
      // will have API_KEY resolved from:
      //   pipeline-builder/acmecorp-tenant-001/API_KEY
      //
      // This means each tenant's secrets are isolated in their own
      // Secrets Manager namespace.
      orgId: 'acmecorp-tenant-001',

      global: {
        'aws:cdk:pipelines:codepipeline:selfmutation': true,
        'aws:cdk:pipelines:codepipeline:dockerenabledforselfmutation': true,
        'aws:cdk:pipelines:codepipeline:publishassetsinparallel': true,
        'aws:cdk:pipelines:codepipeline:crossaccountkeys': true,
        'aws:cdk:pipelines:codepipeline:enablekeyrotation': true,
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
            repo: 'acmecorp/payment-gateway',
            branch: 'main',
            // The connection ARN itself can be stored in Secrets Manager
            connectionArn: 'arn:aws:codestar-connections:us-east-1:111111111111:connection/abc12345-def6-7890-ghij-klmnopqrstuv',
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
        },
      },

      stages: [
        // ─── Build-Test: Plugin secrets auto-injected ──────────────────
        // The nodejs-build plugin might declare secrets like:
        //   secrets: [{ name: 'NPM_TOKEN', required: true, description: 'npm registry auth token' }]
        //
        // Because orgId is set globally, this secret is automatically
        // resolved at build time from:
        //   pipeline-builder/acmecorp-tenant-001/NPM_TOKEN
        //
        // The step does NOT need to reference the secret explicitly —
        // it appears as a SECRETS_MANAGER env var in CodeBuild.
        {
          stageName: 'Build-Test',
          steps: [
            {
              plugin: {
                name: 'nodejs-build',
                filter: { version: '1.0.0', accessModifier: 'public', isActive: true, isDefault: true },
                metadata: { NODE_VERSION: '20' },
              },
              position: 'pre',
              timeout: 20,
              commands: [
                // NPM_TOKEN is available as an env var (injected from Secrets Manager)
                'echo "//registry.npmjs.org/:_authToken=${NPM_TOKEN}" > .npmrc',
                'npm ci',
                'npm run build',
                'npm test -- --ci',
              ],
            },
          ],
        },

        // ─── Security: Snyk uses its own plugin-declared secret ────────
        // The snyk plugin declares:
        //   secrets: [{ name: 'SNYK_TOKEN', required: true, description: 'Snyk API token' }]
        //
        // Resolved from: pipeline-builder/acmecorp-tenant-001/SNYK_TOKEN
        {
          stageName: 'Security',
          steps: [
            {
              plugin: {
                name: 'snyk',
                filter: { version: '1.0.0', accessModifier: 'public', isActive: true, isDefault: true },
                metadata: { SNYK_SEVERITY_THRESHOLD: 'high' },
              },
              position: 'pre',
              commands: [
                'npm install -g snyk',
                // SNYK_TOKEN is injected automatically from Secrets Manager
                'snyk auth $SNYK_TOKEN',
                'snyk test --severity-threshold=high',
              ],
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

        // ─── Container: Docker push with registry credentials ──────────
        // The docker-build plugin declares:
        //   secrets: [
        //     { name: 'DOCKER_USERNAME', required: true },
        //     { name: 'DOCKER_PASSWORD', required: true },
        //   ]
        //
        // Both resolved from Secrets Manager under the orgId namespace.
        // Step-level env vars can also reference secrets by combining
        // PLAINTEXT vars with SECRETS_MANAGER vars.
        {
          stageName: 'Container',
          steps: [
            {
              plugin: {
                name: 'docker-build',
                filter: { version: '1.0.0', accessModifier: 'public', isActive: true, isDefault: true },
                metadata: {
                  DOCKERFILE: 'Dockerfile',
                  IMAGE_TAG: 'latest',
                  'aws:cdk:codebuild:buildenvironment:privileged': true,
                },
              },
              position: 'pre',
              commands: [
                // DOCKER_USERNAME and DOCKER_PASSWORD from Secrets Manager
                'echo "$DOCKER_PASSWORD" | docker login -u "$DOCKER_USERNAME" --password-stdin',
                'docker build -t acmecorp/payment-gateway:latest .',
                'docker push acmecorp/payment-gateway:latest',
              ],
            },
            {
              plugin: {
                name: 'container-scan',
                filter: { version: '1.0.0', accessModifier: 'public', isActive: true },
                metadata: { IMAGE: 'acmecorp/payment-gateway:latest' },
              },
              position: 'post',
              failureBehavior: 'warn',
              commands: ['trivy image --severity HIGH,CRITICAL acmecorp/payment-gateway:latest'],
            },
          ],
        },

        // ─── Deploy: Multiple secrets for deployment credentials ───────
        // The cdk-deploy plugin declares:
        //   secrets: [
        //     { name: 'AWS_DEPLOY_ROLE_ARN', required: true, description: 'Role to assume for deploy' },
        //     { name: 'DATADOG_API_KEY', required: false, description: 'Optional monitoring key' },
        //   ]
        //
        // Required secrets cause a build failure if missing.
        // Optional secrets (required: false) are silently skipped if not found.
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
              commands: ['npm ci', 'npx cdk deploy --all --require-approval never'],
            },
          ],
        },

        // ─── Notify: Slack webhook secret ──────────────────────────────
        // The slack-notify plugin declares:
        //   secrets: [{ name: 'SLACK_WEBHOOK_URL', required: true }]
        //
        // Resolved from: pipeline-builder/acmecorp-tenant-001/SLACK_WEBHOOK_URL
        {
          stageName: 'Notify',
          steps: [
            {
              plugin: {
                name: 'slack-notify',
                filter: { version: '1.0.0', accessModifier: 'public', isActive: true },
                metadata: {
                  SLACK_CHANNEL: '#deployments',
                  SLACK_MESSAGE: 'payment-gateway deployed to production',
                },
              },
              position: 'pre',
              failureBehavior: 'ignore',
              commands: [
                // SLACK_WEBHOOK_URL from Secrets Manager
                'curl -X POST "$SLACK_WEBHOOK_URL" -H "Content-Type: application/json" -d \'{"channel":"#deployments","text":"payment-gateway deployed successfully"}\'',
              ],
            },
          ],
        },
      ],
    };

    this.pipeline = new PipelineBuilder(this, 'Pipeline', pipelineProps);
  }
}
