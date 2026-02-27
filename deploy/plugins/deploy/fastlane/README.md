# fastlane

Fastlane mobile build and distribution plugin for Android builds and lane execution with Ruby 3.3, Android SDK, and Bundler support via AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** deploy  
**Plugin Type:** CodeBuildStep  
**Compute:** LARGE  
**Timeout:** 45 minutes  
**Failure Behavior:** fail  

## Keywords

`fastlane`, `mobile`, `android`, `ios`, `deploy`, `build`, `ruby`

## Requirements

- Java
- Ruby
- 3 optional secret(s) for additional features (see [Secrets](#secrets) below)

## Secrets

| Name | Required | Description |
|------|----------|-------------|
| `FASTLANE_SESSION` | No | Apple session cookie for iOS builds |
| `MATCH_PASSWORD` | No | Fastlane match encryption password for iOS code signing |
| `SUPPLY_JSON_KEY` | No | Google Play service account JSON for Android distribution |

### Setting Up Secrets

Secrets are injected at build time via AWS CodeBuild environment variables backed by AWS Secrets Manager.

**Step 1: Store secrets in AWS Secrets Manager**

```bash
aws secretsmanager create-secret --name "FASTLANE_SESSION" --secret-string "<your-value>"
aws secretsmanager create-secret --name "MATCH_PASSWORD" --secret-string "<your-value>"
aws secretsmanager create-secret --name "SUPPLY_JSON_KEY" --secret-string "<your-value>"
```

**Step 2: Reference secrets in your pipeline configuration**

When configuring this plugin in your pipeline, map each secret to the corresponding AWS Secrets Manager ARN:

```json
{
  "secrets": {
    "FASTLANE_SESSION": "arn:aws:secretsmanager:<region>:<account>:secret:FASTLANE_SESSION",
    "MATCH_PASSWORD": "arn:aws:secretsmanager:<region>:<account>:secret:MATCH_PASSWORD",
    "SUPPLY_JSON_KEY": "arn:aws:secretsmanager:<region>:<account>:secret:SUPPLY_JSON_KEY"
  }
}
```

**Step 3: IAM permissions**

Ensure the CodeBuild service role has `secretsmanager:GetSecretValue` permission for the referenced secrets.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `FASTLANE_LANE` | `build` | Fastlane lane to execute |
| `FASTLANE_PLATFORM` | _none_ | Fastlane Platform |
| `BUNDLE_INSTALL` | `true` | Bundle Install |
| `ANDROID_SDK_ROOT` | `/opt/android-sdk` | Android Sdk Root |

## Output

Primary output directory: `fastlane-output`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "fastlane",
  "plugin": "fastlane",
  "env": {
    "FASTLANE_LANE": "build",
    "FASTLANE_PLATFORM": "<your-fastlane_platform>",
    "BUNDLE_INSTALL": "true",
    "ANDROID_SDK_ROOT": "/opt/android-sdk"
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
