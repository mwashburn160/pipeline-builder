# trivy

Trivy filesystem + config vulnerability scanner for any project. Scans dependencies (lockfiles) and IaC/config statically; no language runtime required.

**Version:** 1.0.0  
**Category:** security  
**Plugin Type:** CodeBuildStep  
**Compute:** SMALL  
**Timeout:** 15 minutes  
**Failure Behavior:** warn  

## Keywords

`container`, `vulnerability`, `dependency-scan`, `iac`, `config-scan`

## What it does

1. `trivy fs` scans the checked-out source tree: dependency lockfiles for known vulnerabilities, at the severities in `TRIVY_SEVERITY`. The step exits non-zero when it finds any.
2. `trivy config` scans infrastructure-as-code and config files (Dockerfiles, Kubernetes manifests, Terraform, CloudFormation) for misconfigurations.

Both reports are written to `trivy-reports/` (the step's primary output directory).

## Secrets

None.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `TRIVY_VERSION` | `0.74.0` | Trivy build to use. Only pinned, checksum-verified builds are in the image; any other value fails with the list of available ones. |
| `TRIVY_SEVERITY` | `HIGH,CRITICAL` | Severities that are reported and fail the scan. |
| `TRIVY_FORMAT` | `json` | Report format (`json`, `table`, `sarif`, …). |

## Usage

```yaml
steps:
  - name: security-scan
    plugin: { name: trivy }
```

## Output

- `trivy-reports/trivy-fs-results.json`
- `trivy-reports/trivy-config-results.json`
