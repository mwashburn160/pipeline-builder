# Developer Guide

Practical benefits and workflows for developers using Pipeline Builder.

---

## What Pipeline Builder Replaces

Without Pipeline Builder, creating a CI/CD pipeline for an AWS project means:

```
1. Write CDK or CloudFormation templates (200-500 lines)
2. Configure CodeBuild projects with custom buildspec.yml files
3. Build and maintain Docker images for each build tool
4. Set up IAM roles with correct permissions
5. Wire up source connections (GitHub, CodeCommit)
6. Add security scanners (research, configure, test each one)
7. Handle artifact passing between stages
8. Debug "works on my machine" differences between local and CI
```

With Pipeline Builder:

```
1. Select plugins from the catalog
2. Deploy
```

---

## Five Ways to Create a Pipeline

### 1. Dashboard (Visual Builder)

Open the dashboard, select your project, pick plugins for each stage, click deploy. No code required.

### 2. AI Prompt

Paste a Git repository URL. Pipeline Builder analyzes the repo (language, framework, test tools, Dockerfiles) and generates a complete pipeline definition with appropriate plugins.

### 3. CLI

```bash
# Login
pipeline-manager login --url https://your-instance --no-verify-ssl

# Create from a JSON definition
pipeline-manager create-pipeline --file pipeline.json --no-verify-ssl

# Deploy to AWS
pipeline-manager deploy --id <pipeline-id> --no-verify-ssl --store-tokens
```

### 4. REST API

```bash
# Create pipeline
curl -X POST https://your-instance/api/pipeline \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d @pipeline.json

# List pipelines
curl https://your-instance/api/pipelines \
  -H "Authorization: Bearer $TOKEN"
```

### 5. CDK Construct (Infrastructure as Code)

```typescript
import { PipelineBuilder } from '@pipeline-builder/pipeline-core';

new PipelineBuilder(stack, 'MyPipeline', {
  project: 'my-app',
  organization: 'my-team',
  synth: {
    source: { type: 'github', options: { repo: 'org/repo', branch: 'main' } },
    plugin: { name: 'cdk-synth' },
  },
  stages: [
    { stageName: 'Test', steps: [{ plugin: { name: 'jest' } }] },
    { stageName: 'Security', steps: [{ plugin: { name: 'trivy-nodejs' } }] },
  ],
});
```

---

## Plugin Catalog — Cut and Paste

Every plugin is a reusable, containerized build step. Copy the `plugin` block into your pipeline definition.

### Java (Spring Boot)

```json
{
  "stages": [
    {
      "stageName": "Build",
      "steps": [{
        "plugin": { "name": "java-corretto" },
        "commands": ["./gradlew assemble --no-daemon"]
      }]
    },
    {
      "stageName": "Test",
      "steps": [{
        "plugin": { "name": "java-corretto" },
        "commands": ["./gradlew test --no-daemon"]
      }]
    },
    {
      "stageName": "Lint",
      "steps": [
        { "plugin": { "name": "checkstyle" }, "commands": ["./gradlew checkstyleMain"] },
        { "plugin": { "name": "spotbugs" }, "failureBehavior": "warn", "commands": ["./gradlew spotbugsMain"] }
      ]
    },
    {
      "stageName": "Security",
      "steps": [
        { "plugin": { "name": "snyk-java" } },
        { "plugin": { "name": "trivy-java" } }
      ]
    }
  ]
}
```

### Node.js (React/Next.js)

```json
{
  "stages": [
    {
      "stageName": "Build",
      "steps": [{
        "plugin": { "name": "nodejs" },
        "commands": ["npm ci", "npm run build"]
      }]
    },
    {
      "stageName": "Test",
      "steps": [
        { "plugin": { "name": "jest" }, "commands": ["npm test -- --coverage"] },
        { "plugin": { "name": "cypress" }, "commands": ["npx cypress run"] }
      ]
    },
    {
      "stageName": "Lint",
      "steps": [
        { "plugin": { "name": "eslint" }, "commands": ["npx eslint ."] },
        { "plugin": { "name": "prettier" }, "commands": ["npx prettier --check ."] }
      ]
    },
    {
      "stageName": "Security",
      "steps": [
        { "plugin": { "name": "snyk-nodejs" } },
        { "plugin": { "name": "trivy-nodejs" } }
      ]
    }
  ]
}
```

### Python (Django/FastAPI)

```json
{
  "stages": [
    {
      "stageName": "Build",
      "steps": [{
        "plugin": { "name": "python" },
        "commands": ["pip install -r requirements.txt"]
      }]
    },
    {
      "stageName": "Test",
      "steps": [
        { "plugin": { "name": "python-pytest" }, "commands": ["pytest --cov=src tests/"] },
        { "plugin": { "name": "coverage-py" }, "commands": ["coverage report --fail-under=80"] }
      ]
    },
    {
      "stageName": "Lint",
      "steps": [
        { "plugin": { "name": "ruff" }, "commands": ["ruff check ."] },
        { "plugin": { "name": "mypy" }, "commands": ["mypy src/"] }
      ]
    },
    {
      "stageName": "Security",
      "steps": [
        { "plugin": { "name": "bandit" }, "commands": ["bandit -r src/"] },
        { "plugin": { "name": "snyk-python" } }
      ]
    }
  ]
}
```

### Go (Gin/Echo)

```json
{
  "stages": [
    {
      "stageName": "Build",
      "steps": [{
        "plugin": { "name": "go" },
        "commands": ["go build ./..."]
      }]
    },
    {
      "stageName": "Test",
      "steps": [{
        "plugin": { "name": "go-test" },
        "commands": ["go test -v -race -coverprofile=coverage.out ./..."]
      }]
    },
    {
      "stageName": "Lint",
      "steps": [{
        "plugin": { "name": "golangci-lint" },
        "commands": ["golangci-lint run ./..."]
      }]
    },
    {
      "stageName": "Security",
      "steps": [
        { "plugin": { "name": "gosec" } },
        { "plugin": { "name": "govulncheck" }, "commands": ["govulncheck ./..."] }
      ]
    }
  ]
}
```

### Rust (Axum/Actix)

```json
{
  "stages": [
    {
      "stageName": "Build",
      "steps": [{
        "plugin": { "name": "rust" },
        "commands": ["cargo build --release"]
      }]
    },
    {
      "stageName": "Test",
      "steps": [{
        "plugin": { "name": "cargo-test" },
        "commands": ["cargo test --all"]
      }]
    },
    {
      "stageName": "Lint",
      "steps": [
        { "plugin": { "name": "clippy" }, "commands": ["cargo clippy -- -D warnings"] },
        { "plugin": { "name": "rustfmt" }, "commands": ["cargo fmt --check"] }
      ]
    },
    {
      "stageName": "Security",
      "steps": [
        { "plugin": { "name": "cargo-audit" }, "commands": ["cargo audit"] },
        { "plugin": { "name": "snyk-rust" } }
      ]
    }
  ]
}
```

### .NET (ASP.NET Core)

```json
{
  "stages": [
    {
      "stageName": "Build",
      "steps": [{
        "plugin": { "name": "dotnet" },
        "commands": ["dotnet build --configuration Release"]
      }]
    },
    {
      "stageName": "Test",
      "steps": [{
        "plugin": { "name": "dotnet-test" },
        "commands": ["dotnet test --configuration Release --collect:\"XPlat Code Coverage\""]
      }]
    },
    {
      "stageName": "Lint",
      "steps": [
        { "plugin": { "name": "dotnet-format" }, "commands": ["dotnet format --verify-no-changes"] },
        { "plugin": { "name": "roslyn-analyzers" } }
      ]
    },
    {
      "stageName": "Security",
      "steps": [
        { "plugin": { "name": "snyk-dotnet" } },
        { "plugin": { "name": "trivy-dotnet" } }
      ]
    }
  ]
}
```

### Ruby (Rails)

```json
{
  "stages": [
    {
      "stageName": "Build",
      "steps": [{
        "plugin": { "name": "ruby" },
        "commands": ["bundle install"]
      }]
    },
    {
      "stageName": "Test",
      "steps": [
        { "plugin": { "name": "rails-test" }, "commands": ["bundle exec rails test"] },
        { "plugin": { "name": "minitest-coverage" } }
      ]
    },
    {
      "stageName": "Lint",
      "steps": [{
        "plugin": { "name": "rubocop" },
        "commands": ["bundle exec rubocop"]
      }]
    },
    {
      "stageName": "Security",
      "steps": [
        { "plugin": { "name": "brakeman" }, "commands": ["brakeman --no-pager"] },
        { "plugin": { "name": "bundler-audit" }, "commands": ["bundle audit check --update"] }
      ]
    }
  ]
}
```

---

## Common Patterns

### Adding Docker Build + Push

Append to any pipeline's stages:

```json
{
  "stageName": "Publish",
  "steps": [{
    "plugin": { "name": "docker-build" },
    "metadata": {
      "DOCKER_REPO": "your-account.dkr.ecr.us-east-1.amazonaws.com/your-app",
      "DOCKER_TAG": "latest"
    }
  }]
}
```

### Adding Terraform Deploy

```json
{
  "stageName": "Deploy",
  "steps": [{
    "plugin": { "name": "terraform" },
    "commands": [
      "terraform init",
      "terraform plan -out=tfplan",
      "terraform apply -auto-approve tfplan"
    ]
  }]
}
```

### Adding Manual Approval Before Production

```json
{
  "stageName": "Approval",
  "steps": [{
    "plugin": { "name": "manual-approval" },
    "metadata": { "APPROVAL_COMMENT": "Approve deployment to production?" }
  }]
}
```

### Adding Slack Notifications

```json
{
  "stageName": "Notify",
  "steps": [{
    "plugin": { "name": "slack-notify" },
    "metadata": {
      "SLACK_WEBHOOK_URL": "${SLACK_WEBHOOK}",
      "SLACK_CHANNEL": "#deployments"
    }
  }]
}
```

### Failure Behavior Options

```json
// Fail the pipeline (default)
{ "plugin": { "name": "spotbugs" } }

// Log warning, continue pipeline
{ "plugin": { "name": "spotbugs" }, "failureBehavior": "warn" }

// Ignore failures silently
{ "plugin": { "name": "spotbugs" }, "failureBehavior": "ignore" }
```

### Custom Compute Size

```json
{
  "plugin": { "name": "java-corretto" },
  "metadata": {
    "aws:cdk:codebuild:buildenvironment:computetype": "LARGE"
  }
}
```

Options: `SMALL` (3GB, 2 vCPU), `MEDIUM` (7GB, 4 vCPU), `LARGE` (15GB, 8 vCPU), `X2_LARGE` (145GB, 72 vCPU)

---

## Complete Pipeline Example

A full pipeline definition for a Spring Boot application:

```json
{
  "project": "my-api",
  "organization": "backend-team",
  "accessModifier": "public",
  "props": {
    "project": "my-api",
    "organization": "backend-team",
    "synth": {
      "source": {
        "type": "github",
        "options": { "repo": "my-org/my-api", "branch": "main", "trigger": "AUTO" }
      },
      "plugin": { "name": "cdk-synth" }
    },
    "stages": [
      {
        "stageName": "Build",
        "steps": [{
          "plugin": { "name": "java-corretto" },
          "commands": ["./gradlew assemble --no-daemon --parallel"],
          "timeout": 30
        }]
      },
      {
        "stageName": "Test",
        "steps": [{
          "plugin": { "name": "java-corretto" },
          "commands": ["./gradlew test --no-daemon"],
          "timeout": 45
        }]
      },
      {
        "stageName": "Security",
        "steps": [
          { "plugin": { "name": "semgrep" } },
          { "plugin": { "name": "trivy-java" } }
        ]
      },
      {
        "stageName": "Approval",
        "steps": [{
          "plugin": { "name": "manual-approval" },
          "metadata": { "APPROVAL_COMMENT": "Deploy to production?" }
        }]
      },
      {
        "stageName": "Deploy",
        "steps": [{
          "plugin": { "name": "cdk-deploy" },
          "commands": ["cdk deploy --all --require-approval never"]
        }]
      }
    ]
  }
}
```

Save as `pipeline.json` and deploy:

```bash
pipeline-manager create-pipeline --file pipeline.json --no-verify-ssl
pipeline-manager deploy --id <returned-id> --no-verify-ssl --store-tokens
```

---

## Plugin Reference

Full plugin documentation by category:

- [Language Plugins](plugins/language.md) — Base build environments for each language
- [Security Plugins](plugins/security.md) — Vulnerability scanners and SAST/DAST tools
- [Quality Plugins](plugins/quality.md) — Linters, formatters, code analysis
- [Testing Plugins](plugins/testing.md) — Test runners, coverage, load testing
- [Artifact Plugins](plugins/artifact.md) — Docker builds, package publishing
- [Deploy Plugins](plugins/deploy.md) — Terraform, CloudFormation, Kubernetes, Helm
- [Infrastructure Plugins](plugins/infrastructure.md) — CDK synth, manual approval, S3 cache
- [Notification Plugins](plugins/notification.md) — Slack, Teams, PagerDuty, email
- [Monitoring Plugins](plugins/monitoring.md) — Datadog, New Relic, Sentry
