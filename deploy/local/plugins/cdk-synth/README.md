# cdk-synth Plugin

AWS CDK synthesis plugin for the pipeline platform. Produces CloudFormation templates from CDK applications using CodeBuildStep.

## Files

```
├── manifest.json   # PluginManifest (pipeline-common/pipeline/pipeline-types.ts)
├── Dockerfile      # Build environment: Node 20 + CDK + Docker CLI + AWS CLI
└── README.md
```

## Manifest → Database Mapping

The `manifest.json` maps directly to the `PluginManifest` interface and the `plugins` database table:

| manifest.json       | PluginManifest field | DB column (`plugins`)   |
|---------------------|----------------------|-------------------------|
| `name`              | `name`               | `name`                  |
| `description`       | `description`        | `description`           |
| `keywords`          | `keywords`           | `keywords` (jsonb)      |
| `version`           | `version`            | `version`               |
| `pluginType`        | `pluginType`         | `plugin_type`           |
| `computeType`       | `computeType`        | `compute_type`          |
| `metadata`          | `metadata`           | `metadata` (jsonb)      |
| `dockerfile`        | `dockerfile`         | `dockerfile`            |
| `installCommands`   | `installCommands`    | `install_commands`      |
| `commands`          | `commands`           | `commands`              |
| `env`               | `env`                | `env` (jsonb)           |
| *(auto-generated)*  | —                    | `image_tag`             |

The `image_tag` is generated at upload time when the platform builds the Docker image and pushes it to the registry.

## How It Works

1. **Upload** — `cli upload-plugin --file cdk-synth.zip --organization my-org --name cdk-synth --version 1.0.0`
2. **Platform builds** the Docker image from `Dockerfile`, pushes to the container registry, stores `image_tag`
3. **Pipeline references** the plugin in `BuilderProps`:
   ```typescript
   new Builder(stack, 'pipeline', {
     project: 'my-app',
     organization: 'my-org',
     synth: {
       source: {
         type: 'github',
         options: { repo: 'my-org/my-app', branch: 'main' }
       },
       plugin: { name: 'cdk-synth' }
     }
   });
   ```
4. **At synth time** — `PluginLookupConstruct` resolves the plugin from the DB
5. **`createCodeBuildStep`** builds a `CodeBuildStep` using the plugin's `installCommands`, `commands`, `env`, `computeType`, and `metadata`
6. **At deploy time** — CodeBuild runs inside the Docker image:
   ```
   cd ${WORKDIR}          # bootstrap from pipeline-helpers
   npm ci                 # installCommands[0]
   npm run build          # installCommands[1]
   npx cdk synth ...      # commands[0]
   ```

## Metadata Keys

The manifest configures these CodePipeline behaviors via `custom:aws:*` metadata keys:

| Key | Value | Effect |
|-----|-------|--------|
| `custom:aws:codepipeline:selfMutation` | `true` | Pipeline updates itself when CDK code changes |
| `custom:aws:codepipeline:dockerEnabledForSelfMutation` | `true` | Self-mutation step can build Docker assets |
| `custom:aws:codepipeline:publishAssetsInParallel` | `true` | Asset publishing steps run concurrently |
| `custom:aws:buildenvironment:privileged` | `true` | Enables Docker daemon in CodeBuild (required for image assets) |

These are read by `buildConfigFromMetadata()` in `pipeline-helpers.ts` and passed to the CDK `CodePipeline` and `CodeBuildStep` constructs.

## Dockerfile

The build image includes:

- **Node.js 20** — CDK runtime
- **AWS CDK CLI** — `cdk synth` / `cdk deploy`
- **TypeScript + ts-node** — Compile CDK apps
- **Docker CLI** — Build/push Docker image assets
- **AWS CLI v2** — Asset publishing, S3 operations
- **Python 3** — Required by some CDK constructs (Lambda bundling)

`privileged: true` in the CodeBuild environment allows Docker-in-Docker for building container image assets during synthesis.

## Customization

Override at the pipeline level using `metadata` in `SynthOptions` or `PluginOptions`:

```typescript
plugin: {
  name: 'cdk-synth',
  metadata: {
    WORKDIR: 'packages/infra',                          // subdir with cdk.json
    'custom:aws:codepipeline:selfMutation': false,      // disable self-mutation
  }
}
```

Or provide `env` overrides in the `SynthOptions.metadata` which get merged by `pipeline-helpers.merge()`.
