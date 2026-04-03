# playwright

Playwright end-to-end testing plugin for cross-browser UI testing with Chromium, Firefox, and WebKit support using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** testing  
**Plugin Type:** CodeBuildStep  
**Compute:** LARGE  
**Timeout:** 30 minutes  
**Failure Behavior:** fail  

## Keywords

`e2e`, `cross-browser`, `ui-test`, `chromium`

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_VERSION` | `24` | Node Version |
| `PLAYWRIGHT_PROJECT` | `` | Playwright Project |
| `PLAYWRIGHT_WORKERS` | `auto` | Playwright Workers |
| `PLAYWRIGHT_REPORTER` | `html` | Playwright Reporter |

## Output

Primary output directory: `playwright-reports`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "playwright",
  "plugin": "playwright",
  "env": {
    "NODE_VERSION": "24",
    "PLAYWRIGHT_PROJECT": "",
    "PLAYWRIGHT_WORKERS": "auto",
    "PLAYWRIGHT_REPORTER": "html"
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
