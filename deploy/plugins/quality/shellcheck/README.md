# shellcheck

ShellCheck shell script linting plugin for detecting bugs, syntax issues, and portability problems in bash, sh, and zsh scripts using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** quality  
**Plugin Type:** CodeBuildStep  
**Compute:** SMALL  
**Timeout:** 10 minutes  
**Failure Behavior:** fail  

## Keywords

`bash`, `shell`, `linter`, `bug-detection`

## Requirements

- ShellCheck (pre-installed in container)

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `SHELLCHECK_VERSION` | `0.10.0` | Shellcheck Version |
| `SHELLCHECK_SEVERITY` | `warning` | Shellcheck Severity |
| `SHELLCHECK_FORMAT` | `json` | Shellcheck Format |
| `SHELLCHECK_SHELL` | `bash` | Shellcheck Shell |

## Output

Primary output directory: `shellcheck-reports`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "shellcheck",
  "plugin": "shellcheck",
  "env": {
    "SHELLCHECK_VERSION": "0.10.0",
    "SHELLCHECK_SEVERITY": "warning",
    "SHELLCHECK_FORMAT": "json",
    "SHELLCHECK_SHELL": "bash"
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
