# rubocop

RuboCop linting and formatting plugin for enforcing Ruby code style and best practices using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** quality  
**Plugin Type:** CodeBuildStep  
**Compute:** SMALL  
**Timeout:** 10 minutes  
**Failure Behavior:** fail  

## Keywords

`ruby`, `linter`, `code-style`, `formatting`

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `RUBY_VERSION` | `4.0.1` | Ruby Version |
| `RUBOCOP_CONFIG` | `.rubocop.yml` | Rubocop Config |

## Output

Primary output directory: `lint-reports`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "rubocop",
  "plugin": "rubocop",
  "env": {
    "RUBY_VERSION": "4.0.1",
    "RUBOCOP_CONFIG": ".rubocop.yml"
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
