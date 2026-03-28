# nodejs

Node.js plugin for building and testing JavaScript/TypeScript applications using npm, Yarn, or pnpm with AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** language  
**Plugin Type:** CodeBuildStep  
**Compute:** MEDIUM  
**Timeout:** 15 minutes  
**Failure Behavior:** fail  

## Keywords

`nodejs`, `javascript`, `typescript`, `npm`

## Requirements

- Node.js 24

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_VERSION` | `24` | Node.js version to use |
| `PACKAGE_MANAGER` | `auto` | Package manager (auto, npm, yarn, pnpm) |

## Output

Primary output directory: `**/*`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "nodejs",
  "plugin": "nodejs",
  "env": {
    "NODE_VERSION": "24",
    "PACKAGE_MANAGER": "auto"
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
