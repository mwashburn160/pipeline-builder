# eslint

ESLint JavaScript and TypeScript linting plugin for enforcing code quality and style standards using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** quality  
**Plugin Type:** CodeBuildStep  
**Compute:** SMALL  
**Timeout:** 10 minutes  
**Failure Behavior:** fail  

## Keywords

`eslint`, `lint`, `javascript`, `typescript`, `code-quality`, `style`

## Requirements

- Node.js 20

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_VERSION` | `20` | Node.js version to use |
| `ESLINT_FORMAT` | `json` | ESLint output format |
| `ESLINT_MAX_WARNINGS` | `-1` | Maximum allowed warnings before failure |

## Output

Primary output directory: `lint-reports`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "eslint",
  "plugin": "eslint",
  "env": {
    "NODE_VERSION": "20",
    "ESLINT_FORMAT": "json",
    "ESLINT_MAX_WARNINGS": "-1"
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
