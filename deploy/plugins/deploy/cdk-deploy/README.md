# cdk-deploy

AWS CDK single-region deployment plugin for synthesizing and deploying CDK stacks with rollback support, diff preview, and hotswap using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** deploy  
**Plugin Type:** CodeBuildStep  
**Compute:** MEDIUM  
**Timeout:** 45 minutes  
**Failure Behavior:** fail  

## Keywords

`aws`, `cdk`, `cloudformation`, `deploy`

## Requirements

- AWS CLI configured with appropriate permissions
- Node.js 24

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `CDK_DEFAULT_REGION` | `${AWS_REGION}` | Cdk Default Region |
| `CDK_DEFAULT_ACCOUNT` | `${AWS_ACCOUNT_ID}` | Cdk Default Account |
| `CDK_DEPLOY_ACTION` | `deploy` | Cdk Deploy Action |
| `CDK_STACK` | _none_ | Cdk Stack |
| `CDK_CONTEXT` | _none_ | CDK context values |
| `CDK_REQUIRE_APPROVAL` | `never` | Cdk Require Approval |
| `CDK_HOTSWAP` | `false` | Cdk Hotswap |
| `CDK_OUTPUTS_FILE` | `cdk-outputs.json` | Cdk Outputs File |

## Output

Primary output directory: `cdk-output`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "cdk-deploy",
  "plugin": "cdk-deploy",
  "env": {
    "CDK_DEFAULT_REGION": "${AWS_REGION}",
    "CDK_DEFAULT_ACCOUNT": "${AWS_ACCOUNT_ID}",
    "CDK_DEPLOY_ACTION": "deploy",
    "CDK_STACK": "<your-cdk_stack>",
    "CDK_CONTEXT": "<your-cdk_context>",
    "CDK_REQUIRE_APPROVAL": "never",
    "CDK_HOTSWAP": "false",
    "CDK_OUTPUTS_FILE": "cdk-outputs.json"
  }
}
```

## Files

| File | Description |
|------|-------------|
| `manifest.yaml` | Plugin configuration and build commands |
| `Dockerfile` | Container image definition |
| `plugin.zip` | Packaged plugin archive |
| `README.md` | This documentation file |
