# helm-push

Helm chart packaging and push plugin for deploying charts to OCI registries, ChartMuseum, or S3 using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** artifact  
**Plugin Type:** CodeBuildStep  
**Compute:** SMALL  
**Timeout:** 15 minutes  
**Failure Behavior:** fail  

## Keywords

`helm`, `chart`, `oci`, `registry`

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `HELM_CHART_PATH` | `.` | Helm Chart Path |
| `HELM_REGISTRY` | `` | Helm Registry |
| `HELM_REGISTRY_TYPE` | `oci` | Helm Registry Type |
| `CHART_VERSION` | `` | Chart Version |

## Output

Primary output directory: `helm-output`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "helm-push",
  "plugin": "helm-push",
  "env": {
    "HELM_CHART_PATH": ".",
    "HELM_REGISTRY": "",
    "HELM_REGISTRY_TYPE": "oci",
    "CHART_VERSION": ""
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
