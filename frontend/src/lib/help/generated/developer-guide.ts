// GENERATED FROM docs/developer-guide.md — DO NOT EDIT.
// Regenerate: npm run generate:help  (see frontend/scripts/generate-help.mjs)
// SOURCE-SHA256: 9eff137471ca91f246024ef6b003f49b5f6ace7f545ae4f629e353b34087a393
// SPDX-License-Identifier: Apache-2.0
import { Code2 } from 'lucide-react';
import type { HelpTopic } from '../types';

export const developerGuideTopic: HelpTopic = {
  "icon": Code2,
  "id": "developer-guide",
  "title": "Developer Guide",
  "description": "Practical benefits and workflows for developers using Pipeline Builder",
  "sections": [
    {
      "id": "overview",
      "title": "Overview",
      "blocks": [
        {
          "type": "text",
          "content": "Practical workflows for developers building pipelines, with copy-paste blocks for common stacks."
        }
      ]
    },
    {
      "id": "highlights",
      "title": "Highlights",
      "blocks": [
        {
          "type": "list",
          "items": [
            "Every build step is a reusable, containerized plugin that runs as an isolated container inside AWS CodePipeline.",
            "A pipeline becomes a short list of selections instead of hand-written CodeBuild, IAM and Docker plumbing.",
            "Five ways in, one result. Dashboard, AI prompt, CLI, REST API and CDK construct all produce the same native AWS resources.",
            "Pin your plugin versions with a filter. It is what makes a pipeline reproducible.",
            "failureBehavior: warn is how you add an advisory check without blocking the build.",
            "Compute is per step. Override it for the heavy stages rather than sizing the whole pipeline up.",
            "The catalog blocks below are meant to be copied, then trimmed — every one is a working stage."
          ]
        }
      ]
    },
    {
      "id": "overview",
      "title": "Overview",
      "blocks": [
        {
          "type": "text",
          "content": "This guide is for developers building CI/CD pipelines with Pipeline Builder. It shows what the platform replaces, the five ways to create a pipeline, and copy-paste plugin blocks for common language stacks and patterns."
        },
        {
          "type": "text",
          "content": "For the rationale rather than the mechanics, see Organization Benefits; for the CDK route specifically, CDK Usage."
        }
      ]
    },
    {
      "id": "how-it-works",
      "title": "How it works",
      "blocks": [
        {
          "type": "list",
          "items": [
            "Choose a creation method — dashboard, AI prompt, CLI, REST API, or the CDK construct.",
            "Select plugins for each stage from the catalog — language, test, lint, security, deploy, and so on.",
            "Assemble stages — copy a language or common pattern block and add steps such as Docker build, Terraform, manual approval or notifications.",
            "Tune step behaviour — plugin env knobs in metadata, preCommands / postCommands, failureBehavior, timeout (minutes), and compute size.",
            "Deploy — pipeline-manager pipeline create then pipeline deploy. Each plugin runs as an isolated container in AWS CodePipeline."
          ]
        }
      ]
    },
    {
      "id": "configuration",
      "title": "Configuration",
      "blocks": [
        {
          "type": "list",
          "items": [
            "Pick your interface from Five ways to create a pipeline. The CLI is the one that works unattended.",
            "Start from a block, not a blank file. Plugin catalog — cut and paste has a working stage per language; Common patterns covers Docker, Terraform, approvals and notifications.",
            "Pin every plugin reference with a filter (version, visibility, isActive, isDefault) so the resolved version is explicit.",
            "Declare the metadata your steps need — see Metadata Keys, and Template Syntax if one spec must serve several environments.",
            "Create the secrets your plugins declare, at pipeline-builder/{orgId}/{secretName}.",
            "Deploy and check the result against Complete pipeline example."
          ]
        }
      ]
    },
    {
      "id": "what-pipeline-builder-replaces",
      "title": "What Pipeline Builder Replaces",
      "blocks": [
        {
          "type": "text",
          "content": "Without Pipeline Builder, creating a CI/CD pipeline for an AWS project means:"
        },
        {
          "type": "code",
          "content": "1. Write CDK or CloudFormation templates (200-500 lines)\n2. Configure CodeBuild projects with custom buildspec.yml files\n3. Build and maintain Docker images for each build tool\n4. Set up IAM roles with correct permissions\n5. Wire up source connections (GitHub, CodeCommit)\n6. Add security scanners (research, configure, test each one)\n7. Handle artifact passing between stages\n8. Debug \"works on my machine\" differences between local and CI"
        },
        {
          "type": "text",
          "content": "With Pipeline Builder:"
        },
        {
          "type": "code",
          "content": "1. Select plugins from the catalog\n2. Deploy"
        }
      ]
    },
    {
      "id": "five-ways-to-create-a-pipeline",
      "title": "Five Ways to Create a Pipeline",
      "blocks": [
        {
          "type": "text",
          "content": "1. Dashboard (Visual Builder)"
        },
        {
          "type": "text",
          "content": "Open the dashboard, select your project, pick plugins for each stage, click deploy. No code required."
        },
        {
          "type": "text",
          "content": "2. AI Prompt"
        },
        {
          "type": "text",
          "content": "Paste a Git repository URL. Pipeline Builder analyzes the repo (language, framework, test tools, Dockerfiles) and generates a complete pipeline definition with appropriate plugins."
        },
        {
          "type": "text",
          "content": "3. CLI"
        },
        {
          "type": "code",
          "content": "pipeline-manager auth login --url https://your-instance --no-verify-ssl\n\npipeline-manager pipeline create --file pipeline.json --no-verify-ssl\n\npipeline-manager pipeline deploy --id <pipeline-id> --no-verify-ssl --store-tokens",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "4. REST API"
        },
        {
          "type": "code",
          "content": "curl -X POST https://your-instance/api/pipelines \\\n  -H \"Authorization: Bearer $TOKEN\" \\\n  -H \"Content-Type: application/json\" \\\n  -d @pipeline.json\n\ncurl https://your-instance/api/pipelines \\\n  -H \"Authorization: Bearer $TOKEN\"",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "5. CDK Construct (Infrastructure as Code)"
        },
        {
          "type": "code",
          "content": "import { PipelineBuilder } from '@pipeline-builder/pipeline-core/cdk';\n\nnew PipelineBuilder(stack, 'MyPipeline', {\n  project: 'my-app',\n  organization: 'my-team',\n  synth: {\n    source: { type: 'github', options: { repo: 'org/repo', branch: 'main' } },\n    plugin: { name: 'cdk-synth' },\n  },\n  stages: [\n    { stageName: 'Test', steps: [{ plugin: { name: 'jest' } }] },\n    { stageName: 'Security', steps: [{ plugin: { name: 'trivy' } }] },\n  ],\n});",
          "language": "typescript"
        }
      ]
    },
    {
      "id": "plugin-catalog-cut-and-paste",
      "title": "Plugin Catalog — Cut and Paste",
      "blocks": [
        {
          "type": "text",
          "content": "Every plugin is a reusable, containerized build step. Copy the plugin block into your pipeline definition."
        },
        {
          "type": "text",
          "content": "A step runs the plugin's own commands. There is no step-level commands field — the API refuses one with a 400. To change what a step does, set one of the plugin's env knobs in the step's metadata (non-namespaced metadata keys become environment variables, e.g. GRADLE_TASK below), add preCommands / postCommands around the plugin's commands, or replace them outright with the aws:cdk:pipelines:codebuildstep:commands metadata key. Each plugin's knobs are listed in its catalog page."
        },
        {
          "type": "text",
          "content": "Java (Spring Boot)"
        },
        {
          "type": "code",
          "content": "{\n  \"stages\": [\n    {\n      \"stageName\": \"Build\",\n      \"steps\": [{\n        \"plugin\": { \"name\": \"java-corretto\" },\n        \"metadata\": { \"GRADLE_TASK\": \"assemble\" }\n      }]\n    },\n    {\n      \"stageName\": \"Test\",\n      \"steps\": [{\n        \"plugin\": { \"name\": \"java-corretto\" },\n        \"metadata\": { \"GRADLE_TASK\": \"test\" }\n      }]\n    },\n    {\n      \"stageName\": \"Lint\",\n      \"steps\": [\n        { \"plugin\": { \"name\": \"checkstyle\" } },\n        { \"plugin\": { \"name\": \"spotbugs\" }, \"failureBehavior\": \"warn\" }\n      ]\n    },\n    {\n      \"stageName\": \"Security\",\n      \"steps\": [\n        { \"plugin\": { \"name\": \"snyk-java\" } },\n        { \"plugin\": { \"name\": \"trivy\" } }\n      ]\n    }\n  ]\n}",
          "language": "json"
        },
        {
          "type": "text",
          "content": "Node.js (React/Next.js)"
        },
        {
          "type": "code",
          "content": "{\n  \"stages\": [\n    {\n      \"stageName\": \"Build\",\n      \"steps\": [{\n        \"plugin\": { \"name\": \"nodejs\" }\n      }]\n    },\n    {\n      \"stageName\": \"Test\",\n      \"steps\": [\n        { \"plugin\": { \"name\": \"jest\" } },\n        { \"plugin\": { \"name\": \"cypress\" } }\n      ]\n    },\n    {\n      \"stageName\": \"Lint\",\n      \"steps\": [\n        { \"plugin\": { \"name\": \"eslint\" } },\n        { \"plugin\": { \"name\": \"prettier\" } }\n      ]\n    },\n    {\n      \"stageName\": \"Security\",\n      \"steps\": [\n        { \"plugin\": { \"name\": \"snyk-nodejs\" } },\n        { \"plugin\": { \"name\": \"trivy\" } }\n      ]\n    }\n  ]\n}",
          "language": "json"
        },
        {
          "type": "text",
          "content": "Python (Django/FastAPI)"
        },
        {
          "type": "code",
          "content": "{\n  \"stages\": [\n    {\n      \"stageName\": \"Build\",\n      \"steps\": [{\n        \"plugin\": { \"name\": \"python\" }\n      }]\n    },\n    {\n      \"stageName\": \"Test\",\n      \"steps\": [\n        { \"plugin\": { \"name\": \"python-pytest\" } },\n        { \"plugin\": { \"name\": \"coverage-py\" } }\n      ]\n    },\n    {\n      \"stageName\": \"Lint\",\n      \"steps\": [\n        { \"plugin\": { \"name\": \"ruff\" } },\n        { \"plugin\": { \"name\": \"mypy\" } }\n      ]\n    },\n    {\n      \"stageName\": \"Security\",\n      \"steps\": [\n        { \"plugin\": { \"name\": \"bandit\" } },\n        { \"plugin\": { \"name\": \"snyk-python\" } }\n      ]\n    }\n  ]\n}",
          "language": "json"
        },
        {
          "type": "text",
          "content": "Go (Gin/Echo)"
        },
        {
          "type": "code",
          "content": "{\n  \"stages\": [\n    {\n      \"stageName\": \"Build\",\n      \"steps\": [{\n        \"plugin\": { \"name\": \"go\" }\n      }]\n    },\n    {\n      \"stageName\": \"Test\",\n      \"steps\": [{\n        \"plugin\": { \"name\": \"go-test\" }\n      }]\n    },\n    {\n      \"stageName\": \"Lint\",\n      \"steps\": [{\n        \"plugin\": { \"name\": \"golangci-lint\" }\n      }]\n    },\n    {\n      \"stageName\": \"Security\",\n      \"steps\": [\n        { \"plugin\": { \"name\": \"gosec\" } },\n        { \"plugin\": { \"name\": \"govulncheck\" } }\n      ]\n    }\n  ]\n}",
          "language": "json"
        },
        {
          "type": "text",
          "content": "Rust (Axum/Actix)"
        },
        {
          "type": "code",
          "content": "{\n  \"stages\": [\n    {\n      \"stageName\": \"Build\",\n      \"steps\": [{\n        \"plugin\": { \"name\": \"rust\" }\n      }]\n    },\n    {\n      \"stageName\": \"Test\",\n      \"steps\": [{\n        \"plugin\": { \"name\": \"cargo-test\" }\n      }]\n    },\n    {\n      \"stageName\": \"Lint\",\n      \"steps\": [\n        { \"plugin\": { \"name\": \"clippy\" } },\n        { \"plugin\": { \"name\": \"rustfmt\" } }\n      ]\n    },\n    {\n      \"stageName\": \"Security\",\n      \"steps\": [\n        { \"plugin\": { \"name\": \"cargo-audit\" } },\n        { \"plugin\": { \"name\": \"snyk-rust\" } }\n      ]\n    }\n  ]\n}",
          "language": "json"
        },
        {
          "type": "text",
          "content": ".NET (ASP.NET Core)"
        },
        {
          "type": "code",
          "content": "{\n  \"stages\": [\n    {\n      \"stageName\": \"Build\",\n      \"steps\": [{\n        \"plugin\": { \"name\": \"dotnet\" }\n      }]\n    },\n    {\n      \"stageName\": \"Test\",\n      \"steps\": [{\n        \"plugin\": { \"name\": \"dotnet-test\" }\n      }]\n    },\n    {\n      \"stageName\": \"Lint\",\n      \"steps\": [\n        { \"plugin\": { \"name\": \"dotnet-format\" } },\n        { \"plugin\": { \"name\": \"roslyn-analyzers\" } }\n      ]\n    },\n    {\n      \"stageName\": \"Security\",\n      \"steps\": [\n        { \"plugin\": { \"name\": \"snyk-dotnet\" } },\n        { \"plugin\": { \"name\": \"trivy\" } }\n      ]\n    }\n  ]\n}",
          "language": "json"
        },
        {
          "type": "text",
          "content": "Ruby (Rails)"
        },
        {
          "type": "code",
          "content": "{\n  \"stages\": [\n    {\n      \"stageName\": \"Build\",\n      \"steps\": [{\n        \"plugin\": { \"name\": \"ruby\" }\n      }]\n    },\n    {\n      \"stageName\": \"Test\",\n      \"steps\": [\n        { \"plugin\": { \"name\": \"rails-test\" } },\n        { \"plugin\": { \"name\": \"minitest-coverage\" } }\n      ]\n    },\n    {\n      \"stageName\": \"Lint\",\n      \"steps\": [{\n        \"plugin\": { \"name\": \"rubocop\" }\n      }]\n    },\n    {\n      \"stageName\": \"Security\",\n      \"steps\": [\n        { \"plugin\": { \"name\": \"brakeman\" } },\n        { \"plugin\": { \"name\": \"bundler-audit\" } }\n      ]\n    }\n  ]\n}",
          "language": "json"
        }
      ]
    },
    {
      "id": "common-patterns",
      "title": "Common Patterns",
      "blocks": [
        {
          "type": "text",
          "content": "Adding Docker Build + Push"
        },
        {
          "type": "text",
          "content": "Append to any pipeline's stages:"
        },
        {
          "type": "code",
          "content": "{\n  \"stageName\": \"Publish\",\n  \"steps\": [{\n    \"plugin\": { \"name\": \"docker-build\" },\n    \"metadata\": {\n      \"ECR_REGISTRY\": \"123456789012.dkr.ecr.us-east-1.amazonaws.com\",\n      \"IMAGE_NAME\": \"123456789012.dkr.ecr.us-east-1.amazonaws.com/your-app\",\n      \"IMAGE_TAG\": \"latest\"\n    }\n  }]\n}",
          "language": "json"
        },
        {
          "type": "text",
          "content": "Adding Terraform Deploy"
        },
        {
          "type": "code",
          "content": "{\n  \"stageName\": \"Deploy\",\n  \"steps\": [{\n    \"plugin\": { \"name\": \"terraform\" },\n    \"metadata\": { \"TF_ACTION\": \"apply\", \"TF_AUTO_APPROVE\": \"true\" }\n  }]\n}",
          "language": "json"
        },
        {
          "type": "text",
          "content": "Adding Manual Approval Before Production"
        },
        {
          "type": "code",
          "content": "{\n  \"stageName\": \"Approval\",\n  \"steps\": [{\n    \"plugin\": { \"name\": \"manual-approval\" },\n    \"metadata\": { \"APPROVAL_COMMENT\": \"Approve deployment to production?\" }\n  }]\n}",
          "language": "json"
        },
        {
          "type": "text",
          "content": "Adding Slack Notifications"
        },
        {
          "type": "code",
          "content": "{\n  \"stageName\": \"Notify\",\n  \"steps\": [{\n    \"plugin\": { \"name\": \"slack-notify\" },\n    \"metadata\": { \"SLACK_CHANNEL\": \"#deployments\" }\n  }]\n}",
          "language": "json"
        },
        {
          "type": "text",
          "content": "The webhook URL is the plugin's required SLACK_WEBHOOK_URL secret — create it at pipeline-builder/{orgId}/SLACK_WEBHOOK_URL rather than putting it in the definition."
        },
        {
          "type": "text",
          "content": "Failure Behavior Options"
        },
        {
          "type": "code",
          "content": "// Fail the pipeline (default)\n{ \"plugin\": { \"name\": \"spotbugs\" } }\n\n// Log warning, continue pipeline\n{ \"plugin\": { \"name\": \"spotbugs\" }, \"failureBehavior\": \"warn\" }\n\n// Ignore failures silently\n{ \"plugin\": { \"name\": \"spotbugs\" }, \"failureBehavior\": \"ignore\" }",
          "language": "json"
        },
        {
          "type": "text",
          "content": "Custom Compute Size"
        },
        {
          "type": "code",
          "content": "{\n  \"plugin\": { \"name\": \"java-corretto\" },\n  \"metadata\": {\n    \"aws:cdk:codebuild:buildenvironment:computetype\": \"LARGE\"\n  }\n}",
          "language": "json"
        },
        {
          "type": "text",
          "content": "Options: SMALL (3GB, 2 vCPU), MEDIUM (7GB, 4 vCPU), LARGE (15GB, 8 vCPU), X2_LARGE (145GB, 72 vCPU)"
        }
      ]
    },
    {
      "id": "complete-pipeline-example",
      "title": "Complete Pipeline Example",
      "blocks": [
        {
          "type": "text",
          "content": "A full pipeline definition for a Spring Boot application:"
        },
        {
          "type": "code",
          "content": "{\n  \"project\": \"my-api\",\n  \"organization\": \"backend-team\",\n  \"visibility\": \"public\",\n  \"props\": {\n    \"project\": \"my-api\",\n    \"organization\": \"backend-team\",\n    \"synth\": {\n      \"source\": {\n        \"type\": \"github\",\n        \"options\": { \"repo\": \"my-org/my-api\", \"branch\": \"main\", \"trigger\": \"AUTO\" }\n      },\n      \"plugin\": { \"name\": \"cdk-synth\" }\n    },\n    \"stages\": [\n      {\n        \"stageName\": \"Build\",\n        \"steps\": [{\n          \"plugin\": { \"name\": \"java-corretto\" },\n          \"metadata\": { \"GRADLE_TASK\": \"assemble\" },\n          \"timeout\": 30\n        }]\n      },\n      {\n        \"stageName\": \"Test\",\n        \"steps\": [{\n          \"plugin\": { \"name\": \"java-corretto\" },\n          \"metadata\": { \"GRADLE_TASK\": \"test\" },\n          \"timeout\": 45\n        }]\n      },\n      {\n        \"stageName\": \"Security\",\n        \"steps\": [\n          { \"plugin\": { \"name\": \"semgrep\" } },\n          { \"plugin\": { \"name\": \"trivy\" } }\n        ]\n      },\n      {\n        \"stageName\": \"Approval\",\n        \"steps\": [{\n          \"plugin\": { \"name\": \"manual-approval\" },\n          \"metadata\": { \"APPROVAL_COMMENT\": \"Deploy to production?\" }\n        }]\n      },\n      {\n        \"stageName\": \"Deploy\",\n        \"steps\": [{\n          \"plugin\": { \"name\": \"cdk-deploy\" }\n        }]\n      }\n    ]\n  }\n}",
          "language": "json"
        },
        {
          "type": "text",
          "content": "Save as pipeline.json and deploy:"
        },
        {
          "type": "code",
          "content": "pipeline-manager pipeline create --file pipeline.json --no-verify-ssl\npipeline-manager pipeline deploy --id <returned-id> --no-verify-ssl --store-tokens",
          "language": "bash"
        }
      ]
    },
    {
      "id": "plugin-reference",
      "title": "Plugin Reference",
      "blocks": [
        {
          "type": "text",
          "content": "Pipeline Builder ships with 118 plugins across 10 categories. Every plugin runs as an isolated container step inside AWS CodePipeline, so build environments are reproducible and secrets never leak into image layers. See the Plugin Catalog Overview for the full index."
        },
        {
          "type": "text",
          "content": "Full plugin documentation by category:"
        },
        {
          "type": "list",
          "items": [
            "Language Plugins — Base build environments for each language",
            "Security Plugins — Vulnerability scanners and SAST/DAST tools",
            "Quality Plugins — Linters, formatters, code analysis",
            "Testing Plugins — Test runners, coverage, load testing",
            "Artifact Plugins — Docker builds, package publishing",
            "Deploy Plugins — Terraform, CloudFormation, Kubernetes, Helm",
            "Infrastructure Plugins — CDK synth, manual approval (built-in and custom), S3 cache, shell",
            "Notification Plugins — Slack, Teams, PagerDuty, email",
            "Monitoring Plugins — Datadog, New Relic, Sentry",
            "AI Plugins — AI-powered Dockerfile generation (Anthropic, OpenAI, Google, xAI, Bedrock)"
          ]
        }
      ]
    }
  ],
  "sourceDoc": "docs/developer-guide.md"
};
