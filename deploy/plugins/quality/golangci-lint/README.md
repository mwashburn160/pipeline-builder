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
| `GO_VERSION` | `1.24.13` | Go Version |
| `GOLANGCI_LINT_TIMEOUT` | `5m` | Golangci Lint Timeout |
| `GOLANGCI_LINT_FORMAT` | `json` | Golangci Lint Format |

## Output

Primary output directory: `lint-reports`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "golangci-lint",
  "plugin": "golangci-lint",
  "env": {
    "GO_VERSION": "1.24.13",
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
