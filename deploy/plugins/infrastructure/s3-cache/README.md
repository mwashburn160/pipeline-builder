# s3-cache

Build cache restore and save plugin using S3 for faster pipeline runs with zstd compression support via AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** infrastructure  
**Plugin Type:** CodeBuildStep  
**Compute:** SMALL  
**Timeout:** 10 minutes  
**Failure Behavior:** warn  

## Keywords

`cache`, `s3`, `build-cache`, `performance`

## Requirements

- AWS CLI configured with appropriate permissions

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `CACHE_BUCKET` | _none_ | S3 bucket name for storing cache archives |
| `CACHE_KEY` | `${CODEBUILD_BUILD_ID}` | Cache key identifier |
| `CACHE_PATHS` | `node_modules,.cache` | Paths to cache (comma-separated) |
| `CACHE_ACTION` | `auto` | Cache action: `restore`, `save`, or `auto` |
| `CACHE_COMPRESSION` | `zstd` | Compression format: `zstd`, `gzip`, or `none` |

## Output

Primary output directory: `cache-output`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "s3-cache",
  "plugin": "s3-cache",
  "env": {
    "CACHE_BUCKET": "<your-cache_bucket>",
    "CACHE_KEY": "${CODEBUILD_BUILD_ID}",
    "CACHE_PATHS": "node_modules,.cache",
    "CACHE_ACTION": "auto",
    "CACHE_COMPRESSION": "zstd"
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
