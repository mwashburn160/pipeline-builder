# helm-push

Helm chart packaging and push plugin for deploying charts to OCI registries using AWS CDK CodeBuildStep

**Version:** 1.1.0  
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
| `plugin-spec.yaml` | Plugin configuration and build commands |
| `Dockerfile` | Container image definition |
| `plugin.zip` | Packaged plugin archive |
| `README.md` | This documentation file |

## ChartMuseum support was removed in 1.1.0

`HELM_REGISTRY_TYPE=chartmuseum` is gone, and so is the `helm-cm-push` binary it
needed. That binary's newest release is v0.11.1 (February 2026), built against
`go1.25.0`, `grpc v1.72.2` and `x/crypto v0.46.0`; it carries nine fixable
Critical findings and there is no later version to move to, so every build of
this image failed `PLUGIN_VULN_GATE` (`PLUGIN_VULN_MAX_CRITICAL=0`).

Helm itself was never the problem — helm 4.3.0 already ships `grpc v1.83.1` and
`x/crypto v0.55.0`, ahead of the fixes the gate asked for. All nine findings came
from that one plugin binary.

OCI registries are unaffected and use helm's own `helm push`: ECR (with the
automatic `aws ecr get-login-password` step), GHCR, Harbor and ACR all speak OCI.
A pipeline that must target a ChartMuseum server needs its own plugin — this
image no longer claims to support it.

(The previous description also advertised **S3**, which this plugin has never
implemented; the only registry type it has ever handled is `oci`.)
