# rails-test

Rails test runner plugin for executing Minitest and RSpec test suites with multi-database support using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** testing  
**Plugin Type:** CodeBuildStep  
**Compute:** MEDIUM  
**Timeout:** 30 minutes  
**Failure Behavior:** fail  

## Keywords

`ruby`, `rails`, `minitest`, `rspec`

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `RUBY_VERSION` | `4.0.1` | Ruby Version |
| `RAILS_ENV` | `test` | Rails Env |
| `DATABASE_ADAPTER` | `sqlite3` | Database Adapter |

## Output

Primary output directory: `test-reports`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "rails-test",
  "plugin": "rails-test",
  "env": {
    "RUBY_VERSION": "4.0.1",
    "RAILS_ENV": "test",
    "DATABASE_ADAPTER": "sqlite3"
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
