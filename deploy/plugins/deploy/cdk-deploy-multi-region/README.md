# cdk-deploy-multi-region

AWS CDK multi-region deployment plugin for deploying CDK stacks across multiple AWS regions with sequential or parallel strategies and rollback-on-failure support using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** deploy  
**Plugin Type:** CodeBuildStep  
**Compute:** LARGE  
**Timeout:** 60 minutes  
**Failure Behavior:** fail  

## Keywords

`aws`, `cdk`, `multi-region`, `deploy`

## Requirements

- AWS CLI configured with appropriate permissions
- Node.js 24

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `CDK_DEFAULT_ACCOUNT` | `${AWS_ACCOUNT_ID}` | Cdk Default Account |
| `CDK_DEPLOY_ACTION` | `deploy` | Cdk Deploy Action |
| `CDK_STACK` | _none_ | Cdk Stack |
| `CDK_REGIONS` | _none_ | Cdk Regions |
| `CDK_PRIMARY_REGION` | _none_ | Cdk Primary Region |
| `CDK_DEPLOY_STRATEGY` | `sequential` | Cdk Deploy Strategy |
| `CDK_CONTEXT` | _none_ | CDK context values |
| `CDK_REQUIRE_APPROVAL` | `never` | Cdk Require Approval |
| `CDK_ROLLBACK_ON_FAILURE` | `true` | Cdk Rollback On Failure |
| `CDK_OUTPUTS_FILE` | `cdk-outputs.json` | Cdk Outputs File |

## Output

Primary output directory: `cdk-output`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "cdk-deploy-multi-region",
  "plugin": "cdk-deploy-multi-region",
  "env": {
    "CDK_DEFAULT_ACCOUNT": "${AWS_ACCOUNT_ID}",
    "CDK_DEPLOY_ACTION": "deploy",
    "CDK_STACK": "<your-cdk_stack>",
    "CDK_REGIONS": "<your-cdk_regions>",
    "CDK_PRIMARY_REGION": "<your-cdk_primary_region>",
    "CDK_DEPLOY_STRATEGY": "sequential",
    "CDK_CONTEXT": "<your-cdk_context>",
    "CDK_REQUIRE_APPROVAL": "never",
    "CDK_ROLLBACK_ON_FAILURE": "true",
    "CDK_OUTPUTS_FILE": "cdk-outputs.json"
  }
}
```

## Files

| File | Description |
|------|-------------|
| `spec.yaml` | Plugin configuration and build commands |
| `Dockerfile` | Container image definition |
| `plugin.zip` | Packaged plugin archive |
| `README.md` | This documentation file |
