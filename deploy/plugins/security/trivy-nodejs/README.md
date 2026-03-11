# trivy

Trivy security scanning plugin for vulnerability detection in dependencies, code, and configuration using AWS CDK with CodeBuildStep

**Version:** 1.0.0  
**Category:** security  
**Plugin Type:** CodeBuildStep  
**Compute:** MEDIUM  
**Timeout:** 30 minutes  
**Failure Behavior:** fail  

## Keywords

`trivy`, `security`, `vulnerability`, `sca`, `sast`, `iac`

## Requirements

- Node.js
- Python
- Java
- Go
- Ruby
- Rust
- .NET SDK
- C++ build tools (gcc, cmake, make)

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `TRIVY_VERSION` | `0.59.1` | Trivy Version |
| `TRIVY_SEVERITY` | `HIGH,CRITICAL` | Trivy Severity |
| `TRIVY_FORMAT` | `json` | Trivy Format |
| `LANGUAGE` | `nodejs` | Target language for scanning |
| `LANGUAGE_VERSION` | _none_ | Language runtime version |

## Output

Primary output directory: `trivy-reports`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "trivy",
  "plugin": "trivy",
  "env": {
    "TRIVY_VERSION": "0.59.1",
    "TRIVY_SEVERITY": "HIGH,CRITICAL",
    "TRIVY_FORMAT": "json",
    "LANGUAGE": "nodejs",
    "LANGUAGE_VERSION": "<your-language_version>"
  }
}
```

## Files

| File | Description |
|------|-------------|
| `manifest.yaml` | Plugin configuration and build commands |
| `Dockerfile` | Container image definition |
| `plugin.zip` | Packaged plugin archive |
| `README.md` | This documentation file |
