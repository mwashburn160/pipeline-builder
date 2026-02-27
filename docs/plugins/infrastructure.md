# Infrastructure Plugins

AWS CDK synthesis/deployment and pipeline utility plugins.

## CDK Plugins

| Plugin | Purpose | Compute | Secrets | Key Env Vars |
|--------|---------|---------|---------|--------------|
| cdk-synth | Synthesize CDK app to CloudFormation | MEDIUM | None (AWS IAM) | `CDK_DEFAULT_REGION`, `CDK_DEFAULT_ACCOUNT` |
| cdk-deploy | Deploy CDK stacks to one region | MEDIUM | None (AWS IAM) | `CDK_DEPLOY_ACTION`, `CDK_STACK`, `CDK_REQUIRE_APPROVAL`, `CDK_HOTSWAP` |
| cdk-deploy-multi-region | Deploy CDK stacks across multiple regions | LARGE | None (AWS IAM) | `CDK_REGIONS`, `CDK_PRIMARY_REGION`, `CDK_DEPLOY_STRATEGY`, `CDK_ROLLBACK_ON_FAILURE` |

## Pipeline Utilities

| Plugin | Purpose | Compute | Secrets | Key Env Vars |
|--------|---------|---------|---------|--------------|
| manual-approval | Pipeline approval gate with SNS notification | SMALL | `SNS_TOPIC_ARN` (optional) | `APPROVAL_TIMEOUT`, `APPROVAL_MESSAGE` |
| s3-cache | S3 build cache with zstd compression | SMALL | None (AWS IAM) | `CACHE_BUCKET`, `CACHE_KEY`, `CACHE_PATHS`, `CACHE_ACTION` |

## CDK Workflow

```mermaid
flowchart LR
    Synth[cdk-synth] --> Deploy[cdk-deploy]
    Synth --> MultiDeploy[cdk-deploy-multi-region]
    Deploy --> SingleRegion[Single Region Stack]
    MultiDeploy --> MultiRegion[Multi-Region Stacks]
```

## Multi-Region Strategies

The `CDK_DEPLOY_STRATEGY` env var controls how stacks are deployed across regions:

### Sequential

```mermaid
flowchart LR
    Start([Start]) --> Primary[Deploy Primary Region]
    Primary -->|Success| R2[Deploy Region 2]
    R2 -->|Success| R3[Deploy Region 3]
    R3 -->|Success| Done([Complete])
    Primary -->|Failure| Rollback1[Rollback Primary]
    R2 -->|Failure| Rollback2[Rollback Region 2]
    R3 -->|Failure| Rollback3[Rollback Region 3]
    Rollback1 --> Failed([Failed])
    Rollback2 --> Failed
    Rollback3 --> Failed
```

Deploys to each region one at a time in the order specified by `CDK_REGIONS`. If a deployment fails in any region, subsequent regions are skipped. This is the safest strategy and is recommended for production workloads.

### Parallel

```mermaid
flowchart LR
    Start([Start]) --> Primary[Deploy Primary Region]
    Primary -->|Success| Fork{Fork}
    Fork --> R2[Deploy Region 2]
    Fork --> R3[Deploy Region 3]
    Fork --> R4[Deploy Region N]
    R2 --> Join{Join}
    R3 --> Join
    R4 --> Join
    Join -->|All Succeed| Done([Complete])
    Join -->|Any Failure| RollbackFailed[Rollback Failed Regions]
    RollbackFailed --> Partial([Partial - Successful Regions Kept])
    Primary -->|Failure| Failed([Failed])
```

Deploys to all regions simultaneously. Faster than sequential but provides less isolation between regions. Best suited for non-production environments or stateless workloads where region-level failures do not cascade.

### Primary Region Canary Pattern

When `CDK_PRIMARY_REGION` is set, the deployment always starts with the primary region first regardless of the chosen strategy. Once the primary region deployment succeeds, the remaining regions proceed according to the selected strategy (sequential or parallel). This allows the primary region to serve as a canary, catching issues before they propagate to all regions.

### Rollback on Failure

When `CDK_ROLLBACK_ON_FAILURE=true`, a failed deployment in any region triggers an automatic rollback of that region to the previous known-good state. In sequential mode, this also prevents deployment to subsequent regions. In parallel mode, regions that have already completed successfully are not rolled back -- only the failed region is reverted.
