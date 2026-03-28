# azure-deploy

Azure infrastructure deployment plugin supporting Web App, Container Instances, AKS, and Function deployments with Azure CLI and kubectl using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** deploy  
**Plugin Type:** CodeBuildStep  
**Compute:** MEDIUM  
**Timeout:** 45 minutes  
**Failure Behavior:** fail  

## Keywords

`azure`, `webapp`, `aks`, `deploy`

## Requirements

- Azure CLI
- kubectl with cluster access
- 3 required secret(s) configured in AWS Secrets Manager (see [Secrets](#secrets) below)

## Secrets

| Name | Required | Description |
|------|----------|-------------|
| `AZURE_CLIENT_ID` | Yes | Azure service principal client ID |
| `AZURE_CLIENT_SECRET` | Yes | Azure service principal client secret |
| `AZURE_TENANT_ID` | Yes | Azure tenant ID |

### Setting Up Secrets

Secrets are injected at build time via AWS CodeBuild environment variables backed by AWS Secrets Manager.

**Step 1: Store secrets in AWS Secrets Manager**

```bash
aws secretsmanager create-secret --name "AZURE_CLIENT_ID" --secret-string "<your-value>"
aws secretsmanager create-secret --name "AZURE_CLIENT_SECRET" --secret-string "<your-value>"
aws secretsmanager create-secret --name "AZURE_TENANT_ID" --secret-string "<your-value>"
```

**Step 2: Reference secrets in your pipeline configuration**

When configuring this plugin in your pipeline, map each secret to the corresponding AWS Secrets Manager ARN:

```json
{
  "secrets": {
    "AZURE_CLIENT_ID": "arn:aws:secretsmanager:<region>:<account>:secret:AZURE_CLIENT_ID",
    "AZURE_CLIENT_SECRET": "arn:aws:secretsmanager:<region>:<account>:secret:AZURE_CLIENT_SECRET",
    "AZURE_TENANT_ID": "arn:aws:secretsmanager:<region>:<account>:secret:AZURE_TENANT_ID"
  }
}
```

**Step 3: IAM permissions**

Ensure the CodeBuild service role has `secretsmanager:GetSecretValue` permission for the referenced secrets.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `AZURE_SUBSCRIPTION` | _none_ | Azure Subscription |
| `AZURE_RESOURCE_GROUP` | _none_ | Azure Resource Group |
| `DEPLOY_TYPE` | `webapp` | Deploy Type |

## Output

Primary output directory: `azure-output`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "azure-deploy",
  "plugin": "azure-deploy",
  "env": {
    "AZURE_SUBSCRIPTION": "<your-azure_subscription>",
    "AZURE_RESOURCE_GROUP": "<your-azure_resource_group>",
    "DEPLOY_TYPE": "webapp"
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
