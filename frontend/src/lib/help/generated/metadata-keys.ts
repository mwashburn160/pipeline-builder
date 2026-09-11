// GENERATED FROM docs/metadata-keys.md — DO NOT EDIT.
// Regenerate: npm run generate:help  (see frontend/scripts/generate-help.mjs)
// SPDX-License-Identifier: Apache-2.0
import { KeyRound } from 'lucide-react';
import type { HelpTopic } from '../types';

export const metadataKeysTopic: HelpTopic = {
  "icon": KeyRound,
  "id": "metadata-keys",
  "title": "Metadata Keys",
  "description": "Strongly-typed keys for customizing CodePipeline and CodeBuild resources at synth time",
  "sections": [
    {
      "id": "overview",
      "title": "Overview",
      "blocks": [
        {
          "type": "text",
          "content": "Strongly-typed configuration keys for customizing CodePipeline and CodeBuild resources at synth time. Import from @pipeline-builder/pipeline-core."
        },
        {
          "type": "text",
          "content": "Metadata keys let you override default behavior at three levels: pipeline-wide (via global), per-stage, or per-step (via metadata on individual plugin references)."
        },
        {
          "type": "text",
          "content": "Every key is consumed by one of three mechanisms — see How keys are consumed. Each section below states which mechanism applies:"
        },
        {
          "type": "list",
          "items": [
            "Construct prop — passed straight to a CDK construct via NAMESPACE_KEY_MAP.",
            "Typed config — parsed into a discriminated-union config (network / IAM role / security group) and resolved by the builder.",
            "Custom synth — read directly in PipelineBuilder to create or configure resources (notifications, operations, encryption)."
          ]
        },
        {
          "type": "text",
          "content": "Related docs: Samples | Plugin Catalog | API Reference"
        }
      ]
    },
    {
      "id": "overview",
      "title": "Overview",
      "blocks": [
        {
          "type": "text",
          "content": "This reference catalogs the MetadataKeys constants (and their interchangeable raw string values) that customize CodePipeline and CodeBuild resources at synth time, imported from @pipeline-builder/pipeline-core. It's for authors building pipelines who need to override defaults — compute, VPC networking, IAM roles, security groups, notifications, operations, and encryption — at the pipeline, stage, or step scope. Keys are grouped by the construct they target; each group states which of the three consumption mechanisms (construct prop, typed config, or custom synth) applies. See How keys are consumed for the routing details and Scope Levels for override precedence."
        }
      ]
    },
    {
      "id": "codepipeline-configuration",
      "title": "CodePipeline Configuration",
      "blocks": [
        {
          "type": "text",
          "content": "Control pipeline-level behavior and defaults. Wiring: Construct prop — passed to CodePipelineProps via metadataForCodePipeline()."
        },
        {
          "type": "table",
          "headers": [
            "MetadataKeys constant",
            "String value"
          ],
          "rows": [
            [
              "SELF_MUTATION",
              "aws:cdk:pipelines:codepipeline:selfmutation"
            ],
            [
              "CROSS_ACCOUNT_KEYS",
              "aws:cdk:pipelines:codepipeline:crossaccountkeys"
            ],
            [
              "DOCKER_ENABLED_FOR_SELF_MUTATION",
              "aws:cdk:pipelines:codepipeline:dockerenabledforselfmutation"
            ],
            [
              "DOCKER_ENABLED_FOR_SYNTH",
              "aws:cdk:pipelines:codepipeline:dockerenabledforsynth"
            ],
            [
              "ENABLE_KEY_ROTATION",
              "aws:cdk:pipelines:codepipeline:enablekeyrotation"
            ],
            [
              "PUBLISH_ASSETS_IN_PARALLEL",
              "aws:cdk:pipelines:codepipeline:publishassetsinparallel"
            ],
            [
              "REUSE_CROSS_REGION_SUPPORT_STACKS",
              "aws:cdk:pipelines:codepipeline:reusecrossregionsupportstacks"
            ],
            [
              "USE_CHANGE_SETS",
              "aws:cdk:pipelines:codepipeline:usechangesets"
            ],
            [
              "USE_PIPELINE_ROLE_FOR_ACTIONS",
              "aws:cdk:pipelines:codepipeline:usepipelineroleforactions"
            ],
            [
              "ARTIFACT_BUCKET",
              "aws:cdk:pipelines:codepipeline:artifactbucket"
            ],
            [
              "ASSET_PUBLISHING_CODE_BUILD_DEFAULTS",
              "aws:cdk:pipelines:codepipeline:assetpublishingcodebuilddefaults"
            ],
            [
              "CDK_ASSETS_CLI_VERSION",
              "aws:cdk:pipelines:codepipeline:cdkassetscliversion"
            ],
            [
              "CLI_VERSION",
              "aws:cdk:pipelines:codepipeline:cliversion"
            ],
            [
              "CODE_BUILD_DEFAULTS",
              "aws:cdk:pipelines:codepipeline:codebuilddefaults"
            ],
            [
              "CODE_PIPELINE",
              "aws:cdk:pipelines:codepipeline:codepipeline"
            ],
            [
              "CROSS_REGION_REPLICATION_BUCKETS",
              "aws:cdk:pipelines:codepipeline:crossregionreplicationbuckets"
            ],
            [
              "DOCKER_CREDENTIALS",
              "aws:cdk:pipelines:codepipeline:dockercredentials"
            ],
            [
              "PIPELINE_NAME",
              "aws:cdk:pipelines:codepipeline:pipelinename"
            ],
            [
              "PIPELINE_TYPE",
              "aws:cdk:pipelines:codepipeline:pipelinetype"
            ],
            [
              "PIPELINE_ROLE",
              "aws:cdk:pipelines:codepipeline:role"
            ],
            [
              "SELF_MUTATION_CODE_BUILD_DEFAULTS",
              "aws:cdk:pipelines:codepipeline:selfmutationcodebuilddefaults"
            ],
            [
              "SYNTH",
              "aws:cdk:pipelines:codepipeline:synth"
            ],
            [
              "SYNTH_CODE_BUILD_DEFAULTS",
              "aws:cdk:pipelines:codepipeline:synthcodebuilddefaults"
            ]
          ]
        }
      ]
    },
    {
      "id": "codebuild-step-configuration",
      "title": "CodeBuild Step Configuration",
      "blocks": [
        {
          "type": "text",
          "content": "Customize individual build steps within a pipeline stage. Wiring: Construct prop — passed to CodeBuildStepProps via metadataForCodeBuildStep(). CACHE and TIMEOUT are the canonical caching/timeout keys (they replace the removed build.cache / build.timeout aliases)."
        },
        {
          "type": "table",
          "headers": [
            "MetadataKeys constant",
            "String value"
          ],
          "rows": [
            [
              "ACTION_ROLE",
              "aws:cdk:pipelines:codebuildstep:actionrole"
            ],
            [
              "ADDITIONAL_INPUTS",
              "aws:cdk:pipelines:codebuildstep:additionalinputs"
            ],
            [
              "BUILD_ENVIRONMENT",
              "aws:cdk:pipelines:codebuildstep:buildenvironment"
            ],
            [
              "CACHE",
              "aws:cdk:pipelines:codebuildstep:cache"
            ],
            [
              "COMMANDS",
              "aws:cdk:pipelines:codebuildstep:commands"
            ],
            [
              "CODE_BUILD_ENV",
              "aws:cdk:pipelines:codebuildstep:env"
            ],
            [
              "ENV_FROM_CFN_OUTPUTS",
              "aws:cdk:pipelines:codebuildstep:envfromcfnoutputs"
            ],
            [
              "FILE_SYSTEM_LOCATIONS",
              "aws:cdk:pipelines:codebuildstep:filesystemlocations"
            ],
            [
              "INPUT",
              "aws:cdk:pipelines:codebuildstep:input"
            ],
            [
              "INSTALL_COMMANDS",
              "aws:cdk:pipelines:codebuildstep:installcommands"
            ],
            [
              "LOGGING",
              "aws:cdk:pipelines:codebuildstep:logging"
            ],
            [
              "PARTIAL_BUILD_SPEC",
              "aws:cdk:pipelines:codebuildstep:partialbuildspec"
            ],
            [
              "PRIMARY_OUTPUT_DIRECTORY",
              "aws:cdk:pipelines:codebuildstep:primaryoutputdirectory"
            ],
            [
              "PROJECT_NAME",
              "aws:cdk:pipelines:codebuildstep:projectname"
            ],
            [
              "STEP_ROLE",
              "aws:cdk:pipelines:codebuildstep:role"
            ],
            [
              "ROLE_POLICY_STATEMENTS",
              "aws:cdk:pipelines:codebuildstep:rolepolicystatements"
            ],
            [
              "TIMEOUT",
              "aws:cdk:pipelines:codebuildstep:timeout"
            ]
          ]
        }
      ]
    },
    {
      "id": "shell-step-configuration",
      "title": "Shell Step Configuration",
      "blocks": [
        {
          "type": "text",
          "content": "Override ShellStep behavior (synth, install commands). Wiring: Construct prop — passed to ShellStepProps via metadataForShellStep()."
        },
        {
          "type": "table",
          "headers": [
            "MetadataKeys constant",
            "String value"
          ],
          "rows": [
            [
              "SHELL_COMMANDS",
              "aws:cdk:pipelines:shellstep:commands"
            ],
            [
              "SHELL_INSTALL_COMMANDS",
              "aws:cdk:pipelines:shellstep:installcommands"
            ],
            [
              "SHELL_ENV",
              "aws:cdk:pipelines:shellstep:env"
            ],
            [
              "SHELL_ENV_FROM_CFN_OUTPUTS",
              "aws:cdk:pipelines:shellstep:envfromcfnoutputs"
            ],
            [
              "SHELL_INPUT",
              "aws:cdk:pipelines:shellstep:input"
            ],
            [
              "SHELL_ADDITIONAL_INPUTS",
              "aws:cdk:pipelines:shellstep:additionalinputs"
            ],
            [
              "SHELL_PRIMARY_OUTPUT_DIRECTORY",
              "aws:cdk:pipelines:shellstep:primaryoutputdirectory"
            ]
          ]
        }
      ]
    },
    {
      "id": "build-environment",
      "title": "Build Environment",
      "blocks": [
        {
          "type": "text",
          "content": "Configure the CodeBuild build environment (compute, images, Docker). Wiring: Construct prop — passed to BuildEnvironment via metadataForBuildEnvironment()."
        },
        {
          "type": "table",
          "headers": [
            "MetadataKeys constant",
            "String value"
          ],
          "rows": [
            [
              "COMPUTE_TYPE",
              "aws:cdk:codebuild:buildenvironment:computetype"
            ],
            [
              "BUILD_IMAGE",
              "aws:cdk:codebuild:buildenvironment:buildimage"
            ],
            [
              "PRIVILEGED",
              "aws:cdk:codebuild:buildenvironment:privileged"
            ],
            [
              "CERTIFICATE",
              "aws:cdk:codebuild:buildenvironment:certificate"
            ],
            [
              "DOCKER_SERVER",
              "aws:cdk:codebuild:buildenvironment:dockerserver"
            ],
            [
              "ENVIRONMENT_VARIABLES",
              "aws:cdk:codebuild:buildenvironment:environmentvariables"
            ],
            [
              "FLEET",
              "aws:cdk:codebuild:buildenvironment:fleet"
            ]
          ]
        }
      ]
    },
    {
      "id": "network-configuration",
      "title": "Network Configuration",
      "blocks": [
        {
          "type": "text",
          "content": "Place builds inside a VPC for accessing private resources (databases, internal APIs). Wiring: Typed config — parsed by networkConfigFromMetadata() into a NetworkConfig and resolved via resolveNetwork(). Precedence: explicit prop > metadata > environment."
        },
        {
          "type": "table",
          "headers": [
            "MetadataKeys constant",
            "String value"
          ],
          "rows": [
            [
              "NETWORK_TYPE",
              "aws:cdk:ec2:network:type"
            ],
            [
              "NETWORK_VPC_ID",
              "aws:cdk:ec2:network:vpcid"
            ],
            [
              "NETWORK_VPC_NAME",
              "aws:cdk:ec2:network:vpcname"
            ],
            [
              "NETWORK_SUBNET_IDS",
              "aws:cdk:ec2:network:subnetids"
            ],
            [
              "NETWORK_SUBNET_TYPE",
              "aws:cdk:ec2:network:subnettype"
            ],
            [
              "NETWORK_SUBNET_GROUP_NAME",
              "aws:cdk:ec2:network:subnetgroupname"
            ],
            [
              "NETWORK_SECURITY_GROUP_IDS",
              "aws:cdk:ec2:network:securitygroupids"
            ],
            [
              "NETWORK_AVAILABILITY_ZONES",
              "aws:cdk:ec2:network:availabilityzones"
            ],
            [
              "NETWORK_TAGS",
              "aws:cdk:ec2:network:tags"
            ],
            [
              "NETWORK_REGION",
              "aws:cdk:ec2:network:region"
            ]
          ]
        },
        {
          "type": "note",
          "content": "Note: VPC builds require a NAT Gateway or VPC endpoints for pulling dependencies and reporting status back to CodePipeline."
        }
      ]
    },
    {
      "id": "iam-role-configuration",
      "title": "IAM Role Configuration",
      "blocks": [
        {
          "type": "text",
          "content": "Import existing IAM roles for pipeline and build steps. Wiring: Typed config — parsed by roleConfigFromMetadata() into a RoleConfig and resolved via resolveRole(). The four keys express roleArn / roleName / codeBuildDefault; the full oidc variant requires the typed BuilderProps.role prop."
        },
        {
          "type": "table",
          "headers": [
            "MetadataKeys constant",
            "String value"
          ],
          "rows": [
            [
              "ROLE_TYPE",
              "aws:cdk:iam:role:type"
            ],
            [
              "ROLE_ARN",
              "aws:cdk:iam:role:rolearn"
            ],
            [
              "ROLE_NAME",
              "aws:cdk:iam:role:rolename"
            ],
            [
              "ROLE_MUTABLE",
              "aws:cdk:iam:role:mutable"
            ]
          ]
        }
      ]
    },
    {
      "id": "security-group-configuration",
      "title": "Security Group Configuration",
      "blocks": [
        {
          "type": "text",
          "content": "Attach security groups to build containers in VPC deployments. Wiring: Typed config — parsed by securityGroupConfigFromMetadata() into a SecurityGroupConfig and resolved via resolveSecurityGroup()."
        },
        {
          "type": "table",
          "headers": [
            "MetadataKeys constant",
            "String value"
          ],
          "rows": [
            [
              "SECURITY_GROUP_TYPE",
              "aws:cdk:ec2:securitygroup:type"
            ],
            [
              "SECURITY_GROUP_IDS",
              "aws:cdk:ec2:securitygroup:securitygroupids"
            ],
            [
              "SECURITY_GROUP_NAME",
              "aws:cdk:ec2:securitygroup:securitygroupname"
            ],
            [
              "SECURITY_GROUP_VPC_ID",
              "aws:cdk:ec2:securitygroup:vpcid"
            ],
            [
              "SECURITY_GROUP_MUTABLE",
              "aws:cdk:ec2:securitygroup:mutable"
            ]
          ]
        }
      ]
    },
    {
      "id": "notification-configuration",
      "title": "Notification Configuration",
      "blocks": [
        {
          "type": "text",
          "content": "Configure pipeline event notifications via SNS. Wiring: Custom synth — when NOTIFICATION_TOPIC_ARN is set, PipelineBuilder calls pipeline.notifyOn() with the parsed NOTIFICATION_EVENTS (default FAILED,SUCCEEDED)."
        },
        {
          "type": "table",
          "headers": [
            "MetadataKeys constant",
            "String value",
            "Effect"
          ],
          "rows": [
            [
              "NOTIFICATION_TOPIC_ARN",
              "aws:cdk:notifications:topic:arn",
              "SNS topic to notify on pipeline events"
            ],
            [
              "NOTIFICATION_EVENTS",
              "aws:cdk:notifications:events",
              "Comma list: FAILED, SUCCEEDED, STARTED, CANCELED, SUPERSEDED"
            ]
          ]
        }
      ]
    },
    {
      "id": "pipeline-operations",
      "title": "Pipeline Operations",
      "blocks": [
        {
          "type": "text",
          "content": "Operational settings for execution tracking, metrics, artifact retention, and pipeline variables. Wiring: Custom synth — read directly in PipelineBuilder."
        },
        {
          "type": "table",
          "headers": [
            "MetadataKeys constant",
            "String value",
            "Effect"
          ],
          "rows": [
            [
              "ENABLE_EXECUTION_EVENTS",
              "aws:cdk:operations:executionevents",
              "Forwards pipeline execution state changes to the notification SNS topic (EventBridge rule). Requires NOTIFICATION_TOPIC_ARN."
            ],
            [
              "ENABLE_METRICS",
              "aws:cdk:operations:metrics",
              "Creates a CloudWatch alarm on FailedPipelineExecutionCount."
            ],
            [
              "ARTIFACT_RETENTION_DAYS",
              "aws:cdk:operations:artifactretentiondays",
              "Adds an S3 lifecycle expiration rule to a custom artifact bucket."
            ],
            [
              "PIPELINE_VARIABLES",
              "aws:cdk:operations:variables",
              "Declares CodePipeline V2 pipeline-level variables. JSON array ([{\"name\":\"ENV\",\"default\":\"prod\",\"description\":\"...\"}]) or compact name=default comma list."
            ]
          ]
        }
      ]
    },
    {
      "id": "encryption",
      "title": "Encryption",
      "blocks": [
        {
          "type": "text",
          "content": "Control KMS encryption for pipeline artifacts. Wiring: Custom synth — read directly in PipelineBuilder."
        },
        {
          "type": "table",
          "headers": [
            "MetadataKeys constant",
            "String value",
            "Effect"
          ],
          "rows": [
            [
              "KMS_KEY_ARN",
              "aws:cdk:encryption:kmskeyarn",
              "Attaches a customer-managed KMS key to a custom artifact bucket (BucketEncryption.KMS)."
            ]
          ]
        },
        {
          "type": "note",
          "content": "Note: ARTIFACT_RETENTION_DAYS and/or KMS_KEY_ARN cause PipelineBuilder to create a dedicated artifact bucket (enforceSSL, public access blocked, RemovalPolicy.DESTROY + autoDeleteObjects) and pass it as CodePipelineProps.artifactBucket. With neither key set, CDK auto-creates the default artifact bucket."
        }
      ]
    },
    {
      "id": "scope-levels",
      "title": "Scope Levels",
      "blocks": [
        {
          "type": "text",
          "content": "Metadata keys can be applied at different scopes. More specific scopes override broader ones."
        },
        {
          "type": "table",
          "headers": [
            "Scope",
            "Where to set",
            "Applies to"
          ],
          "rows": [
            [
              "Global",
              "BuilderProps.global",
              "All steps in the pipeline"
            ],
            [
              "Stage",
              "Stage-level metadata",
              "All steps in that stage"
            ],
            [
              "Step",
              "Step-level metadata",
              "That specific build step only"
            ]
          ]
        }
      ]
    },
    {
      "id": "how-keys-are-consumed",
      "title": "How keys are consumed",
      "blocks": [
        {
          "type": "text",
          "content": "Keys are merged (global → stage → step) into a single metadata map, then routed by one of three mechanisms:"
        },
        {
          "type": "list",
          "items": [
            "Construct prop (NAMESPACE_KEY_MAP) — keys under pipelines:codepipeline, pipelines:codebuildstep, pipelines:shellstep, and codebuild:buildenvironment are extracted by buildConfigFromMetadata() (metadata-builder.ts) and spread directly into the matching CDK construct props (metadataForCodePipeline / metadataForCodeBuildStep / metadataForShellStep / metadataForBuildEnvironment). Boolean keys are coerced from \"true\"/\"false\"."
          ]
        },
        {
          "type": "list",
          "items": [
            "Typed config extractors — ec2:network, iam:role, and ec2:securitygroup keys are parsed into discriminated-union configs by networkConfigFromMetadata(), roleConfigFromMetadata(), and securityGroupConfigFromMetadata(), then materialized by resolveNetwork() / resolveRole() / resolveSecurityGroup(). These follow prop > metadata > env precedence — an explicit BuilderProps value wins, then metadata, then environment defaults."
          ]
        },
        {
          "type": "list",
          "items": [
            "Custom synth — notifications:, operations:, and encryption:* keys are read directly in PipelineBuilder to create resources (SNS notifyOn, EventBridge rules, CloudWatch alarms, a custom KMS-encrypted artifact bucket with a retention lifecycle, and CodePipeline V2 variables)."
          ]
        }
      ]
    },
    {
      "id": "usage",
      "title": "Usage",
      "blocks": [
        {
          "type": "text",
          "content": "Both the typed constant and the raw string value are interchangeable:"
        },
        {
          "type": "code",
          "content": "import { MetadataKeys } from '@pipeline-builder/pipeline-core';\n\n// TypeScript — use the constant\nmetadata: {\n  [MetadataKeys.COMPUTE_TYPE]: 'BUILD_GENERAL1_LARGE',\n}\n\n// JSON pipelines — use the string value\n\"metadata\": {\n  \"aws:cdk:codebuild:buildenvironment:computetype\": \"BUILD_GENERAL1_LARGE\"\n}",
          "language": "typescript"
        }
      ]
    },
    {
      "id": "example",
      "title": "Example",
      "blocks": [
        {
          "type": "code",
          "content": "import { MetadataKeys } from '@pipeline-builder/pipeline-core';\nimport { PipelineBuilder } from '@pipeline-builder/pipeline-core/cdk';\nimport { Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';\n\nconst codeBuildRole = new Role(stack, 'CodeBuildRole', {\n  assumedBy: new ServicePrincipal('codebuild.amazonaws.com'),\n});\n\nnew PipelineBuilder(stack, 'Pipeline', {\n  project: 'secure-app',\n  organization: 'enterprise',\n  global: {\n    [MetadataKeys.CROSS_ACCOUNT_KEYS]: true,\n    [MetadataKeys.DOCKER_ENABLED_FOR_SYNTH]: true,\n    [MetadataKeys.SELF_MUTATION]: true,\n  },\n  synth: {\n    source: {\n      type: 'codestar',\n      options: {\n        repo: 'enterprise/secure-app',\n        branch: 'main',\n        connectionArn: 'arn:aws:codestar-connections:...',\n      },\n    },\n    plugin: { name: 'cdk-synth', version: '1.0.0' },\n    metadata: {\n      [MetadataKeys.STEP_ROLE]: codeBuildRole.roleArn,\n      [MetadataKeys.COMPUTE_TYPE]: 'BUILD_GENERAL1_LARGE',\n      [MetadataKeys.TIMEOUT]: '60',\n    },\n  },\n});",
          "language": "typescript"
        },
        {
          "type": "text",
          "content": "See the Samples page for more complete examples including VPC-isolated builds, cross-account deployments, and custom IAM role configurations."
        }
      ]
    }
  ],
  "sourceDoc": "docs/metadata-keys.md"
};
