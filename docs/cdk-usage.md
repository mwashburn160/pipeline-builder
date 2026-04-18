# CDK Usage Guide

Use the `PipelineBuilder` CDK construct to define pipelines as infrastructure-as-code. Pipelines deploy as native AWS CodePipeline + CodeBuild in your AWS account.

```bash
npm install @mwashburn160/pipeline-core
```

**Related docs:** [Metadata Keys](metadata-keys.md) | [Samples](samples.md) | [Plugin Catalog](plugins/README.md) | [Environment Variables](environment-variables.md)

---

## Quick Start

```typescript
import { App, Stack } from 'aws-cdk-lib';
import { PipelineBuilder } from '@mwashburn160/pipeline-core';

const app = new App();
const stack = new Stack(app, 'MyPipelineStack', {
  env: { account: '123456789012', region: 'us-east-1' },
});

new PipelineBuilder(stack, 'MyPipeline', {
  project: 'my-app',
  organization: 'my-org',
  synth: {
    source: { type: 'github', options: { repo: 'my-org/my-app', branch: 'main' } },
    plugin: { name: 'cdk-synth', version: '1.0.0' },
  },
  stages: [
    {
      stageName: 'Test',
      steps: [{ plugin: { name: 'jest', version: '1.0.0' } }],
    },
    {
      stageName: 'Deploy',
      steps: [{ plugin: { name: 'cdk-deploy', version: '1.0.0' }, env: { ENVIRONMENT: 'production' } }],
    },
  ],
});
```

---

## BuilderProps Reference

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `project` | `string` | Yes | Project identifier (sanitized to lowercase alphanumeric) |
| `organization` | `string` | Yes | Organization identifier |
| `orgId` | `string` | No | Tenant ID for resolving per-org secrets from Secrets Manager |
| `pipelineName` | `string` | No | Custom name. Default: `{organization}-{project}-pipeline` |
| `synth` | `SynthOptions` | Yes | Synthesis step configuration (source + plugin) |
| `stages` | `StageOptions[]` | No | Pipeline stages, each with one or more build steps |
| `global` | `MetaDataType` | No | Metadata inherited by all steps |
| `defaults` | `CodeBuildDefaults` | No | Pipeline-level CodeBuild defaults (VPC, env vars) |
| `role` | `RoleConfig` | No | IAM role for the CodePipeline (omit for auto-creation) |
| `schedule` | `string` | No | Cron/rate expression for scheduled execution |
| `tags` | `Record<string, string>` | No | Tags applied to all pipeline resources |

---

## Source Types

### GitHub

```typescript
synth: {
  source: {
    type: 'github',
    options: {
      repo: 'my-org/my-app',       // Required: owner/repo
      branch: 'main',               // Default: 'main'
      trigger: TriggerType.AUTO,     // AUTO = webhook, NONE = manual, SCHEDULE = cron
    },
  },
  plugin: { name: 'cdk-synth' },
}
```

### CodeStar Connection (GitHub, Bitbucket, GitLab)

```typescript
source: {
  type: 'codestar',
  options: {
    repo: 'my-org/my-app',
    branch: 'main',
    connectionArn: 'arn:aws:codestar-connections:us-east-1:123456789012:connection/abc-123',
    codeBuildCloneOutput: true,   // Enable full git history in CodeBuild
  },
}
```

### S3

```typescript
source: {
  type: 's3',
  options: {
    bucketName: 'my-source-bucket',
    objectKey: 'source.zip',       // Default: 'source.zip'
    trigger: TriggerType.AUTO,     // Poll for changes
  },
}
```

### CodeCommit

```typescript
source: {
  type: 'codecommit',
  options: {
    repositoryName: 'my-repo',
    branch: 'main',
  },
}
```

---

## Stages and Steps

Each stage contains one or more steps. Each step references a plugin.

```typescript
stages: [
  {
    stageName: 'Quality',
    steps: [
      {
        plugin: { name: 'eslint', version: '1.0.0' },
        failureBehavior: 'warn',              // Don't block pipeline on lint failures
      },
      {
        plugin: { name: 'prettier', version: '1.0.0' },
        failureBehavior: 'warn',
      },
    ],
  },
  {
    stageName: 'Test',
    steps: [
      {
        plugin: { name: 'jest', version: '1.0.0' },
        timeout: 30,                           // Minutes
        env: { NODE_ENV: 'test' },
      },
    ],
  },
  {
    stageName: 'Deploy',
    steps: [
      {
        plugin: { name: 'cdk-deploy', version: '1.0.0' },
        position: 'post',                     // Run after stage deployment
        env: { ENVIRONMENT: 'production' },
      },
    ],
  },
],
```

### Step Options

| Property | Type | Description |
|----------|------|-------------|
| `plugin` | `PluginOptions` | Plugin to run (name, version, filter) |
| `env` | `Record<string, string>` | Environment variables |
| `timeout` | `number` | Max execution time in minutes |
| `position` | `'pre' \| 'post'` | Before or after stage deployment (default: `'pre'`) |
| `failureBehavior` | `'fail' \| 'warn' \| 'ignore'` | Override plugin default |
| `metadata` | `MetaDataType` | Step-level metadata |
| `network` | `NetworkConfig` | Step-level VPC/subnet config |
| `preInstallCommands` | `string[]` | Run before plugin install commands |
| `postInstallCommands` | `string[]` | Run after plugin install commands |
| `preCommands` | `string[]` | Run before plugin build commands |
| `postCommands` | `string[]` | Run after plugin build commands |
| `inputArtifact` | `ArtifactKey` | Input from a previous step's output |

### Plugin Options

```typescript
plugin: {
  name: 'jest',                    // Required: registered plugin name
  version: '1.0.0',               // Pin a specific version
  alias: 'jest-unit',             // Alias for multiple uses of same plugin
  filter: {                        // Optional query filter
    accessModifier: 'public',
    isActive: true,
  },
  metadata: {                      // Plugin-level metadata overrides
    'aws:cdk:codebuild:buildenvironment:computetype': 'BUILD_GENERAL1_MEDIUM',
  },
}
```

---

## VPC and Network Configuration

### Pipeline-Level (applies to all CodeBuild actions)

```typescript
new PipelineBuilder(stack, 'Pipeline', {
  project: 'my-app',
  organization: 'my-org',
  defaults: {
    network: {
      type: 'vpcId',
      vpcId: 'vpc-abc123',
      subnetType: 'PRIVATE_WITH_EGRESS',
    },
  },
  synth: { ... },
  stages: [ ... ],
});
```

### Step-Level Override

```typescript
stages: [{
  stageName: 'Deploy',
  steps: [{
    plugin: { name: 'cdk-deploy' },
    network: {
      type: 'subnetIds',
      vpcId: 'vpc-abc123',
      subnetIds: ['subnet-111', 'subnet-222'],
      securityGroupIds: ['sg-abc'],
    },
  }],
}],
```

### Network Types

| Type | Description |
|------|-------------|
| `subnetIds` | Explicit VPC ID + subnet IDs + optional security group IDs |
| `vpcId` | Look up VPC by ID, select subnets by type (PRIVATE_WITH_EGRESS, PUBLIC, etc.) |
| `vpcLookup` | Look up VPC by tags, select subnets by type |

---

## IAM Roles

Three levels of IAM role control:

### Pipeline Role

The pipeline-level role uses `codepipeline.amazonaws.com` as trust principal.

```typescript
new PipelineBuilder(stack, 'Pipeline', {
  role: {
    type: 'roleArn',
    roleArn: 'arn:aws:iam::123456789012:role/MyPipelineRole',
    mutable: false,
  },
  // ...
});
```

### Step Project Role (CodeBuild)

Control the CodeBuild project's IAM role via metadata:

```typescript
steps: [{
  plugin: { name: 'cdk-deploy' },
  metadata: {
    'aws:cdk:pipelines:codebuildstep:role': JSON.stringify({
      type: 'roleArn',
      roleArn: 'arn:aws:iam::123456789012:role/MyCodeBuildRole',
    }),
  },
}],
```

### Step Action Role (CodePipeline Action)

```typescript
metadata: {
  'aws:cdk:pipelines:codebuildstep:actionrole': JSON.stringify({
    type: 'roleArn',
    roleArn: 'arn:aws:iam::123456789012:role/MyActionRole',
  }),
}
```

| Level | Config | Trust Principal |
|-------|--------|-----------------|
| Pipeline | `BuilderProps.role` | `codepipeline.amazonaws.com` |
| Step project | `codebuildstep:role` metadata | `codebuild.amazonaws.com` |
| Step action | `codebuildstep:actionrole` metadata | Pipeline's role |

### Role Types

| Type | Description |
|------|-------------|
| `roleArn` | Import existing role by ARN |
| `roleName` | Import existing role by name |
| `oidc` | Create new role with OIDC federated trust |
| `codeBuildDefault` | Create new role with `codebuild.amazonaws.com` trust (steps only) |

---

## Secrets Management

Secrets are resolved from AWS Secrets Manager at build time using the org-scoped naming convention.

```typescript
new PipelineBuilder(stack, 'Pipeline', {
  project: 'my-app',
  organization: 'acme',
  orgId: 'org-abc123',        // Enables per-org secret resolution
  synth: { ... },
  stages: [{
    stageName: 'Security',
    steps: [{
      plugin: {
        name: 'snyk-nodejs',    // Plugin declares: secrets: [{ name: 'SNYK_TOKEN', required: true }]
        version: '1.0.0',
      },
    }],
  }],
});
```

**Resolution path:** `pipeline-builder/{orgId}/SNYK_TOKEN` in Secrets Manager.

Secrets are injected as `SECRETS_MANAGER`-type CodeBuild environment variables — never stored in images or logs.

---

## Cross-Account Deployments

```typescript
new PipelineBuilder(stack, 'Pipeline', {
  project: 'my-app',
  organization: 'acme',
  global: {
    'aws:cdk:pipelines:codepipeline:crossaccountkeys': 'true',
  },
  synth: {
    source: {
      type: 'codestar',
      options: {
        repo: 'acme/my-app',
        connectionArn: 'arn:aws:codestar-connections:us-east-1:111111111111:connection/...',
      },
    },
    plugin: { name: 'cdk-synth' },
  },
  stages: [{
    stageName: 'Deploy-Staging',
    steps: [{
      plugin: { name: 'cdk-deploy' },
      env: {
        CDK_DEPLOY_ACCOUNT: '222222222222',
        CDK_DEPLOY_REGION: 'us-west-2',
      },
    }],
  }],
});
```

---

## Scheduled Pipelines

```typescript
new PipelineBuilder(stack, 'Pipeline', {
  project: 'nightly-tests',
  organization: 'acme',
  schedule: 'cron(0 2 * * ? *)',    // Run at 2 AM UTC daily
  synth: { ... },
  stages: [ ... ],
});
```

Or use source-level schedule trigger:

```typescript
source: {
  type: 's3',
  options: {
    bucketName: 'my-bucket',
    trigger: TriggerType.SCHEDULE,
    schedule: 'rate(1 day)',
  },
}
```

---

## Artifact Passing Between Steps

Pass output from one step as input to another:

```typescript
stages: [
  {
    stageName: 'Build',
    steps: [{
      plugin: { name: 'nodejs-build', alias: 'build-app' },
      // Output goes to primaryOutputDirectory (e.g., 'dist')
    }],
  },
  {
    stageName: 'Deploy',
    steps: [{
      plugin: { name: 'cdk-deploy' },
      inputArtifact: {
        stageName: 'Build',
        stageAlias: 'Build',
        pluginName: 'nodejs-build',
        pluginAlias: 'build-app',
        outputDirectory: 'dist',
      },
    }],
  },
],
```

---

## Metadata Keys

Metadata controls fine-grained CDK behavior. Set at global, defaults, or step level.

### Common Keys

| Key | Values | Description |
|-----|--------|-------------|
| `codepipeline:selfmutation` | `'true'/'false'` | Pipeline self-update on code changes |
| `codepipeline:dockerenabledforsynth` | `'true'/'false'` | Docker available during synth |
| `codepipeline:crossaccountkeys` | `'true'/'false'` | KMS keys for cross-account |
| `codebuildstep:timeout` | `'30'` | Step timeout in minutes |
| `buildenvironment:privileged` | `'true'/'false'` | Docker-in-Docker mode |
| `buildenvironment:computetype` | `'BUILD_GENERAL1_SMALL'` etc. | Instance size |
| `network:vpcid` | VPC ID | VPC for builds |
| `network:subnetids` | JSON array of subnet IDs | Subnet placement |
| `notifications:topic:arn` | SNS topic ARN | Pipeline event notifications |

See [Metadata Keys](metadata-keys.md) for the complete list of 56 keys.

---

## CDK Examples

Self-contained stack classes in [`deploy/samples/cdk/`](../deploy/samples/cdk/):

| Sample | Pattern |
|--------|---------|
| [basic-pipeline-ts](../deploy/samples/cdk/basic-pipeline-ts/) | Simplest usage — GitHub source, 4 stages |
| [vpc-isolated-pipeline-ts](../deploy/samples/cdk/vpc-isolated-pipeline-ts/) | VPC networking with step-level overrides |
| [multi-account-pipeline-ts](../deploy/samples/cdk/multi-account-pipeline-ts/) | Cross-account with CodeStar, ManualApproval |
| [monorepo-pipeline-ts](../deploy/samples/cdk/monorepo-pipeline-ts/) | Monorepo with factory functions, per-service Docker |
| [custom-iam-roles-ts](../deploy/samples/cdk/custom-iam-roles-ts/) | Three levels of IAM role control |
| [secrets-management-ts](../deploy/samples/cdk/secrets-management-ts/) | Secrets Manager with orgId-scoped resolution |
