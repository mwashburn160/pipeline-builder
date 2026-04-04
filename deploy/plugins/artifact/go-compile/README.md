# go-compile

Go binary compile plugin for compiling static Go binaries with cross-compilation support using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** artifact  
**Plugin Type:** CodeBuildStep  
**Compute:** MEDIUM  
**Timeout:** 20 minutes  
**Failure Behavior:** fail  

## Keywords

`go`, `binary`, `cross-compilation`, `compile`

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `GO_VERSION` | `1.24.13` | Go Version |
| `CGO_ENABLED` | `0` | Cgo Enabled |
| `GOOS` | `linux` | Goos |
| `GOARCH` | `amd64` | Goarch |

## Output

Primary output directory: `bin`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "go-compile",
  "plugin": "go-compile",
  "env": {
    "GO_VERSION": "1.24.13",
    "CGO_ENABLED": "0",
    "GOOS": "linux",
    "GOARCH": "amd64"
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
