# kubectl-deploy

Kubernetes deployment plugin using kubectl for applying, deleting, and rolling out resources with EKS authentication support via AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** deploy  
**Plugin Type:** CodeBuildStep  
**Compute:** SMALL  
**Timeout:** 15 minutes  
**Failure Behavior:** fail  

## Keywords

`kubernetes`, `kubectl`, `manifest`, `deploy`

## Requirements

- AWS CLI configured with appropriate permissions
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
| `KUBE_CONTEXT` | _none_ | Kube Context |
| `KUBE_NAMESPACE` | `default` | Kube Namespace |
| `DEPLOY_ACTION` | `apply` | Deploy Action |
| `MANIFEST_PATH` | `k8s/` | Manifest Path |
| `ROLLOUT_TIMEOUT` | `300s` | Rollout Timeout |

## Output

Primary output directory: `deploy-output`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "kubectl-deploy",
  "plugin": "kubectl-deploy",
  "env": {
    "KUBE_CONTEXT": "<your-kube_context>",
    "KUBE_NAMESPACE": "default",
    "DEPLOY_ACTION": "apply",
    "MANIFEST_PATH": "k8s/",
    "ROLLOUT_TIMEOUT": "300s"
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
