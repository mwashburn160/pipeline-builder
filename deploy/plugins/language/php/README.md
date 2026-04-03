# php

PHP plugin for building and testing PHP applications using Composer with AWS CDK CodeBuildStep

**Version:** 1.0.0
**Category:** language
**Plugin Type:** CodeBuildStep
**Compute:** MEDIUM
**Timeout:** 15 minutes
**Failure Behavior:** fail

## Keywords

`php`, `composer`, `build`, `test`

## Requirements

- PHP 8.4

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PHP_VERSION` | `8.4` | PHP version to use (8.3 or 8.4) |
| `COMPOSER_FLAGS` | `--no-interaction --prefer-dist` | Flags passed to composer install |

## Output

Primary output directory: `**/*`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "php",
  "plugin": "php",
  "env": {
    "PHP_VERSION": "8.4",
    "COMPOSER_FLAGS": "--no-interaction --prefer-dist"
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
