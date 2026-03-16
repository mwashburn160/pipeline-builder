# Metadata Keys

Strongly-typed configuration keys for customizing CodePipeline and CodeBuild resources at synth time. Import from `@mwashburn160/pipeline-core`.

Metadata keys let you override default behavior at three levels: **pipeline-wide** (via `global`), **per-stage**, or **per-step** (via `metadata` on individual plugin references).

**Related docs:** [Samples](samples.md) | [Plugin Catalog](plugins/README.md) | [API Reference](api-reference.md)

---

## CodePipeline Configuration

Control pipeline-level behavior and defaults.

| MetadataKeys constant | String value |
|----|-----|
| `SELF_MUTATION` | `aws:cdk:pipelines:codepipeline:selfmutation` |
| `CROSS_ACCOUNT_KEYS` | `aws:cdk:pipelines:codepipeline:crossaccountkeys` |
| `DOCKER_ENABLED_FOR_SELF_MUTATION` | `aws:cdk:pipelines:codepipeline:dockerenabledforselfmutation` |
| `DOCKER_ENABLED_FOR_SYNTH` | `aws:cdk:pipelines:codepipeline:dockerenabledforsynth` |
| `ENABLE_KEY_ROTATION` | `aws:cdk:pipelines:codepipeline:enablekeyrotation` |
| `PUBLISH_ASSETS_IN_PARALLEL` | `aws:cdk:pipelines:codepipeline:publishassetsinparallel` |
| `REUSE_CROSS_REGION_SUPPORT_STACKS` | `aws:cdk:pipelines:codepipeline:reusecrossregionsupportstacks` |
| `USE_CHANGE_SETS` | `aws:cdk:pipelines:codepipeline:usechangesets` |
| `USE_PIPELINE_ROLE_FOR_ACTIONS` | `aws:cdk:pipelines:codepipeline:usepipelineroleforactions` |
| `ARTIFACT_BUCKET` | `aws:cdk:pipelines:codepipeline:artifactbucket` |
| `ASSET_PUBLISHING_CODE_BUILD_DEFAULTS` | `aws:cdk:pipelines:codepipeline:assetpublishingcodebuilddefaults` |
| `CDK_ASSETS_CLI_VERSION` | `aws:cdk:pipelines:codepipeline:cdkassetscliversion` |
| `CLI_VERSION` | `aws:cdk:pipelines:codepipeline:cliversion` |
| `CODE_BUILD_DEFAULTS` | `aws:cdk:pipelines:codepipeline:codebuilddefaults` |
| `CODE_PIPELINE` | `aws:cdk:pipelines:codepipeline:codepipeline` |
| `CROSS_REGION_REPLICATION_BUCKETS` | `aws:cdk:pipelines:codepipeline:crossregionreplicationbuckets` |
| `DOCKER_CREDENTIALS` | `aws:cdk:pipelines:codepipeline:dockercredentials` |
| `PIPELINE_NAME` | `aws:cdk:pipelines:codepipeline:pipelinename` |
| `PIPELINE_TYPE` | `aws:cdk:pipelines:codepipeline:pipelinetype` |
| `PIPELINE_ROLE` | `aws:cdk:pipelines:codepipeline:role` |
| `SELF_MUTATION_CODE_BUILD_DEFAULTS` | `aws:cdk:pipelines:codepipeline:selfmutationcodebuilddefaults` |
| `SYNTH` | `aws:cdk:pipelines:codepipeline:synth` |
| `SYNTH_CODE_BUILD_DEFAULTS` | `aws:cdk:pipelines:codepipeline:synthcodebuilddefaults` |

## CodeBuild Step Configuration

Customize individual build steps within a pipeline stage.

| MetadataKeys constant | String value |
|----|-----|
| `STEP_ROLE` | `aws:cdk:pipelines:codebuildstep:role` |
| `ACTION_ROLE` | `aws:cdk:pipelines:codebuildstep:actionrole` |
| `BUILD_ENVIRONMENT` | `aws:cdk:pipelines:codebuildstep:buildenvironment` |
| `CACHE` | `aws:cdk:pipelines:codebuildstep:cache` |
| `COMMANDS` | `aws:cdk:pipelines:codebuildstep:commands` |
| `CODE_BUILD_ENV` | `aws:cdk:pipelines:codebuildstep:env` |
| `ENV_FROM_CFN_OUTPUTS` | `aws:cdk:pipelines:codebuildstep:envfromcfnoutputs` |
| `FILE_SYSTEM_LOCATIONS` | `aws:cdk:pipelines:codebuildstep:filesystemlocations` |
| `INPUT` | `aws:cdk:pipelines:codebuildstep:input` |
| `INSTALL_COMMANDS` | `aws:cdk:pipelines:codebuildstep:installcommands` |
| `LOGGING` | `aws:cdk:pipelines:codebuildstep:logging` |
| `PARTIAL_BUILD_SPEC` | `aws:cdk:pipelines:codebuildstep:partialbuildspec` |
| `PRIMARY_OUTPUT_DIRECTORY` | `aws:cdk:pipelines:codebuildstep:primaryoutputdirectory` |
| `PROJECT_NAME` | `aws:cdk:pipelines:codebuildstep:projectname` |
| `ROLE_POLICY_STATEMENTS` | `aws:cdk:pipelines:codebuildstep:rolepolicystatements` |
| `TIMEOUT` | `aws:cdk:pipelines:codebuildstep:timeout` |

## Shell Step Configuration

Override ShellStep behavior (synth, install commands).

| MetadataKeys constant | String value |
|----|-----|
| `SHELL_COMMANDS` | `aws:cdk:pipelines:shellstep:commands` |
| `SHELL_INSTALL_COMMANDS` | `aws:cdk:pipelines:shellstep:installcommands` |
| `SHELL_ENV` | `aws:cdk:pipelines:shellstep:env` |
| `SHELL_ENV_FROM_CFN_OUTPUTS` | `aws:cdk:pipelines:shellstep:envfromcfnoutputs` |
| `SHELL_INPUT` | `aws:cdk:pipelines:shellstep:input` |
| `SHELL_ADDITIONAL_INPUTS` | `aws:cdk:pipelines:shellstep:additionalinputs` |
| `SHELL_PRIMARY_OUTPUT_DIRECTORY` | `aws:cdk:pipelines:shellstep:primaryoutputdirectory` |

## Build Environment

Configure the CodeBuild build environment (compute, images, Docker).

| MetadataKeys constant | String value |
|----|-----|
| `COMPUTE_TYPE` | `aws:cdk:codebuild:buildenvironment:computetype` |
| `BUILD_IMAGE` | `aws:cdk:codebuild:buildenvironment:buildimage` |
| `PRIVILEGED` | `aws:cdk:codebuild:buildenvironment:privileged` |
| `CERTIFICATE` | `aws:cdk:codebuild:buildenvironment:certificate` |
| `DOCKER_SERVER` | `aws:cdk:codebuild:buildenvironment:dockerserver` |
| `ENVIRONMENT_VARIABLES` | `aws:cdk:codebuild:buildenvironment:environmentvariables` |
| `FLEET` | `aws:cdk:codebuild:buildenvironment:fleet` |

## Network Configuration

Place builds inside a VPC for accessing private resources (databases, internal APIs).

| MetadataKeys constant | String value |
|----|-----|
| `NETWORK_TYPE` | `aws:cdk:ec2:network:type` |
| `NETWORK_VPC_ID` | `aws:cdk:ec2:network:vpcid` |
| `NETWORK_VPC_NAME` | `aws:cdk:ec2:network:vpcname` |
| `NETWORK_SUBNET_IDS` | `aws:cdk:ec2:network:subnetids` |
| `NETWORK_SUBNET_TYPE` | `aws:cdk:ec2:network:subnettype` |
| `NETWORK_SUBNET_GROUP_NAME` | `aws:cdk:ec2:network:subnetgroupname` |
| `NETWORK_SECURITY_GROUP_IDS` | `aws:cdk:ec2:network:securitygroupids` |
| `NETWORK_AVAILABILITY_ZONES` | `aws:cdk:ec2:network:availabilityzones` |
| `NETWORK_TAGS` | `aws:cdk:ec2:network:tags` |
| `NETWORK_REGION` | `aws:cdk:ec2:network:region` |

> **Note:** VPC builds require a NAT Gateway or VPC endpoints for pulling dependencies and reporting status back to CodePipeline.

## IAM Role Configuration

Import existing IAM roles for pipeline and build steps.

| MetadataKeys constant | String value |
|----|-----|
| `ROLE_TYPE` | `aws:cdk:iam:role:type` |
| `ROLE_ARN` | `aws:cdk:iam:role:rolearn` |
| `ROLE_NAME` | `aws:cdk:iam:role:rolename` |
| `ROLE_MUTABLE` | `aws:cdk:iam:role:mutable` |

## Security Group Configuration

Attach security groups to build containers in VPC deployments.

| MetadataKeys constant | String value |
|----|-----|
| `SECURITY_GROUP_TYPE` | `aws:cdk:ec2:securitygroup:type` |
| `SECURITY_GROUP_IDS` | `aws:cdk:ec2:securitygroup:securitygroupids` |
| `SECURITY_GROUP_NAME` | `aws:cdk:ec2:securitygroup:securitygroupname` |
| `SECURITY_GROUP_VPC_ID` | `aws:cdk:ec2:securitygroup:vpcid` |
| `SECURITY_GROUP_MUTABLE` | `aws:cdk:ec2:securitygroup:mutable` |

## Custom Build Keys

Convenience keys for common build settings.

| MetadataKeys constant | String value |
|----|-----|
| `BUILD_PARALLEL` | `aws:cdk:build:parallel` |
| `BUILD_CACHE` | `aws:cdk:build:cache` |
| `BUILD_TIMEOUT` | `aws:cdk:build:timeout` |

---

## Scope Levels

Metadata keys can be applied at different scopes. More specific scopes override broader ones.

| Scope | Where to set | Applies to |
|-------|-------------|------------|
| **Global** | `BuilderProps.global` | All steps in the pipeline |
| **Stage** | Stage-level `metadata` | All steps in that stage |
| **Step** | Step-level `metadata` | That specific build step only |

---

## Usage

Both the typed constant and the raw string value are interchangeable:

```typescript
import { MetadataKeys } from '@mwashburn160/pipeline-core';

// TypeScript — use the constant
metadata: {
  [MetadataKeys.COMPUTE_TYPE]: 'BUILD_GENERAL1_LARGE',
}

// JSON pipelines — use the string value
"metadata": {
  "aws:cdk:codebuild:buildenvironment:computetype": "BUILD_GENERAL1_LARGE"
}
```

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
