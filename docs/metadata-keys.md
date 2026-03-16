# Metadata Keys

Strongly-typed configuration keys for customizing CodePipeline and CodeBuild resources at synth time. Import from `@mwashburn160/pipeline-core`.

Metadata keys let you override default behavior at three levels: **pipeline-wide** (via `global`), **per-stage**, or **per-step** (via `metadata` on individual plugin references).

**Related docs:** [Samples](samples.md) | [Plugin Catalog](plugins/README.md) | [API Reference](api-reference.md)

---

## Pipeline Configuration

Control pipeline-level behavior and defaults.

```typescript
MetadataKeys.SELF_MUTATION                      // Enable pipeline self-mutation (auto-update on source change)
MetadataKeys.CROSS_ACCOUNT_KEYS                 // Enable KMS keys for cross-account artifact access
MetadataKeys.DOCKER_ENABLED_FOR_SELF_MUTATION   // Allow Docker commands during self-mutation step
MetadataKeys.DOCKER_ENABLED_FOR_SYNTH           // Allow Docker commands during synth step
MetadataKeys.ENABLE_KEY_ROTATION                // Enable automatic KMS key rotation
MetadataKeys.PUBLISH_ASSETS_IN_PARALLEL         // Publish file and Docker image assets in parallel
MetadataKeys.PIPELINE_ROLE                      // ARN of a custom IAM role for the pipeline itself
MetadataKeys.PIPELINE_NAME                      // Override the auto-generated pipeline name
MetadataKeys.PIPELINE_TYPE                      // Pipeline type: V1 (standard) or V2 (improved)
MetadataKeys.ARTIFACT_BUCKET                    // ARN of a custom S3 bucket for pipeline artifacts
MetadataKeys.CODE_BUILD_DEFAULTS                // Default CodeBuild settings applied to all steps
```

## CodeBuild Step Configuration

Customize individual build steps within a pipeline stage.

```typescript
MetadataKeys.STEP_ROLE                          // ARN of a custom IAM role for the CodeBuild project
MetadataKeys.ACTION_ROLE                        // ARN of a custom IAM role for the CodePipeline action
MetadataKeys.BUILD_ENVIRONMENT                  // Full build environment configuration object
MetadataKeys.CACHE                              // Build cache config (local or S3)
MetadataKeys.COMMANDS                           // Override the plugin's default build commands
MetadataKeys.INSTALL_COMMANDS                   // Override the plugin's default install commands
MetadataKeys.TIMEOUT                            // Build timeout in minutes (max 480)
MetadataKeys.COMPUTE_TYPE                       // Instance size: SMALL (3GB), MEDIUM (7GB), LARGE (15GB), X2_LARGE (145GB)
MetadataKeys.PRIVILEGED                         // Enable privileged mode (required for Docker-in-Docker)
MetadataKeys.BUILD_IMAGE                        // Custom Docker image for the build environment
MetadataKeys.ROLE_POLICY_STATEMENTS             // Additional IAM policy statements for the build role
```

## Network Configuration

Place builds inside a VPC for accessing private resources (databases, internal APIs).

```typescript
MetadataKeys.NETWORK_VPC_ID                     // VPC ID to run builds in
MetadataKeys.NETWORK_SUBNET_IDS                 // Specific subnet IDs for build containers
MetadataKeys.NETWORK_SUBNET_TYPE                // Subnet type: PUBLIC, PRIVATE_WITH_EGRESS, PRIVATE_ISOLATED
MetadataKeys.NETWORK_SECURITY_GROUP_IDS         // Security group IDs to attach to build containers
MetadataKeys.NETWORK_AVAILABILITY_ZONES         // Restrict builds to specific availability zones
```

> **Note:** VPC builds require a NAT Gateway or VPC endpoints for pulling dependencies and reporting status back to CodePipeline.

---

## Scope Levels

Metadata keys can be applied at different scopes. More specific scopes override broader ones.

| Scope | Where to set | Applies to |
|-------|-------------|------------|
| **Global** | `BuilderProps.global` | All steps in the pipeline |
| **Stage** | Stage-level `metadata` | All steps in that stage |
| **Step** | Step-level `metadata` | That specific build step only |

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

See the [Samples](samples.md) page for more complete examples including VPC-isolated builds, cross-account deployments, and custom IAM role configurations.
