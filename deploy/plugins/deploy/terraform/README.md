# terraform

Terraform infrastructure provisioning plugin with multi-version support, linting (TFLint), and security scanning (tfsec) using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** deploy  
**Plugin Type:** CodeBuildStep  
**Compute:** MEDIUM  
**Timeout:** 45 minutes  
**Failure Behavior:** fail  

## Keywords

`infrastructure-as-code`, `terraform`, `hcl`, `provision`

## Requirements

- AWS CLI configured with appropriate permissions
- Terraform 1.10.3

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `TF_VERSION` | `1.10.3` | Terraform version to install |
| `TF_WORKING_DIR` | `.` | Directory containing Terraform files |
| `TF_ACTION` | `plan` | Terraform action: plan, apply, or destroy |
| `TF_VAR_FILE` | _none_ | Path to Terraform variables file |
| `TF_BACKEND_CONFIG` | _none_ | Path to Terraform backend configuration file |
| `TF_AUTO_APPROVE` | `false` | Auto-approve apply/destroy (true/false) |

## Output

Primary output directory: `tf-output`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "terraform",
  "plugin": "terraform",
  "env": {
    "TF_VERSION": "1.10.3",
    "TF_WORKING_DIR": ".",
    "TF_ACTION": "plan",
    "TF_VAR_FILE": "<your-tf_var_file>",
    "TF_BACKEND_CONFIG": "<your-tf_backend_config>",
    "TF_AUTO_APPROVE": "false"
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
