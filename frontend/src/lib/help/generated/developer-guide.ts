// GENERATED FROM docs/developer-guide.md — DO NOT EDIT.
// Regenerate: npm run generate:help  (see frontend/scripts/generate-help.mjs)
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
          "content": "Practical benefits and workflows for developers using Pipeline Builder."
        }
      ]
    },
    {
      "id": "overview",
      "title": "Overview",
      "blocks": [
        {
          "type": "text",
          "content": "This guide is for developers building CI/CD pipelines with Pipeline Builder. It shows what the platform replaces, the five ways to create a pipeline, and copy-paste plugin blocks for common language stacks and patterns. The key concept: every build step is a reusable, containerized plugin that runs as an isolated container inside AWS CodePipeline, so a pipeline becomes a short list of selections instead of hand-written CodeBuild, IAM, and Docker plumbing."
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
            "Choose a creation method — dashboard, AI prompt, CLI, REST API, or the CDK construct.",
            "Select plugins for each stage from the catalog (language, test, lint, security, deploy, ...).",
            "Assemble stages — copy a language or common pattern block and add steps (Docker build, Terraform, manual approval, notifications).",
            "Tune step behavior — commands, failureBehavior, timeouts, compute size, and metadata.",
            "Deploy — e.g. pipeline-manager pipeline create then pipeline deploy; each plugin runs as an isolated container in AWS CodePipeline."
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
          "content": "Java (Spring Boot)"
        },
        {
          "type": "code",
          "content": "{\n  \"stages\": [\n    {\n      \"stageName\": \"Build\",\n      \"steps\": [{\n        \"plugin\": { \"name\": \"java-corretto\" },\n        \"commands\": [\"./gradlew assemble --no-daemon\"]\n      }]\n    },\n    {\n      \"stageName\": \"Test\",\n      \"steps\": [{\n        \"plugin\": { \"name\": \"java-corretto\" },\n        \"commands\": [\"./gradlew test --no-daemon\"]\n      }]\n    },\n    {\n      \"stageName\": \"Lint\",\n      \"steps\": [\n        { \"plugin\": { \"name\": \"checkstyle\" }, \"commands\": [\"./gradlew checkstyleMain\"] },\n        { \"plugin\": { \"name\": \"spotbugs\" }, \"failureBehavior\": \"warn\", \"commands\": [\"./gradlew spotbugsMain\"] }\n      ]\n    },\n    {\n      \"stageName\": \"Security\",\n      \"steps\": [\n        { \"plugin\": { \"name\": \"snyk-java\" } },\n        { \"plugin\": { \"name\": \"trivy\" } }\n      ]\n    }\n  ]\n}",
          "language": "json"
        },
        {
          "type": "text",
          "content": "Node.js (React/Next.js)"
        },
        {
          "type": "code",
          "content": "{\n  \"stages\": [\n    {\n      \"stageName\": \"Build\",\n      \"steps\": [{\n        \"plugin\": { \"name\": \"nodejs\" },\n        \"commands\": [\"npm ci\", \"npm run build\"]\n      }]\n    },\n    {\n      \"stageName\": \"Test\",\n      \"steps\": [\n        { \"plugin\": { \"name\": \"jest\" }, \"commands\": [\"npm test -- --coverage\"] },\n        { \"plugin\": { \"name\": \"cypress\" }, \"commands\": [\"npx cypress run\"] }\n      ]\n    },\n    {\n      \"stageName\": \"Lint\",\n      \"steps\": [\n        { \"plugin\": { \"name\": \"eslint\" }, \"commands\": [\"npx eslint .\"] },\n        { \"plugin\": { \"name\": \"prettier\" }, \"commands\": [\"npx prettier --check .\"] }\n      ]\n    },\n    {\n      \"stageName\": \"Security\",\n      \"steps\": [\n        { \"plugin\": { \"name\": \"snyk-nodejs\" } },\n        { \"plugin\": { \"name\": \"trivy\" } }\n      ]\n    }\n  ]\n}",
          "language": "json"
        },
        {
          "type": "text",
          "content": "Python (Django/FastAPI)"
        },
        {
          "type": "code",
          "content": "{\n  \"stages\": [\n    {\n      \"stageName\": \"Build\",\n      \"steps\": [{\n        \"plugin\": { \"name\": \"python\" },\n        \"commands\": [\"pip install -r requirements.txt\"]\n      }]\n    },\n    {\n      \"stageName\": \"Test\",\n      \"steps\": [\n        { \"plugin\": { \"name\": \"python-pytest\" }, \"commands\": [\"pytest --cov=src tests/\"] },\n        { \"plugin\": { \"name\": \"coverage-py\" }, \"commands\": [\"coverage report --fail-under=80\"] }\n      ]\n    },\n    {\n      \"stageName\": \"Lint\",\n      \"steps\": [\n        { \"plugin\": { \"name\": \"ruff\" }, \"commands\": [\"ruff check .\"] },\n        { \"plugin\": { \"name\": \"mypy\" }, \"commands\": [\"mypy src/\"] }\n      ]\n    },\n    {\n      \"stageName\": \"Security\",\n      \"steps\": [\n        { \"plugin\": { \"name\": \"bandit\" }, \"commands\": [\"bandit -r src/\"] },\n        { \"plugin\": { \"name\": \"snyk-python\" } }\n      ]\n    }\n  ]\n}",
          "language": "json"
        },
        {
          "type": "text",
          "content": "Go (Gin/Echo)"
        },
        {
          "type": "code",
          "content": "{\n  \"stages\": [\n    {\n      \"stageName\": \"Build\",\n      \"steps\": [{\n        \"plugin\": { \"name\": \"go\" },\n        \"commands\": [\"go build ./...\"]\n      }]\n    },\n    {\n      \"stageName\": \"Test\",\n      \"steps\": [{\n        \"plugin\": { \"name\": \"go-test\" },\n        \"commands\": [\"go test -v -race -coverprofile=coverage.out ./...\"]\n      }]\n    },\n    {\n      \"stageName\": \"Lint\",\n      \"steps\": [{\n        \"plugin\": { \"name\": \"golangci-lint\" },\n        \"commands\": [\"golangci-lint run ./...\"]\n      }]\n    },\n    {\n      \"stageName\": \"Security\",\n      \"steps\": [\n        { \"plugin\": { \"name\": \"gosec\" } },\n        { \"plugin\": { \"name\": \"govulncheck\" }, \"commands\": [\"govulncheck ./...\"] }\n      ]\n    }\n  ]\n}",
          "language": "json"
        },
        {
          "type": "text",
          "content": "Rust (Axum/Actix)"
        },
        {
          "type": "code",
          "content": "{\n  \"stages\": [\n    {\n      \"stageName\": \"Build\",\n      \"steps\": [{\n        \"plugin\": { \"name\": \"rust\" },\n        \"commands\": [\"cargo build --release\"]\n      }]\n    },\n    {\n      \"stageName\": \"Test\",\n      \"steps\": [{\n        \"plugin\": { \"name\": \"cargo-test\" },\n        \"commands\": [\"cargo test --all\"]\n      }]\n    },\n    {\n      \"stageName\": \"Lint\",\n      \"steps\": [\n        { \"plugin\": { \"name\": \"clippy\" }, \"commands\": [\"cargo clippy -- -D warnings\"] },\n        { \"plugin\": { \"name\": \"rustfmt\" }, \"commands\": [\"cargo fmt --check\"] }\n      ]\n    },\n    {\n      \"stageName\": \"Security\",\n      \"steps\": [\n        { \"plugin\": { \"name\": \"cargo-audit\" }, \"commands\": [\"cargo audit\"] },\n        { \"plugin\": { \"name\": \"snyk-rust\" } }\n      ]\n    }\n  ]\n}",
          "language": "json"
        },
        {
          "type": "text",
          "content": ".NET (ASP.NET Core)"
        },
        {
          "type": "code",
          "content": "{\n  \"stages\": [\n    {\n      \"stageName\": \"Build\",\n      \"steps\": [{\n        \"plugin\": { \"name\": \"dotnet\" },\n        \"commands\": [\"dotnet build --configuration Release\"]\n      }]\n    },\n    {\n      \"stageName\": \"Test\",\n      \"steps\": [{\n        \"plugin\": { \"name\": \"dotnet-test\" },\n        \"commands\": [\"dotnet test --configuration Release --collect:\\\"XPlat Code Coverage\\\"\"]\n      }]\n    },\n    {\n      \"stageName\": \"Lint\",\n      \"steps\": [\n        { \"plugin\": { \"name\": \"dotnet-format\" }, \"commands\": [\"dotnet format --verify-no-changes\"] },\n        { \"plugin\": { \"name\": \"roslyn-analyzers\" } }\n      ]\n    },\n    {\n      \"stageName\": \"Security\",\n      \"steps\": [\n        { \"plugin\": { \"name\": \"snyk-dotnet\" } },\n        { \"plugin\": { \"name\": \"trivy\" } }\n      ]\n    }\n  ]\n}",
          "language": "json"
        },
        {
          "type": "text",
          "content": "Ruby (Rails)"
        },
        {
          "type": "code",
          "content": "{\n  \"stages\": [\n    {\n      \"stageName\": \"Build\",\n      \"steps\": [{\n        \"plugin\": { \"name\": \"ruby\" },\n        \"commands\": [\"bundle install\"]\n      }]\n    },\n    {\n      \"stageName\": \"Test\",\n      \"steps\": [\n        { \"plugin\": { \"name\": \"rails-test\" }, \"commands\": [\"bundle exec rails test\"] },\n        { \"plugin\": { \"name\": \"minitest-coverage\" } }\n      ]\n    },\n    {\n      \"stageName\": \"Lint\",\n      \"steps\": [{\n        \"plugin\": { \"name\": \"rubocop\" },\n        \"commands\": [\"bundle exec rubocop\"]\n      }]\n    },\n    {\n      \"stageName\": \"Security\",\n      \"steps\": [\n        { \"plugin\": { \"name\": \"brakeman\" }, \"commands\": [\"brakeman --no-pager\"] },\n        { \"plugin\": { \"name\": \"bundler-audit\" }, \"commands\": [\"bundle audit check --update\"] }\n      ]\n    }\n  ]\n}",
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
          "content": "{\n  \"stageName\": \"Publish\",\n  \"steps\": [{\n    \"plugin\": { \"name\": \"docker-build\" },\n    \"metadata\": {\n      \"DOCKER_REPO\": \"your-account.dkr.ecr.us-east-1.amazonaws.com/your-app\",\n      \"DOCKER_TAG\": \"latest\"\n    }\n  }]\n}",
          "language": "json"
        },
        {
          "type": "text",
          "content": "Adding Terraform Deploy"
        },
        {
          "type": "code",
          "content": "{\n  \"stageName\": \"Deploy\",\n  \"steps\": [{\n    \"plugin\": { \"name\": \"terraform\" },\n    \"commands\": [\n      \"terraform init\",\n      \"terraform plan -out=tfplan\",\n      \"terraform apply -auto-approve tfplan\"\n    ]\n  }]\n}",
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
          "content": "{\n  \"stageName\": \"Notify\",\n  \"steps\": [{\n    \"plugin\": { \"name\": \"slack-notify\" },\n    \"metadata\": {\n      \"SLACK_WEBHOOK_URL\": \"${SLACK_WEBHOOK}\",\n      \"SLACK_CHANNEL\": \"#deployments\"\n    }\n  }]\n}",
          "language": "json"
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
          "content": "{\n  \"project\": \"my-api\",\n  \"organization\": \"backend-team\",\n  \"visibility\": \"public\",\n  \"props\": {\n    \"project\": \"my-api\",\n    \"organization\": \"backend-team\",\n    \"synth\": {\n      \"source\": {\n        \"type\": \"github\",\n        \"options\": { \"repo\": \"my-org/my-api\", \"branch\": \"main\", \"trigger\": \"AUTO\" }\n      },\n      \"plugin\": { \"name\": \"cdk-synth\" }\n    },\n    \"stages\": [\n      {\n        \"stageName\": \"Build\",\n        \"steps\": [{\n          \"plugin\": { \"name\": \"java-corretto\" },\n          \"commands\": [\"./gradlew assemble --no-daemon --parallel\"],\n          \"timeout\": 30\n        }]\n      },\n      {\n        \"stageName\": \"Test\",\n        \"steps\": [{\n          \"plugin\": { \"name\": \"java-corretto\" },\n          \"commands\": [\"./gradlew test --no-daemon\"],\n          \"timeout\": 45\n        }]\n      },\n      {\n        \"stageName\": \"Security\",\n        \"steps\": [\n          { \"plugin\": { \"name\": \"semgrep\" } },\n          { \"plugin\": { \"name\": \"trivy\" } }\n        ]\n      },\n      {\n        \"stageName\": \"Approval\",\n        \"steps\": [{\n          \"plugin\": { \"name\": \"manual-approval\" },\n          \"metadata\": { \"APPROVAL_COMMENT\": \"Deploy to production?\" }\n        }]\n      },\n      {\n        \"stageName\": \"Deploy\",\n        \"steps\": [{\n          \"plugin\": { \"name\": \"cdk-deploy\" },\n          \"commands\": [\"cdk deploy --all --require-approval never\"]\n        }]\n      }\n    ]\n  }\n}",
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
          "content": "Pipeline Builder ships with 119 plugins across 10 categories. Every plugin runs as an isolated container step inside AWS CodePipeline, so build environments are reproducible and secrets never leak into image layers. See the Plugin Catalog Overview for the full index."
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
