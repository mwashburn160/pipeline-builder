# npm-audit

npm and yarn dependency audit plugin for detecting known vulnerabilities in JavaScript project dependencies using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** security  
**Plugin Type:** CodeBuildStep  
**Compute:** SMALL  
**Timeout:** 10 minutes  
**Failure Behavior:** fail  

## Keywords

`nodejs`, `npm`, `dependency-scan`, `cve`

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_VERSION` | `24` | Node Version |
| `AUDIT_LEVEL` | `high` | Audit Level |

## Output

Primary output directory: `audit-reports`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "npm-audit",
  "plugin": "npm-audit",
  "env": {
    "NODE_VERSION": "24",
    "AUDIT_LEVEL": "high"
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
