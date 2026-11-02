# ecr-push

Push container images to Amazon ECR with AWS CLI authentication, Docker Buildx support and a trivy scan of the built image using AWS CDK CodeBuildStep

**Version:** 1.1.0  
**Category:** artifact  
**Plugin Type:** CodeBuildStep  
**Compute:** MEDIUM  
**Timeout:** 15 minutes  
**Failure Behavior:** fail  

## Keywords

`container`, `docker`, `ecr`, `registry`

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `ECR_REPOSITORY` | `` | Ecr Repository |
| `IMAGE_TAG` | `latest` | Image Tag |
| `DOCKERFILE_PATH` | `Dockerfile` | Dockerfile Path |
| `DOCKER_CONTEXT` | `.` | Docker Context |
| `AWS_REGION` | `${AWS_REGION}` | Aws Region |
| `AWS_ACCOUNT_ID` | `${AWS_ACCOUNT_ID}` | Aws Account Id |
| `IMAGE_SCAN` | `true` | Scan the built image with trivy before pushing (`false` skips). |
| `IMAGE_SCAN_SEVERITY` | `HIGH,CRITICAL` | Severities printed in the build log (the JSON/SARIF reports carry every finding). |
| `IMAGE_SCAN_FAIL_ON` | _none_ | Severities that fail the step (and skip the push). Empty = report-only. |
| `IMAGE_SCAN_IGNORE_UNFIXED` | `false` | `true` ignores findings with no fix when applying `IMAGE_SCAN_FAIL_ON`. |
| `PB_UPLOAD_SECURITY_REPORTS` | `false` | `true` uploads the SARIF report to the platform (needs the org's `reporting:ingest` key: `pipeline-manager infra store-token --scope reporting:ingest`). |

## Image scan

The built image is scanned with trivy (the same pinned binary as the `trivy` plugin) **before** it is pushed. Reports land in `registry-output/security/` as `trivy-image.json` and `trivy-image.sarif`. Findings are **report-only by default**; set `IMAGE_SCAN_FAIL_ON` to fail the step (and skip the push) on findings at those severities. A scan that cannot run fails the step — an unscanned image is not a clean one. The scan needs egress to the trivy DB (`mirror.gcr.io` / `ghcr.io`).

## Output

Primary output directory: `registry-output`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "ecr-push",
  "plugin": "ecr-push",
  "env": {
    "ECR_REPOSITORY": "",
    "IMAGE_TAG": "latest",
    "DOCKERFILE_PATH": "Dockerfile",
    "DOCKER_CONTEXT": ".",
    "AWS_REGION": "${AWS_REGION}",
    "AWS_ACCOUNT_ID": "${AWS_ACCOUNT_ID}"
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
