# golangci-lint

golangci-lint Go code quality plugin for running multiple Go linters in parallel with configurable rules using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** quality  
**Plugin Type:** CodeBuildStep  
**Compute:** MEDIUM  
**Timeout:** 15 minutes  
**Failure Behavior:** fail  

## Keywords

`go`, `linter`, `multi-linter`, `code-quality`

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `GOLANGCI_LINT_TIMEOUT` | `5m` | Golangci Lint Timeout |
| `GOLANGCI_LINT_FORMAT` | `json` | Golangci Lint Format |

## Pinned tool versions

| Tool | Version |
|------|---------|
| golangci-lint | 1.62.2 (override at build time via `--build-arg GOLANGCI_LINT_VERSION=…`) |
| Go (default) | 1.24.13 |
| Go (fallback) | 1.23.12 |

## Output

Primary output directory: `lint-reports`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "golangci-lint",
  "plugin": "golangci-lint",
  "env": {
    "GOLANGCI_LINT_TIMEOUT": "5m",
    "GOLANGCI_LINT_FORMAT": "json"
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
