# sonarcloud-ruby

SonarCloud code quality and security analysis for Ruby projects using AWS CDK with CodeBuildStep

**Version:** 1.0.0  
**Category:** security  
**Plugin Type:** CodeBuildStep  
**Compute:** SMALL  
**Timeout:** 15 minutes  
**Failure Behavior:** fail  

## Keywords

`ruby`, `code-quality`, `security-analysis`, `coverage`

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `SONAR_SCANNER_VERSION` | `12.0` | Sonar Scanner Version |
| `SONAR_ORGANIZATION` | `` | Sonar Organization |
| `SONAR_PROJECT_KEY` | `` | Sonar Project Key |
| `RUBY_VERSION` | `4.0.1` | Ruby Version |

## Output

Primary output directory: `.scannerwork`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "sonarcloud-ruby",
  "plugin": "sonarcloud-ruby",
  "env": {
    "SONAR_SCANNER_VERSION": "12.0",
    "SONAR_ORGANIZATION": "",
    "SONAR_PROJECT_KEY": "",
    "RUBY_VERSION": "4.0.1"
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
