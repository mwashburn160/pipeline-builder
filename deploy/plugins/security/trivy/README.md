# trivy

Trivy vulnerability scanner for any project — dependencies (lockfiles), IaC/config, and container images (a pullable ref or a docker-save tarball); no language runtime required.

**Version:** 1.1.0  
**Category:** security  
**Plugin Type:** CodeBuildStep  
**Compute:** SMALL  
**Timeout:** 15 minutes  
**Failure Behavior:** warn  

## Keywords

`container`, `vulnerability`, `dependency-scan`, `iac`, `config-scan`, `image-scan`

## What it does

`TRIVY_SCAN_TARGETS` (comma-separated, default `fs,config`) picks the scans:

1. `fs` — `trivy fs` scans the checked-out source tree: dependency lockfiles for known vulnerabilities, at the severities in `TRIVY_SEVERITY`.
2. `config` — `trivy config` scans infrastructure-as-code and config files (Dockerfiles, Kubernetes manifests, Terraform, CloudFormation) for misconfigurations.
3. `image` — `trivy image` scans a container image: `TRIVY_IMAGE_INPUT` (a `docker save` tarball from an earlier step's artifact) if set, else `TRIVY_IMAGE` (a pullable ref), else the image a `docker-build` step recorded in `docker-output/image-name.txt`.

Findings are **report-only by default**: every report is written to `trivy-reports/` (the step's primary output directory) and the step passes. Set `TRIVY_FAIL_ON` (e.g. `CRITICAL` or `HIGH,CRITICAL`) to fail the step on findings at those severities — it is your application, so the threshold is yours. A scan that cannot run (no vulnerability DB, image unreachable) always fails the step.

With `PB_UPLOAD_SECURITY_REPORTS=true` the fs/image reports are also sent to the platform (`POST /api/pipelines/:id/security-reports`). The synth injects the org's `reporting:ingest`-scoped key for the upload (provision it once with `pipeline-manager infra store-token --scope reporting:ingest`); an upload that fails is a warning, not a failed build.

## Secrets

None.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `TRIVY_SCAN_TARGETS` | `fs,config` | Scans to run: any of `fs`, `config`, `image`. |
| `TRIVY_SEVERITY` | `HIGH,CRITICAL` | Severities written to the reports. |
| `TRIVY_FORMAT` | `json` | Report format (`json`, `table`, `sarif`, …). Only `json` and `sarif` can be uploaded. |
| `TRIVY_FAIL_ON` | _none_ | Severities that fail the step (`fs` and `image`). Empty = report-only. |
| `TRIVY_IGNORE_UNFIXED` | `false` | `true` ignores findings with no fix when applying `TRIVY_FAIL_ON`. |
| `TRIVY_IMAGE` | _none_ | Image ref for the `image` target. |
| `TRIVY_IMAGE_INPUT` | _none_ | `docker save` tarball for the `image` target (wins over `TRIVY_IMAGE`). |
| `PB_UPLOAD_SECURITY_REPORTS` | `false` | `true` uploads the reports to the platform. |

## Usage

```yaml
steps:
  - name: security-scan
    plugin: { name: trivy }
```

## Output

- `trivy-reports/trivy-fs-results.json`
- `trivy-reports/trivy-config-results.json`
- `trivy-reports/trivy-image-results.json` (with the `image` target)
