# spotbugs

SpotBugs static analysis plugin for detecting bug patterns in Java bytecode using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** quality  
**Plugin Type:** CodeBuildStep  
**Compute:** SMALL  
**Timeout:** 15 minutes  
**Failure Behavior:** fail  

## Keywords

`java`, `static-analysis`, `bug-detection`, `bytecode`

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `JAVA_VERSION` | `17` | Java Version |

## Output

Primary output directory: `spotbugs-reports`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "spotbugs",
  "plugin": "spotbugs",
  "env": {
    "JAVA_VERSION": "17"
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
