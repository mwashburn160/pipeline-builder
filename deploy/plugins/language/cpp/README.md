# cpp

C/C++ plugin for building and testing C/C++ applications using CMake, Make, or Meson with AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** language  
**Plugin Type:** CodeBuildStep  
**Compute:** MEDIUM  
**Timeout:** 15 minutes  
**Failure Behavior:** fail  

## Keywords

`c++`, `cpp`, `c`, `cmake`, `make`, `meson`

## Requirements

- C++ build tools (gcc, cmake, make)

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `BUILD_SYSTEM` | `auto` | Build System |
| `BUILD_TYPE` | `Release` | Build Type |

## Output

Primary output directory: `**/*`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "cpp",
  "plugin": "cpp",
  "env": {
    "BUILD_SYSTEM": "auto",
    "BUILD_TYPE": "Release"
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
