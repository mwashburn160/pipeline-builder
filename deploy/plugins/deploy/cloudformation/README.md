# cloudformation

AWS CloudFormation infrastructure provisioning plugin with template validation (cfn-lint), stack deployment, and change set management using AWS CDK CodeBuildStep

**Version:** 1.0.0  
**Category:** deploy  
**Plugin Type:** CodeBuildStep  
**Compute:** SMALL  
**Timeout:** 45 minutes  
**Failure Behavior:** fail  

## Keywords

`cloudformation`, `aws`, `infrastructure`, `iac`, `deploy`, `cfn-lint`, `stack`

## Requirements

- AWS CLI configured with appropriate permissions

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `CFN_TEMPLATE` | _none_ | Cfn Template |
| `CFN_STACK_NAME` | _none_ | Cfn Stack Name |
| `CFN_ACTION` | `validate` | Cfn Action |
| `CFN_PARAMETERS` | _none_ | Cfn Parameters |
| `CFN_CAPABILITIES` | `CAPABILITY_IAM,CAPABILITY_NAMED_IAM` | Cfn Capabilities |
| `CFN_REGION` | `us-east-1` | Cfn Region |

## Output

Primary output directory: `cfn-output`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "cloudformation",
  "plugin": "cloudformation",
  "env": {
    "CFN_TEMPLATE": "<your-cfn_template>",
    "CFN_STACK_NAME": "<your-cfn_stack_name>",
    "CFN_ACTION": "validate",
    "CFN_PARAMETERS": "<your-cfn_parameters>",
    "CFN_CAPABILITIES": "CAPABILITY_IAM,CAPABILITY_NAMED_IAM",
    "CFN_REGION": "us-east-1"
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
