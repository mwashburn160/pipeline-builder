# prettier

Prettier code formatting verification plugin for checking consistent formatting across JavaScript, TypeScript, CSS, HTML, JSON, YAML, and Markdown using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** quality  
**Plugin Type:** CodeBuildStep  
**Compute:** SMALL  
**Timeout:** 10 minutes  
**Failure Behavior:** fail  

## Keywords

`prettier`, `format`, `code-style`, `javascript`, `typescript`, `css`, `html`

## Requirements

- Node.js 20

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_VERSION` | `20` | Node.js version to use |
| `PRETTIER_GLOB` | `.` | Prettier Glob |

## Output

Primary output directory: `format-reports`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "prettier",
  "plugin": "prettier",
  "env": {
    "NODE_VERSION": "20",
    "PRETTIER_GLOB": "."
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
