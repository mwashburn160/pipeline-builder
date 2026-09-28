// GENERATED FROM docs/samples.md — DO NOT EDIT.
// Regenerate: npm run generate:help  (see frontend/scripts/generate-help.mjs)
// SOURCE-SHA256: e00df6f40085d5dffae61c9e4d04aa63ec9fe974b6eb4891a2a05de6f80ae83d
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
          "content": "<!-- Copyright 2026 Pipeline Builder Contributors SPDX-License-Identifier: Apache-2.0 -->"
        },
        {
          "type": "text",
          "content": "Ready-to-use pipeline templates, CDK stack examples and CI/CD configurations. Use them as starting points for your own pipelines, or as reference implementations for advanced patterns."
        },
        {
          "type": "text",
          "content": "Everything indexed here lives in deploy/samples/."
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
            "A template is not a pipeline. You instantiate it with declared inputs to get concrete pipeline props, then create the pipeline from those.",
            "Instantiation only renders. The returned props go through the normal create path, so compliance and quota still apply.",
            "All seven templates need a GitHub OAuth token in Secrets Manager — even for public repos. Without it the deploy fails at pipeline-creation time. A CodeStar connection avoids the token entirely.",
            "orgId is the one declared input, because the source token is the only source field that is synth-templatable. Fork a template to point at your own repository.",
            "The CI samples are idempotent. Re-running upserts the record, updates the CloudFormation stack and refreshes the registry row — no duplicates, no errors.",
            "Templates land in the reserved system org as public, so every logged-in org sees them in the golden-path catalog."
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
          "content": "Three kinds of sample, for three different jobs:"
        },
        {
          "type": "table",
          "headers": [
            "Kind",
            "Count",
            "Use it to"
          ],
          "rows": [
            [
              "Pipeline templates",
              "7 languages — React, Spring Boot, Django, Gin, Axum, Rails, ASP.NET Core",
              "Get a working pipeline for a stack you recognize, then extend it"
            ],
            [
              "CDK stack examples",
              "6 patterns — VPC isolation, multi-account, monorepo, custom IAM roles, secrets management, basic",
              "Learn PipelineBuilder usage for a pattern you need to build by hand"
            ],
            [
              "CI/CD configurations",
              "3 platforms — GitHub Actions, GitLab CI/CD, CircleCI",
              "Instantiate a template and deploy the resulting pipeline in one CI run"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Each template is intentionally minimal — a build and/or security-scan stage — which you extend with tests, linting and container packaging. Every sample directory has its own README with that guidance."
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
            "The templates are loaded into a running instance. Each template.json is POSTed to /api/pipeline-templates, landing in the system org as public.",
            "You instantiate one, supplying its declared inputs. The server renders the template body, baking the inputs into props.vars.",
            "Nothing is created yet. Instantiation returns props; the pipeline does not exist.",
            "You create the pipeline from those props, through the normal create path — so compliance validation and quota apply exactly as they would to a hand-written pipeline.",
            "--deploy also deploys it. The pipeline record is created on the platform, cdk deploy runs for it, and the deployed stack is registered by name plus region — never the ARN, which embeds the AWS account id.",
            "At deploy time, secrets resolve per org. Plugins declaring secrets: [...] get them from pipeline-builder/{orgId}/{secretName} in Secrets Manager, injected as SECRETS_MANAGER-type CodeBuild environment variables."
          ]
        }
      ]
    },
    {
      "id": "configuration",
      "title": "Configuration",
      "blocks": [
        {
          "type": "text",
          "content": "1. Load the templates"
        },
        {
          "type": "code",
          "content": "cd deploy\nbash bin/load-templates.sh\n\nPLATFORM_BASE_URL=https://pipeline.example.com bash bin/load-templates.sh\n\nbash bin/load-templates.sh --dry-run",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "There is no bulk template endpoint — the script POSTs each file — and it defaults to https://localhost:8443. A name that already exists comes back as HTTP 409 and is reported as SKIP, so re-running the loader is safe."
        },
        {
          "type": "note",
          "content": "Tip: init-platform.sh loads the samples for you during post-deploy setup (LOAD_TEMPLATES=y)."
        },
        {
          "type": "text",
          "content": "2. Create the GitHub source token"
        },
        {
          "type": "text",
          "content": "All seven templates use a GitHub (v1/OAuth) source, which CodePipeline authenticates with an OAuth token in AWS Secrets Manager — even for public repos. If the token secret is missing, the deploy fails at pipeline-creation time with:"
        },
        {
          "type": "code",
          "content": "Secrets Manager can't find the specified secret. (ResourceNotFoundException)"
        },
        {
          "type": "text",
          "content": "Each template resolves the secret per org via synth-time templating: its declared orgId input feeds the source token as secretsmanager:pipeline-builder/{{ pipeline.vars.orgId }}/github-token, following the naming standard pipeline-builder/{orgId}/{name}."
        },
        {
          "type": "list",
          "items": [
            "Pass your org's UUID as the orgId input when you instantiate.",
            "Create the matching secret once per account/region:"
          ]
        },
        {
          "type": "text",
          "content": "bash aws secretsmanager create-secret \\ --name \"pipeline-builder/<orgId>/github-token\" \\ --secret-string \"ghp_YOUR_TOKEN_HERE\" \\ --region <your-region>"
        },
        {
          "type": "text",
          "content": "Use a PAT with repo + admin:repo_hook scopes (public repos: public_repo + admin:repo_hook). <orgId> must match the orgId input you pass."
        },
        {
          "type": "text",
          "content": "Two alternatives:"
        },
        {
          "type": "list",
          "items": [
            "Simpler — drop the token line from props.synth.source.options and create a bare github-token secret, which is CDK's default lookup.",
            "Recommended — use a CodeStar/CodeConnections source and skip the token entirely."
          ]
        },
        {
          "type": "text",
          "content": "3. Instantiate and deploy"
        },
        {
          "type": "code",
          "content": "pipeline-manager template instantiate \\\n  --name react-javascript \\\n  --project react --organization AcmeCorp \\\n  --input orgId=<your-org-id> \\\n  --output pipeline-props.json\n\npipeline-manager pipeline create --file pipeline-props.json --deploy --region us-east-1",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "--name resolves against the catalog you can see and refuses to guess when the name is missing or matches more than one visible template; pass --id to pick one explicitly. Repeat --input k=v per declared input, or pass a JSON --inputs-file that --input flags override. Without --output the props go to stdout; --json suppresses all decorative output so the stream pipes cleanly into jq. Full flag reference: pipeline-manager template instantiate --help."
        },
        {
          "type": "text",
          "content": "Or pick the template from the dashboard's golden-path catalog and fill in the inputs there."
        },
        {
          "type": "text",
          "content": "4. For a CI run, set the secrets"
        },
        {
          "type": "list",
          "items": [
            "Platform auth: PLATFORM_BASE_URL, PLATFORM_TOKEN (an access key from pipeline-manager auth pat or the dashboard), and PB_ORG_ID (your org's UUID, passed as the template's orgId input).",
            "AWS auth: each platform's OIDC federation assumes a deploy role whose ARN is stored as a CI secret (AWS_DEPLOY_ROLE_ARN), never committed. Each sample notes the one-line swap to static access keys.",
            "Region: AWS_REGION (or --region); otherwise resolves AWS_REGION → CDK_DEFAULT_REGION → us-east-1.",
            "Toolchain (every sample installs it): Node 24+, plus pipeline-manager, aws-cdk, esbuild and pnpm on PATH — --deploy shells out to cdk deploy, whose synth uses esbuild and pnpm. The instantiate step needs nothing extra."
          ]
        }
      ]
    },
    {
      "id": "pipeline-template-samples",
      "title": "Pipeline template samples",
      "blocks": [
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
          "content": "props deliberately omits project, organization and vars — instantiation supplies all three from the request, so there is nothing to hand-edit."
        },
        {
          "type": "text",
          "content": "Patterns worth copying"
        },
        {
          "type": "list",
          "items": [
            "Plugin filters — every plugin reference includes a filter (version, visibility, isActive, isDefault) so the resolved plugin version is explicit and reproducible.",
            "Failure behavior — advisory checks such as dependency audits use failureBehavior: \"warn\" so they report findings without failing the build.",
            "Step positioning — primary steps use \"pre\", supplementary steps use \"post\".",
            "Compute sizing — heavier steps override the default compute to MEDIUM or LARGE via the aws:cdk:codebuild:buildenvironment:computetype metadata key."
          ]
        }
      ]
    },
    {
      "id": "cdk-typescript-examples",
      "title": "CDK TypeScript examples",
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
          "content": "The three IAM role levels"
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
          "content": "The secrets flow"
        },
        {
          "type": "text",
          "content": "From secrets-management-ts:"
        },
        {
          "type": "list",
          "items": [
            "Set orgId on BuilderProps.",
            "Plugins declare secrets: [{ name: 'SECRET_NAME', required: true }].",
            "At deploy, the value resolves from pipeline-builder/{orgId}/{secretName} in Secrets Manager.",
            "It is injected as a SECRETS_MANAGER-type CodeBuild environment variable automatically."
          ]
        }
      ]
    },
    {
      "id": "ci-cd-samples",
      "title": "CI/CD samples",
      "blocks": [
        {
          "type": "text",
          "content": "Ready-to-copy configurations that instantiate a pipeline template, then create and deploy the resulting pipeline with pipeline-manager pipeline create --deploy. A green CI run therefore means the pipeline both exists on the platform and is deployed to AWS."
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
          "content": "Each sample instantiates the react-javascript template by default — set TEMPLATE_NAME (plus PB_PROJECT / PB_ORGANIZATION) to any other template in your catalog. Instantiation reads the platform's live catalog, so the template must already be loaded there."
        },
        {
          "type": "text",
          "content": "All three are idempotent: re-running with the same config upserts the record (keyed on project + organization + orgId), updates the CloudFormation stack and refreshes the registry row."
        },
        {
          "type": "text",
          "content": "GitHub Actions"
        },
        {
          "type": "text",
          "content": "github-actions/deploy-pipeline.yml — triggered manually via workflow_dispatch (with template_name, project and organization inputs), and includes a commented push trigger. It requests id-token: write and assumes AWS_DEPLOY_ROLE_ARN with aws-actions/configure-aws-credentials, so no long-lived keys are stored. PLATFORM_BASE_URL / PLATFORM_TOKEN come from Actions secrets."
        },
        {
          "type": "text",
          "content": "GitLab CI/CD"
        },
        {
          "type": "text",
          "content": "gitlab/.gitlab-ci.yml — a single deploy-stage job on the node:24 image. It mints a GitLab OIDC ID token (id_tokens), exchanges it for temporary AWS credentials with aws sts assume-role-with-web-identity, and runs the instantiate plus create-and-deploy steps in script:. Runs on manual (web) pipelines by default, with a commented rule to deploy on pushes to main."
        },
        {
          "type": "text",
          "content": "CircleCI"
        },
        {
          "type": "text",
          "content": "circleci/config.yml — a create-and-deploy job on cimg/node:24.21 wired to a context (e.g. pipeline-builder-deploy) that holds the secrets. It exchanges $CIRCLE_OIDC_TOKEN for temporary AWS credentials via STS (written to $BASH_ENV) before the instantiate and deploy steps."
        },
        {
          "type": "text",
          "content": "Exit codes"
        },
        {
          "type": "text",
          "content": "pipeline-manager returns standard exit codes so CI fails on the right things:"
        },
        {
          "type": "text",
          "content": "0 success · 2 validation · 3 API request · 4 authentication · 5 authorization · 6 not found · 7 network · 8 configuration · 10 timeout"
        },
        {
          "type": "text",
          "content": "If create succeeds but the deploy fails, the command exits non-zero and prints pipeline-manager pipeline deploy --id <id> so you can retry the deploy without recreating the record."
        }
      ]
    },
    {
      "id": "related",
      "title": "Related",
      "blocks": [
        {
          "type": "list",
          "items": [
            "Plugin Catalog — the plugins these templates reference",
            "Metadata Keys — the typed keys the samples set",
            "Template Syntax — the {{ ... }} grammar templates are written in",
            "CDK Usage — the PipelineBuilder construct the CDK samples use",
            "Pipeline Manager — the CLI the samples drive",
            "API Reference — the endpoints behind them"
          ]
        }
      ]
    }
  ],
  "sourceDoc": "docs/samples.md"
};
