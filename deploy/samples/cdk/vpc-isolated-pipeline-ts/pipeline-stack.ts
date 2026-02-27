import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
  PipelineBuilder,
  BuilderProps,
  CodeBuildDefaults,
  NetworkConfig,
  SecurityGroupConfig,
} from '@mwashburn160/pipeline-core';

/**
 * VPC-isolated pipeline stack.
 * All CodeBuild steps run inside private subnets with security groups.
 * Demonstrates pipeline-level defaults, step-level network overrides,
 * and integration testing against internal services.
 */
export class VpcIsolatedPipelineStack extends Stack {
  public readonly pipeline: PipelineBuilder;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Pipeline-level network configuration — applies to all CodeBuild actions
    const defaultNetwork: NetworkConfig = {
      type: 'vpcId',
      options: {
        vpcId: 'vpc-0a1b2c3d4e5f6a7b8',
        subnetType: 'PRIVATE_WITH_EGRESS',
        availabilityZones: ['us-east-1a', 'us-east-1b'],
        securityGroupIds: ['sg-0abc1234def56789a'],
      },
    };

    // Additional security groups for all CodeBuild actions
    const defaultSecurityGroups: SecurityGroupConfig = {
      type: 'securityGroupLookup',
      options: {
        securityGroupName: 'acmecorp-codebuild-sg',
        vpcId: 'vpc-0a1b2c3d4e5f6a7b8',
      },
    };

    // Pipeline-level CodeBuild defaults
    const defaults: CodeBuildDefaults = {
      network: defaultNetwork,
      securityGroups: defaultSecurityGroups,
      metadata: {
        'aws:cdk:codebuild:buildenvironment:computetype': 'MEDIUM',
        'aws:cdk:codebuild:buildenvironment:privileged': true,
      },
    };

    // Step-level network override for integration tests (specific subnets)
    const integrationTestNetwork: NetworkConfig = {
      type: 'subnetIds',
      options: {
        vpcId: 'vpc-0a1b2c3d4e5f6a7b8',
        subnetIds: ['subnet-0a1b2c3d4e5f6001', 'subnet-0a1b2c3d4e5f6002'],
        securityGroupIds: ['sg-0abc1234def56789a', 'sg-0db-access-group01'],
      },
    };

    const pipelineProps: BuilderProps = {
      project: 'internal-api',
      organization: 'AcmeCorp',
      orgId: 'acmecorp-tenant-001',

      global: {
        'aws:cdk:pipelines:codepipeline:selfmutation': true,
        'aws:cdk:pipelines:codepipeline:dockerenabledforselfmutation': true,
        'aws:cdk:pipelines:codepipeline:publishassetsinparallel': true,
        'aws:cdk:pipelines:codepipeline:crossaccountkeys': false,
        'aws:cdk:pipelines:codepipeline:usechangesets': false,
      },

      defaults,

      // Synth step also runs inside VPC
      synth: {
        source: {
          type: 'github',
          options: {
            repo: 'acmecorp/internal-api',
            branch: 'main',
            trigger: 'AUTO',
          },
        },
        plugin: {
          name: 'cdk-synth',
          filter: { version: '1.0.0', accessModifier: 'public', isActive: true, isDefault: true },
          metadata: { NODE_VERSION: '20' },
        },
        // Synth-specific network config (inherits from defaults if omitted)
        network: defaultNetwork,
        env: {
          CDK_DEFAULT_REGION: 'us-east-1',
          CDK_DEFAULT_ACCOUNT: '111111111111',
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
                metadata: { NODE_VERSION: '20' },
              },
              position: 'pre',
              timeout: 20,
              commands: ['npm ci', 'npm run build', 'npm test -- --ci'],
            },
          ],
        },
        {
          stageName: 'Integration-Test',
          steps: [
            {
              plugin: {
                name: 'nodejs-build',
                alias: 'integration-tests',
                filter: { version: '1.0.0', accessModifier: 'public', isActive: true },
                metadata: { NODE_VERSION: '20' },
              },
              position: 'pre',
              timeout: 30,
              // Override network to place tests in subnets with DB access
              network: integrationTestNetwork,
              env: {
                DATABASE_URL: 'postgres://rds-internal.acmecorp.local:5432/testdb',
                REDIS_URL: 'redis://elasticache.acmecorp.local:6379',
              },
              commands: ['npm ci', 'npm run test:integration'],
            },
          ],
        },
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
                'docker build -t acmecorp/internal-api:latest .',
                'docker push acmecorp/internal-api:latest',
              ],
            },
            {
              plugin: {
                name: 'trivy',
                filter: { version: '1.0.0', accessModifier: 'public', isActive: true, isDefault: true },
                metadata: { TRIVY_SEVERITY: 'HIGH,CRITICAL' },
              },
              position: 'post',
              failureBehavior: 'warn',
              commands: ['trivy image --severity HIGH,CRITICAL acmecorp/internal-api:latest'],
            },
          ],
        },
      ],
    };

    this.pipeline = new PipelineBuilder(this, 'Pipeline', pipelineProps);
  }
}
