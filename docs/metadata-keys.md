# Metadata Keys

Strongly-typed keys for configuring CodePipeline and CodeBuild resources. Import from `@mwashburn160/pipeline-core`.

---

## Pipeline

```typescript
MetadataKeys.SELF_MUTATION                      // Enable self-mutation
MetadataKeys.CROSS_ACCOUNT_KEYS                 // Enable cross-account keys
MetadataKeys.DOCKER_ENABLED_FOR_SELF_MUTATION   // Docker for self-mutation
MetadataKeys.DOCKER_ENABLED_FOR_SYNTH           // Docker for synth
MetadataKeys.ENABLE_KEY_ROTATION                // KMS key rotation
MetadataKeys.PUBLISH_ASSETS_IN_PARALLEL         // Parallel asset publishing
MetadataKeys.PIPELINE_ROLE                      // Custom pipeline IAM role
MetadataKeys.PIPELINE_NAME                      // Override pipeline name
MetadataKeys.PIPELINE_TYPE                      // Pipeline type (V1, V2)
MetadataKeys.ARTIFACT_BUCKET                    // Custom artifact bucket
MetadataKeys.CODE_BUILD_DEFAULTS                // CodeBuild defaults for all steps
```

## CodeBuild Step

```typescript
MetadataKeys.STEP_ROLE                          // Custom CodeBuild role
MetadataKeys.ACTION_ROLE                        // Custom action role
MetadataKeys.BUILD_ENVIRONMENT                  // Build environment config
MetadataKeys.CACHE                              // Build cache
MetadataKeys.COMMANDS                           // Build commands
MetadataKeys.INSTALL_COMMANDS                   // Install commands
MetadataKeys.TIMEOUT                            // Build timeout
MetadataKeys.COMPUTE_TYPE                       // SMALL to X2_LARGE
MetadataKeys.PRIVILEGED                         // Privileged mode (Docker)
MetadataKeys.BUILD_IMAGE                        // Custom build image
MetadataKeys.ROLE_POLICY_STATEMENTS             // Additional IAM policies
```

## Network

```typescript
MetadataKeys.NETWORK_VPC_ID                     // VPC ID
MetadataKeys.NETWORK_SUBNET_IDS                 // Subnet IDs
MetadataKeys.NETWORK_SUBNET_TYPE                // PUBLIC, PRIVATE, etc.
MetadataKeys.NETWORK_SECURITY_GROUP_IDS         // Security group IDs
MetadataKeys.NETWORK_AVAILABILITY_ZONES         // Availability zones
```

---

## Example

```typescript
import { PipelineBuilder, MetadataKeys } from '@mwashburn160/pipeline-core';
import { Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';

const codeBuildRole = new Role(stack, 'CodeBuildRole', {
  assumedBy: new ServicePrincipal('codebuild.amazonaws.com'),
});

new PipelineBuilder(stack, 'Pipeline', {
  project: 'secure-app',
  organization: 'enterprise',
  global: {
    [MetadataKeys.CROSS_ACCOUNT_KEYS]: true,
    [MetadataKeys.DOCKER_ENABLED_FOR_SYNTH]: true,
    [MetadataKeys.SELF_MUTATION]: true,
  },
  synth: {
    source: {
      type: 'github',
      options: {
        repo: 'enterprise/secure-app',
        branch: 'main',
        connectionArn: 'arn:aws:codestar-connections:...',
      },
    },
    plugin: { name: 'build-synth', version: '1.0.0' },
    metadata: {
      [MetadataKeys.STEP_ROLE]: codeBuildRole.roleArn,
      [MetadataKeys.COMPUTE_TYPE]: 'BUILD_GENERAL1_LARGE',
      [MetadataKeys.TIMEOUT]: '60',
    },
  },
});
```
