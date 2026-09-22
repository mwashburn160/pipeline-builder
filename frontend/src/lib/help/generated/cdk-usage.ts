// GENERATED FROM docs/cdk-usage.md — DO NOT EDIT.
// Regenerate: npm run generate:help  (see frontend/scripts/generate-help.mjs)
// SOURCE-SHA256: 2aa8fee977a94f476f91561e88ff7a5a0df9a92d0ca9caeb57e4c0757e12b9ac
// SPDX-License-Identifier: Apache-2.0
import { Boxes } from 'lucide-react';
import type { HelpTopic } from '../types';

export const cdkUsageTopic: HelpTopic = {
  "icon": Boxes,
  "id": "cdk-usage",
  "title": "CDK Usage",
  "description": "Define pipelines as infrastructure-as-code with the PipelineBuilder CDK construct",
  "sections": [
    {
      "id": "overview",
      "title": "Overview",
      "blocks": [
        {
          "type": "text",
          "content": "Use the PipelineBuilder CDK construct to define pipelines as infrastructure-as-code. Pipelines deploy as native AWS CodePipeline + CodeBuild in your AWS account, with build steps drawn from a catalog of 119 ready-to-use plugins."
        },
        {
          "type": "code",
          "content": "npm install @pipeline-builder/pipeline-core",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "Related docs: Metadata Keys | Samples | Plugin Catalog | Environment Variables"
        }
      ]
    },
    {
      "id": "overview",
      "title": "Overview",
      "blocks": [
        {
          "type": "text",
          "content": "This guide is for developers defining pipelines as infrastructure-as-code with the PipelineBuilder CDK construct from @pipeline-builder/pipeline-core. You declare a synth source and a set of stages whose steps reference catalog plugins, and the construct synthesizes native AWS CodePipeline + CodeBuild resources deployed into your own account. The key concept: each step is a containerized plugin, and fine-grained behavior (VPC, IAM roles, secrets, cross-account, scheduling, artifacts) is layered on through typed props and metadata keys."
        }
      ]
    },
    {
      "id": "process-overview",
      "title": "Process overview",
      "blocks": [
        {
          "type": "list",
          "items": [
            "Install — npm install @pipeline-builder/pipeline-core.",
            "Instantiate PipelineBuilder in a CDK stack with project and organization.",
            "Configure the synth source — GitHub, CodeStar, S3, or CodeCommit — plus the synth plugin.",
            "Define stages, each with one or more plugin-backed steps from the catalog.",
            "Layer optional config — VPC/network, IAM roles, secrets, cross-account, schedules, artifact passing, and metadata.",
            "Synth + deploy the stack (via cdk or pipeline-manager), producing native CodePipeline + CodeBuild resources."
          ]
        }
      ]
    },
    {
      "id": "quick-start",
      "title": "Quick Start",
      "blocks": [
        {
          "type": "code",
          "content": "import { App, Stack } from 'aws-cdk-lib';\nimport { PipelineBuilder } from '@pipeline-builder/pipeline-core/cdk';\n\nconst app = new App();\nconst stack = new Stack(app, 'MyPipelineStack', {\n  env: { account: '123456789012', region: 'us-east-1' },\n});\n\nnew PipelineBuilder(stack, 'MyPipeline', {\n  project: 'my-app',\n  organization: 'my-org',\n  synth: {\n    source: { type: 'github', options: { repo: 'my-org/my-app', branch: 'main' } },\n    plugin: { name: 'cdk-synth', filter: { version: '1.0.0' } },\n  },\n  stages: [\n    {\n      stageName: 'Test',\n      steps: [{ plugin: { name: 'jest', filter: { version: '1.0.0' } } }],\n    },\n    {\n      stageName: 'Deploy',\n      steps: [{ plugin: { name: 'cdk-deploy', filter: { version: '1.0.0' } }, env: { ENVIRONMENT: 'production' } }],\n    },\n  ],\n});",
          "language": "typescript"
        },
        {
          "type": "note",
          "content": "Prerequisite for cdk synth / cdk deploy: synth bundles the PluginLookup Lambda via NodejsFunction (esbuild). Install esbuild + pnpm (the handler's lockfile) on PATH, or CDK falls back to Docker bundling and fails with Could not resolve \"axios\" / \"../config/handler-constants.js\": npm install -g esbuild@0.28.1 pnpm@10.33.0. See Pipeline Manager → local deploy prerequisites."
        }
      ]
    },
    {
      "id": "builderprops-reference",
      "title": "BuilderProps Reference",
      "blocks": [
        {
          "type": "table",
          "headers": [
            "Property",
            "Type",
            "Required",
            "Description"
          ],
          "rows": [
            [
              "project",
              "string",
              "Yes",
              "Project identifier (sanitized to lowercase alphanumeric)"
            ],
            [
              "organization",
              "string",
              "Yes",
              "Organization identifier"
            ],
            [
              "orgId",
              "string",
              "No",
              "Tenant ID for resolving per-org secrets from Secrets Manager"
            ],
            [
              "pipelineName",
              "string",
              "No",
              "Custom name. Default: {organization}-{project}-pipeline"
            ],
            [
              "synth",
              "SynthOptions",
              "Yes",
              "Synthesis step configuration (source + plugin)"
            ],
            [
              "stages",
              "StageOptions[]",
              "No",
              "Pipeline stages, each with one or more build steps"
            ],
            [
              "global",
              "MetaDataType",
              "No",
              "Metadata inherited by all steps"
            ],
            [
              "defaults",
              "CodeBuildDefaults",
              "No",
              "Pipeline-level CodeBuild defaults (VPC, env vars)"
            ],
            [
              "role",
              "RoleConfig",
              "No",
              "IAM role for the CodePipeline (omit for auto-creation)"
            ],
            [
              "schedule",
              "string",
              "No",
              "Cron/rate expression for scheduled execution"
            ],
            [
              "tags",
              "Record<string, string>",
              "No",
              "Tags applied to all pipeline resources"
            ]
          ]
        }
      ]
    },
    {
      "id": "source-types",
      "title": "Source Types",
      "blocks": [
        {
          "type": "text",
          "content": "GitHub"
        },
        {
          "type": "code",
          "content": "synth: {\n  source: {\n    type: 'github',\n    options: {\n      repo: 'my-org/my-app',       // Required: owner/repo\n      branch: 'main',               // Default: 'main'\n      trigger: TriggerType.AUTO,     // AUTO = poll for changes, NONE = manual, SCHEDULE = cron\n    },\n  },\n  plugin: { name: 'cdk-synth' },\n}",
          "language": "typescript"
        },
        {
          "type": "text",
          "content": "CodeStar Connection (GitHub, Bitbucket, GitLab)"
        },
        {
          "type": "code",
          "content": "source: {\n  type: 'codestar',\n  options: {\n    repo: 'my-org/my-app',\n    branch: 'main',\n    connectionArn: 'arn:aws:codestar-connections:us-east-1:123456789012:connection/abc-123',\n    codeBuildCloneOutput: true,   // Enable full git history in CodeBuild\n    trigger: TriggerType.AUTO,    // AUTO = push-based webhook (no polling), NONE = manual\n  },\n}",
          "language": "typescript"
        },
        {
          "type": "text",
          "content": "Creating the connection"
        },
        {
          "type": "text",
          "content": "The connectionArn above refers to an AWS CodeConnections (formerly CodeStar Connections) resource you create once per Git provider, then reuse across pipelines. A brand-new connection is created in a PENDING state and only works after you finish the handshake in the console:"
        },
        {
          "type": "list",
          "items": [
            "AWS Console → Developer Tools → Settings → Connections → Create connection (or CLI: aws codeconnections create-connection --provider-type GitHub --connection-name my-app).",
            "Pick the provider — GitHub, GitHub Enterprise Server, Bitbucket, or GitLab — name it, and click Connect.",
            "Install / authorize the AWS Connector app for your Git org when prompted (GitHub: \"Install a new app\" → choose the org → select repos), then Connect to finish. This flips the connection from Pending to Available.",
            "Copy the connection ARN (arn:aws:codeconnections:<region>:<account>:connection/<uuid>; the legacy codestar-connections ARN form also works) into connectionArn.",
            "Ensure the pipeline/deploy role can use it — allow codeconnections:UseConnection (and codestar-connections:UseConnection) on that ARN."
          ]
        },
        {
          "type": "note",
          "content": "A connection left in Pending (its app was never authorized) makes the Source stage fail with an access error. Authorizing the connector is a one-time, console-only step — it can't be completed from CDK."
        },
        {
          "type": "text",
          "content": "S3"
        },
        {
          "type": "code",
          "content": "source: {\n  type: 's3',\n  options: {\n    bucketName: 'my-source-bucket',\n    objectKey: 'source.zip',       // Default: 'source.zip'\n    trigger: TriggerType.AUTO,     // Start on S3 object-change events\n  },\n}",
          "language": "typescript"
        },
        {
          "type": "text",
          "content": "CodeCommit"
        },
        {
          "type": "code",
          "content": "source: {\n  type: 'codecommit',\n  options: {\n    repositoryName: 'my-repo',\n    branch: 'main',\n  },\n}",
          "language": "typescript"
        }
      ]
    },
    {
      "id": "stages-and-steps",
      "title": "Stages and Steps",
      "blocks": [
        {
          "type": "text",
          "content": "Each stage contains one or more steps. Each step references a plugin."
        },
        {
          "type": "code",
          "content": "stages: [\n  {\n    stageName: 'Quality',\n    steps: [\n      {\n        plugin: { name: 'eslint', filter: { version: '1.0.0' } },\n        failureBehavior: 'warn',              // Don't block pipeline on lint failures\n      },\n      {\n        plugin: { name: 'prettier', filter: { version: '1.0.0' } },\n        failureBehavior: 'warn',\n      },\n    ],\n  },\n  {\n    stageName: 'Test',\n    steps: [\n      {\n        plugin: { name: 'jest', filter: { version: '1.0.0' } },\n        timeout: 30,                           // Minutes\n        env: { NODE_ENV: 'test' },\n      },\n    ],\n  },\n  {\n    stageName: 'Deploy',\n    steps: [\n      {\n        plugin: { name: 'cdk-deploy', filter: { version: '1.0.0' } },\n        position: 'post',                     // Run after stage deployment\n        env: { ENVIRONMENT: 'production' },\n      },\n    ],\n  },\n],",
          "language": "typescript"
        },
        {
          "type": "text",
          "content": "Step Options"
        },
        {
          "type": "table",
          "headers": [
            "Property",
            "Type",
            "Description"
          ],
          "rows": [
            [
              "plugin",
              "PluginOptions",
              "Plugin to run (name, version, filter)"
            ],
            [
              "env",
              "Record<string, string>",
              "Environment variables"
            ],
            [
              "timeout",
              "number",
              "Max execution time in minutes"
            ],
            [
              "position",
              "`'pre' \\",
              "'post'`",
              "Before or after stage deployment (default: 'pre')"
            ],
            [
              "failureBehavior",
              "`'fail' \\",
              "'warn' \\",
              "'ignore'`",
              "Override plugin default"
            ],
            [
              "metadata",
              "MetaDataType",
              "Step-level metadata"
            ],
            [
              "network",
              "NetworkConfig",
              "Step-level VPC/subnet config"
            ],
            [
              "preInstallCommands",
              "string[]",
              "Run before plugin install commands"
            ],
            [
              "postInstallCommands",
              "string[]",
              "Run after plugin install commands"
            ],
            [
              "preCommands",
              "string[]",
              "Run before plugin build commands"
            ],
            [
              "postCommands",
              "string[]",
              "Run after plugin build commands"
            ],
            [
              "inputArtifact",
              "ArtifactKey",
              "Input from a previous step's output"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Plugin Options"
        },
        {
          "type": "code",
          "content": "plugin: {\n  name: 'jest',                    // Required: registered plugin name\n  alias: 'jest-unit',             // Alias for multiple uses of same plugin\n  filter: {                        // Optional lookup filter\n    version: '^1.2',               // Pin or range the version: 1.2.3, ^1, ~1.2, 1.x, latest\n  },                               // (omit it to use the plugin's default version)\n  metadata: {                      // Plugin-level metadata overrides\n    'aws:cdk:codebuild:buildenvironment:computetype': 'BUILD_GENERAL1_MEDIUM',\n  },\n}",
          "language": "typescript"
        }
      ]
    },
    {
      "id": "vpc-and-network-configuration",
      "title": "VPC and Network Configuration",
      "blocks": [
        {
          "type": "text",
          "content": "Pipeline-Level (applies to all CodeBuild actions)"
        },
        {
          "type": "code",
          "content": "new PipelineBuilder(stack, 'Pipeline', {\n  project: 'my-app',\n  organization: 'my-org',\n  defaults: {\n    network: {\n      type: 'vpcId',\n      vpcId: 'vpc-abc123',\n      subnetType: 'PRIVATE_WITH_EGRESS',\n    },\n  },\n  synth: { ... },\n  stages: [ ... ],\n});",
          "language": "typescript"
        },
        {
          "type": "text",
          "content": "Step-Level Override"
        },
        {
          "type": "code",
          "content": "stages: [{\n  stageName: 'Deploy',\n  steps: [{\n    plugin: { name: 'cdk-deploy' },\n    network: {\n      type: 'subnetIds',\n      vpcId: 'vpc-abc123',\n      subnetIds: ['subnet-111', 'subnet-222'],\n      securityGroupIds: ['sg-abc'],\n    },\n  }],\n}],",
          "language": "typescript"
        },
        {
          "type": "text",
          "content": "Network Types"
        },
        {
          "type": "table",
          "headers": [
            "Type",
            "Description"
          ],
          "rows": [
            [
              "subnetIds",
              "Explicit VPC ID + subnet IDs + optional security group IDs"
            ],
            [
              "vpcId",
              "Look up VPC by ID, select subnets by type (PRIVATE_WITH_EGRESS, PUBLIC, etc.)"
            ],
            [
              "vpcLookup",
              "Look up VPC by tags, select subnets by type"
            ]
          ]
        }
      ]
    },
    {
      "id": "iam-roles",
      "title": "IAM Roles",
      "blocks": [
        {
          "type": "text",
          "content": "Three levels of IAM role control:"
        },
        {
          "type": "text",
          "content": "Pipeline Role"
        },
        {
          "type": "text",
          "content": "The pipeline-level role uses codepipeline.amazonaws.com as trust principal."
        },
        {
          "type": "code",
          "content": "new PipelineBuilder(stack, 'Pipeline', {\n  role: {\n    type: 'roleArn',\n    roleArn: 'arn:aws:iam::123456789012:role/MyPipelineRole',\n    mutable: false,\n  },\n  // ...\n});",
          "language": "typescript"
        },
        {
          "type": "text",
          "content": "Step Project Role (CodeBuild)"
        },
        {
          "type": "text",
          "content": "Control the CodeBuild project's IAM role via metadata:"
        },
        {
          "type": "code",
          "content": "steps: [{\n  plugin: { name: 'cdk-deploy' },\n  metadata: {\n    'aws:cdk:pipelines:codebuildstep:role': JSON.stringify({\n      type: 'roleArn',\n      roleArn: 'arn:aws:iam::123456789012:role/MyCodeBuildRole',\n    }),\n  },\n}],",
          "language": "typescript"
        },
        {
          "type": "text",
          "content": "Step Action Role (CodePipeline Action)"
        },
        {
          "type": "code",
          "content": "metadata: {\n  'aws:cdk:pipelines:codebuildstep:actionrole': JSON.stringify({\n    type: 'roleArn',\n    roleArn: 'arn:aws:iam::123456789012:role/MyActionRole',\n  }),\n}",
          "language": "typescript"
        },
        {
          "type": "table",
          "headers": [
            "Level",
            "Config",
            "Trust Principal"
          ],
          "rows": [
            [
              "Pipeline",
              "BuilderProps.role",
              "codepipeline.amazonaws.com"
            ],
            [
              "Step project",
              "codebuildstep:role metadata",
              "codebuild.amazonaws.com"
            ],
            [
              "Step action",
              "codebuildstep:actionrole metadata",
              "Pipeline's role"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Role Types"
        },
        {
          "type": "table",
          "headers": [
            "Type",
            "Description"
          ],
          "rows": [
            [
              "roleArn",
              "Import existing role by ARN"
            ],
            [
              "roleName",
              "Import existing role by name"
            ],
            [
              "oidc",
              "Create new role with OIDC federated trust"
            ],
            [
              "codeBuildDefault",
              "Create new role with codebuild.amazonaws.com trust (steps only)"
            ]
          ]
        }
      ]
    },
    {
      "id": "secrets-management",
      "title": "Secrets Management",
      "blocks": [
        {
          "type": "text",
          "content": "Secrets are resolved from AWS Secrets Manager at build time using the org-scoped naming convention."
        },
        {
          "type": "code",
          "content": "new PipelineBuilder(stack, 'Pipeline', {\n  project: 'my-app',\n  organization: 'acme',\n  orgId: 'org-abc123',        // Enables per-org secret resolution\n  synth: { ... },\n  stages: [{\n    stageName: 'Security',\n    steps: [{\n      plugin: {\n        name: 'snyk-nodejs',    // Plugin declares: secrets: [{ name: 'SNYK_TOKEN', required: true }]\n        filter: { version: '1.0.0' },\n      },\n    }],\n  }],\n});",
          "language": "typescript"
        },
        {
          "type": "text",
          "content": "Resolution path: pipeline-builder/{orgId}/SNYK_TOKEN in Secrets Manager."
        },
        {
          "type": "text",
          "content": "Secrets are injected as SECRETS_MANAGER-type CodeBuild environment variables — never stored in images or logs."
        }
      ]
    },
    {
      "id": "cross-account-deployments",
      "title": "Cross-Account Deployments",
      "blocks": [
        {
          "type": "code",
          "content": "new PipelineBuilder(stack, 'Pipeline', {\n  project: 'my-app',\n  organization: 'acme',\n  global: {\n    'aws:cdk:pipelines:codepipeline:crossaccountkeys': 'true',\n  },\n  synth: {\n    source: {\n      type: 'codestar',\n      options: {\n        repo: 'acme/my-app',\n        connectionArn: 'arn:aws:codestar-connections:us-east-1:111111111111:connection/...',\n      },\n    },\n    plugin: { name: 'cdk-synth' },\n  },\n  stages: [{\n    stageName: 'Deploy-Staging',\n    steps: [{\n      plugin: { name: 'cdk-deploy' },\n      env: {\n        CDK_DEPLOY_ACCOUNT: '222222222222',\n        CDK_DEPLOY_REGION: 'us-west-2',\n      },\n    }],\n  }],\n});",
          "language": "typescript"
        }
      ]
    },
    {
      "id": "scheduled-pipelines",
      "title": "Scheduled Pipelines",
      "blocks": [
        {
          "type": "code",
          "content": "new PipelineBuilder(stack, 'Pipeline', {\n  project: 'nightly-tests',\n  organization: 'acme',\n  schedule: 'cron(0 2 * * ? *)',    // Run at 2 AM UTC daily\n  synth: { ... },\n  stages: [ ... ],\n});",
          "language": "typescript"
        },
        {
          "type": "text",
          "content": "Or use source-level schedule trigger:"
        },
        {
          "type": "code",
          "content": "source: {\n  type: 's3',\n  options: {\n    bucketName: 'my-bucket',\n    trigger: TriggerType.SCHEDULE,\n    schedule: 'rate(1 day)',\n  },\n}",
          "language": "typescript"
        }
      ]
    },
    {
      "id": "artifact-passing-between-steps",
      "title": "Artifact Passing Between Steps",
      "blocks": [
        {
          "type": "text",
          "content": "Pass output from one step as input to another:"
        },
        {
          "type": "code",
          "content": "stages: [\n  {\n    stageName: 'Build',\n    steps: [{\n      plugin: { name: 'nodejs', alias: 'build-app' },\n      // Output goes to primaryOutputDirectory (e.g., 'dist')\n    }],\n  },\n  {\n    stageName: 'Deploy',\n    steps: [{\n      plugin: { name: 'cdk-deploy' },\n      inputArtifact: {\n        stageName: 'Build',\n        stageAlias: 'Build',\n        pluginName: 'nodejs',\n        pluginAlias: 'build-app',\n        outputDirectory: 'dist',\n      },\n    }],\n  },\n],",
          "language": "typescript"
        }
      ]
    },
    {
      "id": "metadata-keys",
      "title": "Metadata Keys",
      "blocks": [
        {
          "type": "text",
          "content": "Metadata controls fine-grained CDK behavior. Set at global, defaults, or step level."
        },
        {
          "type": "text",
          "content": "Common Keys"
        },
        {
          "type": "table",
          "headers": [
            "Key",
            "Values",
            "Description"
          ],
          "rows": [
            [
              "codepipeline:selfmutation",
              "'true'/'false'",
              "Pipeline self-update on code changes"
            ],
            [
              "codepipeline:dockerenabledforsynth",
              "'true'/'false'",
              "Docker available during synth"
            ],
            [
              "codepipeline:crossaccountkeys",
              "'true'/'false'",
              "KMS keys for cross-account"
            ],
            [
              "codebuildstep:timeout",
              "'30'",
              "Step timeout in minutes"
            ],
            [
              "buildenvironment:privileged",
              "'true'/'false'",
              "Docker-in-Docker mode"
            ],
            [
              "buildenvironment:computetype",
              "'BUILD_GENERAL1_SMALL' etc.",
              "Instance size"
            ],
            [
              "network:vpcid",
              "VPC ID",
              "VPC for builds"
            ],
            [
              "network:subnetids",
              "JSON array of subnet IDs",
              "Subnet placement"
            ],
            [
              "notifications:topic:arn",
              "SNS topic ARN",
              "Pipeline event notifications"
            ]
          ]
        },
        {
          "type": "text",
          "content": "See Metadata Keys for the complete list of 80 keys."
        }
      ]
    },
    {
      "id": "cdk-examples",
      "title": "CDK Examples",
      "blocks": [
        {
          "type": "text",
          "content": "Self-contained stack classes in deploy/samples/cdk/:"
        },
        {
          "type": "table",
          "headers": [
            "Sample",
            "Pattern"
          ],
          "rows": [
            [
              "basic-pipeline-ts",
              "Simplest usage — GitHub source, 4 stages"
            ],
            [
              "vpc-isolated-pipeline-ts",
              "VPC networking with step-level overrides"
            ],
            [
              "multi-account-pipeline-ts",
              "Cross-account with CodeStar, ManualApproval"
            ],
            [
              "monorepo-pipeline-ts",
              "Monorepo with factory functions, per-service Docker"
            ],
            [
              "custom-iam-roles-ts",
              "Three levels of IAM role control"
            ],
            [
              "secrets-management-ts",
              "Secrets Manager with orgId-scoped resolution"
            ]
          ]
        }
      ]
    }
  ],
  "sourceDoc": "docs/cdk-usage.md"
};
