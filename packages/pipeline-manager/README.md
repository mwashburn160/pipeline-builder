# @pipeline-builder/pipeline-manager

📖 **[View documentation](https://mwashburn160.github.io/pipeline-builder/)**

CLI for [Pipeline Builder](https://mwashburn160.github.io/pipeline-builder/): bootstrap, synth, deploy, and manage CDK pipelines + plugins against a running platform.

## Install

```bash
npm install -g @pipeline-builder/pipeline-manager
```

Requires Node.js 24.14.0+.

## Quick start

```bash
# Authenticate against your Pipeline Builder platform
pipeline-manager login --platform https://platform.example.com

# Bootstrap a new project in the current directory
pipeline-manager bootstrap

# Synthesize the CDK app into a CloudFormation template
pipeline-manager synth

# Deploy the pipeline to AWS
pipeline-manager deploy
```

## Commands

| Command | Purpose |
| --- | --- |
| `bootstrap` | Scaffold a new pipeline project with `cdk.json` and starter config |
| `synth` | Run CDK synth to emit the CloudFormation template for the pipeline |
| `deploy` | Deploy the synthesized pipeline stack to AWS |
| `status` | Report the current deployment and execution status |
| `create-pipeline` | Register a new pipeline definition with the platform |
| `list-pipelines` / `get-pipeline` | Inspect pipelines registered to your organization |
| `list-plugins` / `get-plugin` | Browse the plugin catalog and fetch a single plugin spec |
| `upload-plugin` | Publish a custom plugin spec + Dockerfile to the platform |
| `setup-events` | Wire CodePipeline events into the platform's reporting stream |
| `login` / `store-token` | Manage the `PLATFORM_TOKEN` used to authenticate API calls |
| `version` | Print CLI version info |

Run `pipeline-manager <command> --help` for the full flag reference on any command.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `PLATFORM_TOKEN` | Yes (for API ops) | Auth token for the Pipeline Builder platform |
| `PLATFORM_URL` | Yes (for API ops) | Base URL of your platform deployment |
| `AWS_REGION` | Yes (for deploy) | Target AWS region for `synth` / `deploy` |
| `RESOLVED_SYNTH_PLUGIN` | No | `true` inside CodePipeline so the synth step resolves plugins via the platform; defaults to `false` for local CLI runs |

Full reference: [Environment Variables](https://mwashburn160.github.io/pipeline-builder/docs/environment-variables).

## Documentation

- [Getting started](https://mwashburn160.github.io/pipeline-builder/)
- [CDK usage](https://mwashburn160.github.io/pipeline-builder/docs/cdk-usage)
- [Plugin catalog (124 plugins)](https://mwashburn160.github.io/pipeline-builder/docs/plugins/)
- [API reference](https://mwashburn160.github.io/pipeline-builder/docs/api-reference)
- [AWS deployment](https://mwashburn160.github.io/pipeline-builder/docs/aws-deployment)

## License

Apache-2.0. See [LICENSE](./LICENSE).