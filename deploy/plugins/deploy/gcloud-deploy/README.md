# gcloud-deploy

Google Cloud Platform deployment plugin supporting App Engine, Cloud Run, GKE, and Compute Engine deployments with gcloud SDK, kubectl, and Terraform using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** deploy  
**Plugin Type:** CodeBuildStep  
**Compute:** MEDIUM  
**Timeout:** 45 minutes  
**Failure Behavior:** fail  

## Keywords

`gcp`, `cloud-run`, `gke`, `deploy`

## Requirements

- Google Cloud SDK (gcloud)
- Terraform
- kubectl with cluster access
- 1 required secret(s) configured in AWS Secrets Manager (see [Secrets](#secrets) below)

## Secrets

| Name | Required | Description |
|------|----------|-------------|
| `GOOGLE_APPLICATION_CREDENTIALS` | Yes | Google Cloud service account credentials |

### Setting Up Secrets

Secrets are injected at build time via AWS CodeBuild environment variables backed by AWS Secrets Manager.

**Step 1: Store secrets in AWS Secrets Manager**

```bash
aws secretsmanager create-secret --name "GOOGLE_APPLICATION_CREDENTIALS" --secret-string "<your-value>"
```

**Step 2: Reference secrets in your pipeline configuration**

When configuring this plugin in your pipeline, map each secret to the corresponding AWS Secrets Manager ARN:

```json
{
  "secrets": {
    "GOOGLE_APPLICATION_CREDENTIALS": "arn:aws:secretsmanager:<region>:<account>:secret:GOOGLE_APPLICATION_CREDENTIALS"
  }
}
```

**Step 3: IAM permissions**

Ensure the CodeBuild service role has `secretsmanager:GetSecretValue` permission for the referenced secrets.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `GCP_PROJECT` | _none_ | Gcp Project |
| `GCP_REGION` | `us-central1` | Gcp Region |
| `DEPLOY_TYPE` | `app-engine` | Deploy Type |

## Output

Primary output directory: `gcloud-output`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "gcloud-deploy",
  "plugin": "gcloud-deploy",
  "env": {
    "GCP_PROJECT": "<your-gcp_project>",
    "GCP_REGION": "us-central1",
    "DEPLOY_TYPE": "app-engine"
  }
}
```

## Files

| File | Description |
|------|-------------|
| `plugin-spec.yaml` | Plugin configuration and build commands |
| `Dockerfile` | Container image definition |
| `plugin.zip` | Packaged plugin archive |
| `README.md` | This documentation file |
