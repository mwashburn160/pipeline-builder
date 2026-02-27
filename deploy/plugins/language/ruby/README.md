# ruby

Ruby plugin for building and testing Ruby applications using Bundler with AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** language  
**Plugin Type:** CodeBuildStep  
**Compute:** MEDIUM  
**Timeout:** 15 minutes  
**Failure Behavior:** fail  

## Keywords

`ruby`, `bundler`, `rake`, `rspec`, `minitest`

## Requirements

- Ruby 3.3.6

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `RUBY_VERSION` | `3.3.6` | Ruby version to use |

## Output

Primary output directory: `**/*`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "ruby",
  "plugin": "ruby",
  "env": {
    "RUBY_VERSION": "3.3.6"
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
