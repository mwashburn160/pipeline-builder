# helm-deploy

Helm chart deployment plugin for Kubernetes with install, upgrade, uninstall, and template actions including EKS authentication support via AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** deploy  
**Plugin Type:** CodeBuildStep  
**Compute:** SMALL  
**Timeout:** 15 minutes  
**Failure Behavior:** fail  

## Keywords

`kubernetes`, `helm`, `chart`, `deploy`

## Requirements

- AWS CLI configured with appropriate permissions
- Helm
- kubectl with cluster access
- 1 optional secret(s) for additional features (see [Secrets](#secrets) below)

## Secrets

| Name | Required | Description |
|------|----------|-------------|
| `KUBECONFIG_DATA` | No | Base64-encoded kubeconfig; not needed if running in EKS with IAM role |

### Setting Up Secrets

Secrets are injected at build time via AWS CodeBuild environment variables backed by AWS Secrets Manager.

**Step 1: Store secrets in AWS Secrets Manager**

```bash
aws secretsmanager create-secret --name "KUBECONFIG_DATA" --secret-string "<your-value>"
```

**Step 2: Reference secrets in your pipeline configuration**

When configuring this plugin in your pipeline, map each secret to the corresponding AWS Secrets Manager ARN:

```json
{
  "secrets": {
    "KUBECONFIG_DATA": "arn:aws:secretsmanager:<region>:<account>:secret:KUBECONFIG_DATA"
  }
}
```

**Step 3: IAM permissions**

Ensure the CodeBuild service role has `secretsmanager:GetSecretValue` permission for the referenced secrets.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `HELM_RELEASE` | _none_ | Helm Release |
| `HELM_CHART` | _none_ | Helm Chart |
| `HELM_NAMESPACE` | `default` | Helm Namespace |
| `HELM_ACTION` | `upgrade` | Helm Action |
| `HELM_VALUES_FILE` | _none_ | Helm Values File |
| `HELM_SET_VALUES` | _none_ | Helm Set Values |
| `HELM_TIMEOUT` | `300s` | Helm Timeout |
| `HELM_ATOMIC` | `true` | Helm Atomic |
| `HELM_REPO_URL` | _none_ | Helm Repo Url |
| `HELM_REPO_NAME` | _none_ | Helm Repo Name |

## Output

Primary output directory: `helm-output`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "helm-deploy",
  "plugin": "helm-deploy",
  "env": {
    "HELM_RELEASE": "<your-helm_release>",
    "HELM_CHART": "<your-helm_chart>",
    "HELM_NAMESPACE": "default",
    "HELM_ACTION": "upgrade",
    "HELM_VALUES_FILE": "<your-helm_values_file>",
    "HELM_SET_VALUES": "<your-helm_set_values>",
    "HELM_TIMEOUT": "300s",
    "HELM_ATOMIC": "true",
    "HELM_REPO_URL": "<your-helm_repo_url>",
    "HELM_REPO_NAME": "<your-helm_repo_name>"
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
