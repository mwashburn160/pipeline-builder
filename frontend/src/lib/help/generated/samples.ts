// GENERATED FROM docs/samples.md — DO NOT EDIT.
// Regenerate: npm run generate:help  (see frontend/scripts/generate-help.mjs)
// SOURCE-SHA256: 8898b94d175941e1b33be0ab5b9127657afecd8cf2b10b439fc6b32895cc157b
// SPDX-License-Identifier: Apache-2.0
import { FolderGit2 } from 'lucide-react';
import type { HelpTopic } from '../types';

export const samplesTopic: HelpTopic = {
  "icon": FolderGit2,
  "id": "samples",
  "title": "Samples",
  "description": "Ready-to-use pipeline configurations and CDK examples",
  "sections": [
    {
      "id": "overview",
      "title": "Overview",
      "blocks": [
        {
          "type": "text",
          "content": "Ready-to-use pipeline templates and CDK examples that demonstrate Pipeline Builder's capabilities. Use these as starting points for your own pipelines or as reference implementations for advanced patterns."
        },
        {
          "type": "text",
          "content": "All sample files are located in deploy/samples/."
        },
        {
          "type": "text",
          "content": "Related docs: Plugin Catalog | Metadata Keys | API Reference"
        }
      ]
    },
    {
      "id": "overview",
      "title": "Overview",
      "blocks": [
        {
          "type": "text",
          "content": "This catalog indexes the ready-to-use pipeline templates and CDK examples shipped in deploy/samples/. It covers seven language-specific golden-path templates (React, Spring Boot, Django, Gin, Axum, Rails, ASP.NET Core), six PipelineBuilder CDK stack examples — VPC isolation, multi-account, monorepo, custom IAM roles, and secrets management — and three CI/CD platform configs (GitHub Actions, GitLab CI/CD, CircleCI) that instantiate a template and deploy the resulting pipeline in one run, plus how to load the templates into a running instance. Use them as starting points for your own pipelines or as reference implementations for advanced patterns."
        }
      ]
    },
    {
      "id": "pipeline-template-samples",
      "title": "Pipeline Template Samples",
      "blocks": [
        {
          "type": "text",
          "content": "Language-specific golden-path pipeline templates built on small, real hello-world repos. A template is a parameterized starting point, not a pipeline: you instantiate it with declared inputs to get concrete pipeline props, then create the pipeline from those. Each sample is intentionally minimal — a build and/or security-scan stage — that you extend with tests, linting, and container packaging (see each sample's README)."
        },
        {
          "type": "text",
          "content": "Location: deploy/samples/templates/"
        },
        {
          "type": "table",
          "headers": [
            "Template",
            "Language",
            "Source Repo",
            "Stages"
          ],
          "rows": [
            [
              "react-javascript",
              "JS/TS",
              "sitek94/vite-deploy-demo",
              "Build, Security"
            ],
            [
              "spring-boot-java",
              "Java",
              "dstar55/docker-hello-world-spring-boot",
              "Build"
            ],
            [
              "django-python",
              "Python",
              "django-ve/django-helloworld",
              "Security"
            ],
            [
              "gin-golang",
              "Go",
              "lamhotsimamora/Hello-World-Golang-Gin",
              "Build, Security"
            ],
            [
              "axum-rust",
              "Rust",
              "ChiefTechDev/Rust-Axum-Hello-World",
              "Build, Security"
            ],
            [
              "rails-ruby",
              "Ruby",
              "m9rc1n/hello-world-rails",
              "Security"
            ],
            [
              "aspnetcore-dotnet",
              "C#/.NET",
              "Azure-Samples/dotnetcore-docs-hello-world",
              "Build, Security"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Anatomy of a template.json"
        },
        {
          "type": "table",
          "headers": [
            "Field",
            "Meaning"
          ],
          "rows": [
            [
              "name",
              "Unique per org — the handle you look the template up by"
            ],
            [
              "description, keywords, category",
              "Catalog metadata for search and grouping"
            ],
            [
              "visibility",
              "private \\",
              "org \\",
              "public. The loader forces public so the seeded catalog is readable from every org"
            ],
            [
              "inputs[]",
              "Declared parameters; each becomes a vars.<name> key on the generated pipeline"
            ],
            [
              "props",
              "The pipeline body (BuilderProps) with {{ pipeline.vars.* }} placeholders"
            ]
          ]
        },
        {
          "type": "text",
          "content": "props deliberately omits project, organization, and vars — instantiation supplies all three from the request, so there is nothing to hand-edit."
        },
        {
          "type": "text",
          "content": "Prerequisite: GitHub source token"
        },
        {
          "type": "text",
          "content": "All seven templates use a GitHub (v1/OAuth) source, which CodePipeline authenticates with an OAuth token in AWS Secrets Manager — even for public repos. If the token secret is missing, the deploy fails at pipeline-creation time with Secrets Manager can't find the specified secret. (ResourceNotFoundException)."
        },
        {
          "type": "text",
          "content": "Each template resolves the secret per org via synth-time templating: its declared orgId input feeds the source token (secretsmanager:pipeline-builder/{{ pipeline.vars.orgId }}/github-token), following the naming standard pipeline-builder/{orgId}/{name}. orgId is each sample's one declared input, because the source token is the only source field that is synth-templatable — repo/branch stay literal, so fork a template and edit props.synth.source.options to point at your own repository. To use a template:"
        },
        {
          "type": "list",
          "items": [
            "Pass your org's ID (the UUID) as the orgId input when you instantiate.",
            "Create the matching secret once per account/region:"
          ]
        },
        {
          "type": "code",
          "content": "aws secretsmanager create-secret \\\n  --name \"pipeline-builder/<orgId>/github-token\" \\\n  --secret-string \"ghp_YOUR_TOKEN_HERE\" \\\n  --region <your-region>",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "Use a PAT with repo + admin:repo_hook scopes (public repos: public_repo + admin:repo_hook). <orgId> must match the orgId input you pass. Simpler: drop the token line from props.synth.source.options and create a bare github-token secret (CDK's default lookup). Recommended: a CodeStar/CodeConnections source avoids the token entirely."
        },
        {
          "type": "text",
          "content": "Instantiating a template"
        },
        {
          "type": "text",
          "content": "Instantiation only renders — it creates nothing. The returned props go through the normal create path, so compliance and quota still apply."
        },
        {
          "type": "code",
          "content": "pipeline-manager template instantiate \\\n  --name react-javascript \\\n  --project react --organization AcmeCorp \\\n  --input orgId=<your-org-id> \\\n  --output pipeline-props.json\n\npipeline-manager pipeline create --file pipeline-props.json --deploy --region us-east-1",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "--name resolves against the catalog you can see and refuses to guess when the name is missing or matches more than one visible template; pass --id to pick one explicitly. Repeat --input k=v per declared input (or pass a JSON --inputs-file, which --input flags override). Without --output the props go to stdout; --json suppresses all decorative output so the stream pipes cleanly into jq. Full flag reference: pipeline-manager template instantiate --help."
        },
        {
          "type": "text",
          "content": "Or pick the template from the dashboard's golden-path catalog and fill in the inputs there."
        },
        {
          "type": "text",
          "content": "Patterns"
        },
        {
          "type": "list",
          "items": [
            "Plugin filters — every plugin reference includes a filter (version, visibility, isActive, isDefault) so the resolved plugin version is explicit and reproducible",
            "Failure behavior — advisory checks (e.g. dependency audits) use failureBehavior: \"warn\" so they report findings without failing the build",
            "Step positioning — primary steps use \"pre\", supplementary steps use \"post\"",
            "Compute sizing — heavier steps override the default compute to MEDIUM or LARGE via the aws:cdk:codebuild:buildenvironment:computetype metadata key"
          ]
        }
      ]
    },
    {
      "id": "cdk-typescript-examples",
      "title": "CDK TypeScript Examples",
      "blocks": [
        {
          "type": "text",
          "content": "Self-contained stack classes showing PipelineBuilder usage."
        },
        {
          "type": "text",
          "content": "Location: deploy/samples/cdk/"
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
              "Simplest usage — GitHub source, plugin filters, 4 stages"
            ],
            [
              "vpc-isolated-pipeline-ts",
              "VPC networking with NetworkConfig and step-level overrides"
            ],
            [
              "multi-account-pipeline-ts",
              "Cross-account with RoleConfig, CodeStar source, ManualApproval"
            ],
            [
              "monorepo-pipeline-ts",
              "Monorepo with factory functions, pnpm workspace, per-service Docker"
            ],
            [
              "custom-iam-roles-ts",
              "Three levels of IAM role control (pipeline, step project, step action)"
            ],
            [
              "secrets-management-ts",
              "Secrets Manager integration with orgId-scoped resolution"
            ]
          ]
        },
        {
          "type": "text",
          "content": "IAM Role Levels"
        },
        {
          "type": "text",
          "content": "From custom-iam-roles-ts:"
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
              "aws:cdk:pipelines:codebuildstep:role metadata",
              "codebuild.amazonaws.com"
            ],
            [
              "Step action",
              "aws:cdk:pipelines:codebuildstep:actionrole metadata",
              "—"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Secrets Flow"
        },
        {
          "type": "text",
          "content": "From secrets-management-ts:"
        },
        {
          "type": "list",
          "items": [
            "Set orgId on BuilderProps",
            "Plugins declare secrets: [{ name: 'SECRET_NAME', required: true }]",
            "At deploy, resolves from pipeline-builder/{orgId}/{secretName} in Secrets Manager",
            "Injected as SECRETS_MANAGER-type CodeBuild env vars automatically"
          ]
        }
      ]
    },
    {
      "id": "ci-cd-samples",
      "title": "CI/CD Samples",
      "blocks": [
        {
          "type": "text",
          "content": "Ready-to-copy configurations for the major CI/CD platforms that instantiate a pipeline template, then create and deploy the resulting pipeline with pipeline-manager pipeline create --deploy. --deploy creates the pipeline record on the platform, then runs cdk deploy for it and registers the deployed stack (by name + region — never the ARN, which embeds the AWS account id) — so a green CI run means the pipeline both exists on the platform and is deployed to AWS."
        },
        {
          "type": "text",
          "content": "Location: deploy/samples/ci/"
        },
        {
          "type": "table",
          "headers": [
            "Sample",
            "Platform",
            "Copy to",
            "AWS auth",
            "Highlight"
          ],
          "rows": [
            [
              "github-actions",
              "GitHub Actions",
              ".github/workflows/deploy-pipeline.yml",
              "OIDC role assumption",
              "workflow_dispatch with template_name / project / organization inputs"
            ],
            [
              "gitlab",
              "GitLab CI/CD",
              ".gitlab-ci.yml",
              "OIDC ID token → STS",
              "id_tokens + assume-role-with-web-identity"
            ],
            [
              "circleci",
              "CircleCI",
              ".circleci/config.yml",
              "OIDC token → STS",
              "Context-scoped secrets, $CIRCLE_OIDC_TOKEN"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Each sample instantiates the react-javascript template by default — set TEMPLATE_NAME (plus PB_PROJECT / PB_ORGANIZATION) to any other template in your catalog. Instantiation reads the platform's live catalog, so the template must already be loaded there. All three are idempotent: re-running with the same config upserts the record (keyed on project + organization + orgId), updates the CloudFormation stack, and refreshes the registry row — no duplicates, no errors."
        },
        {
          "type": "text",
          "content": "Shared requirements"
        },
        {
          "type": "list",
          "items": [
            "Toolchain (every sample installs it): Node 24+, plus pipeline-manager, aws-cdk, esbuild, and pnpm on PATH — --deploy shells out to cdk deploy, whose synth uses esbuild + pnpm. The instantiate step needs nothing extra — it runs through the same CLI.",
            "Platform auth (CI secrets): PLATFORM_BASE_URL, PLATFORM_TOKEN (an access key from pipeline-manager auth pat or the dashboard), and PB_ORG_ID (your org's UUID, passed as the template's orgId input).",
            "AWS auth: each platform's OIDC federation assumes a deploy role — the role ARN is stored as a CI secret (AWS_DEPLOY_ROLE_ARN), never committed. Each sample notes the one-line swap to static access keys.",
            "Region via AWS_REGION (or --region); otherwise resolves AWS_REGION → CDK_DEFAULT_REGION → us-east-1."
          ]
        },
        {
          "type": "text",
          "content": "GitHub Actions"
        },
        {
          "type": "text",
          "content": "github-actions/deploy-pipeline.yml — triggered manually via workflow_dispatch (with template_name, project, and organization inputs) and includes a commented push trigger. Requests id-token: write and assumes AWS_DEPLOY_ROLE_ARN with aws-actions/configure-aws-credentials, so no long-lived keys are stored. PLATFORM_BASE_URL / PLATFORM_TOKEN come from Actions secrets."
        },
        {
          "type": "text",
          "content": "GitLab CI/CD"
        },
        {
          "type": "text",
          "content": "gitlab/.gitlab-ci.yml — a single deploy-stage job on the node:24 image. It mints a GitLab OIDC ID token (id_tokens), exchanges it for temporary AWS credentials with aws sts assume-role-with-web-identity, and runs the instantiate + create-and-deploy steps in script:. Runs on manual (web) pipelines by default, with a commented rule to deploy on pushes to main."
        },
        {
          "type": "text",
          "content": "CircleCI"
        },
        {
          "type": "text",
          "content": "circleci/config.yml — a create-and-deploy job on cimg/node:24.14 wired to a context (e.g. pipeline-builder-deploy) that holds the secrets. It exchanges $CIRCLE_OIDC_TOKEN for temporary AWS credentials via STS (written to $BASH_ENV) before the instantiate and deploy steps."
        },
        {
          "type": "text",
          "content": "Exit codes"
        },
        {
          "type": "text",
          "content": "pipeline-manager returns standard exit codes so CI fails on the right things: 0 success · 2 validation · 3 API request · 4 authentication · 5 authorization · 6 not found · 7 network · 8 configuration · 10 timeout. If create succeeds but the deploy fails, the command exits non-zero and prints pipeline-manager pipeline deploy --id <id> so you can retry the deploy without recreating the record."
        }
      ]
    },
    {
      "id": "loading-samples",
      "title": "Loading Samples",
      "blocks": [
        {
          "type": "text",
          "content": "Load all sample templates into a running Pipeline Builder instance. Each template.json is POSTed to /api/pipeline-templates (there is no bulk template endpoint), and the script defaults to https://localhost:8443:"
        },
        {
          "type": "code",
          "content": "cd deploy\nbash bin/load-templates.sh\n\nPLATFORM_BASE_URL=https://pipeline.example.com bash bin/load-templates.sh\n\nbash bin/load-templates.sh --dry-run",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "Templates land in the reserved system org as public, so every logged-in org sees them in the golden-path catalog. A name that already exists comes back as HTTP 409 and is reported as SKIP, so re-running the loader is safe."
        },
        {
          "type": "note",
          "content": "Tip: Samples are also loaded automatically by init-platform.sh during post-deploy setup (LOAD_TEMPLATES=y)."
        }
      ]
    }
  ],
  "sourceDoc": "docs/samples.md"
};
