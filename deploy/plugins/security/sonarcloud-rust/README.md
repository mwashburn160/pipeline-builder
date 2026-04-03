# sonarcloud-rust

SonarCloud code quality and security analysis for Rust projects using AWS CDK with CodeBuildStep

**Version:** 1.0.0  
**Category:** security  
**Plugin Type:** CodeBuildStep  
**Compute:** SMALL  
**Timeout:** 15 minutes  
**Failure Behavior:** fail  

## Keywords

`rust`, `code-quality`, `security-analysis`, `coverage`

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `SONAR_SCANNER_VERSION` | `12.0` | Sonar Scanner Version |
| `SONAR_ORGANIZATION` | `` | Sonar Organization |
| `SONAR_PROJECT_KEY` | `` | Sonar Project Key |
| `RUST_VERSION` | `stable` | Rust Version |

## Output

Primary output directory: `.scannerwork`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "sonarcloud-rust",
  "plugin": "sonarcloud-rust",
  "env": {
    "SONAR_SCANNER_VERSION": "12.0",
    "SONAR_ORGANIZATION": "",
    "SONAR_PROJECT_KEY": "",
    "RUST_VERSION": "stable"
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
