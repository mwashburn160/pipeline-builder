# Custom IAM Roles Pipeline (TypeScript)

## Overview

Demonstrates IAM role configuration at two distinct levels: the pipeline-level (global) role that CodePipeline assumes, and step-level roles that individual CodeBuild projects and CodePipeline actions assume. This pattern is essential for least-privilege security in enterprise environments.

## What This Example Shows

### Global: Pipeline-Level Role (`BuilderProps.role`)

The `role` property on `BuilderProps` sets the IAM role for the **CodePipeline construct itself**. This role must trust `codepipeline.amazonaws.com` and controls what the pipeline can do globally (access artifacts, trigger actions, manage KMS keys).

```typescript
const pipelineRole: RoleConfig = {
  type: 'roleArn',
  options: {
    roleArn: 'arn:aws:iam::111111111111:role/AcmeCorp-CodePipeline-Role',
    mutable: false, // Prevent CDK from auto-adding permissions
  },
};
```

Three `RoleConfig` variants are available:
- `roleArn` — import an existing role by ARN
- `roleName` — import an existing role by name
- `codeBuildDefault` — auto-create a role (uses `codebuild.amazonaws.com` trust, not for pipeline-level)

### Step-Level: CodeBuild Project Role (`aws:cdk:pipelines:codebuildstep:role`)

Controls what the CodeBuild project can do during execution. Set via step metadata. Must trust `codebuild.amazonaws.com`.

```typescript
metadata: {
  'aws:cdk:pipelines:codebuildstep:role': 'arn:aws:iam::...:role/BuildRole',
}
```

Use cases:
- Reading from private ECR registries
- Accessing DynamoDB or S3 during builds
- Invoking Lambda functions in tests

### Step-Level: CodePipeline Action Role (`aws:cdk:pipelines:codebuildstep:actionrole`)

Controls what CodePipeline can do when **triggering** this specific action. Set via step metadata.

```typescript
metadata: {
  'aws:cdk:pipelines:codebuildstep:actionrole': 'arn:aws:iam::...:role/ActionRole',
}
```

Use cases:
- Cross-account artifact passing
- Accessing specific S3 artifact buckets
- Scoped permissions per pipeline action

## Role Architecture

```
CodePipeline
│  Role: AcmeCorp-CodePipeline-Role (GLOBAL)
│  Trust: codepipeline.amazonaws.com
│
├── Build-Test Stage
│   └── nodejs-build step
│       Project Role: AcmeCorp-CodeBuild-BuildTest-Role
│       Trust: codebuild.amazonaws.com
│
├── Security Stage
│   ├── snyk step
│   │   Action Role: AcmeCorp-Action-SecurityScan-Role
│   │
│   └── trivy step
│       Project Role: AcmeCorp-CodeBuild-ContainerScan-Role
│       Action Role:  AcmeCorp-Action-ContainerScan-Role
│
└── Deploy Stage
    └── cdk-deploy step
        Project Role: AcmeCorp-CodeBuild-Deploy-Role
        Action Role:  AcmeCorp-Action-Deploy-Role
```

## Key Metadata Keys

| Key | Scope | Purpose |
|-----|-------|---------|
| `BuilderProps.role` | Pipeline (global) | IAM role for CodePipeline construct |
| `aws:cdk:pipelines:codebuildstep:role` | Step | IAM role for CodeBuild project |
| `aws:cdk:pipelines:codebuildstep:actionrole` | Step | IAM role for CodePipeline action |
| `aws:cdk:pipelines:codebuildstep:rolepolicystatements` | Step | Additional inline IAM policy statements |

## When to Use This Pattern

- Enterprise environments requiring least-privilege IAM per build step
- Cross-account deployments where each action needs scoped permissions
- Compliance requirements mandating separate roles for build, scan, and deploy
- Preventing privilege escalation by isolating CodeBuild project permissions
