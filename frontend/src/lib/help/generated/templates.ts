// GENERATED FROM docs/templates.md — DO NOT EDIT.
// Regenerate: npm run generate:help  (see frontend/scripts/generate-help.mjs)
// SOURCE-SHA256: 4fb9bc62e5a46501964d9a2c78f70a0ff20cebb96a64091f9175ff39a438148e
// SPDX-License-Identifier: Apache-2.0
import { Braces } from 'lucide-react';
import type { HelpTopic } from '../types';

export const templatesTopic: HelpTopic = {
  "icon": Braces,
  "id": "templates",
  "title": "Templates",
  "description": "Synth-time {{ … }} templating for pipelines and plugins",
  "sections": [
    {
      "id": "overview",
      "title": "Overview",
      "blocks": [
        {
          "type": "text",
          "content": "Related docs: Metadata Keys | CDK Usage | Plugin Catalog | API Reference"
        },
        {
          "type": "text",
          "content": "Pipeline Builder supports a minimal {{ path.to.value }} template syntax in both pipeline configs (pipeline.json) and plugin specs (plugin-spec.yaml). Templates are resolved once, at synthesis time, against a fixed scope — no runtime evaluation, no code execution."
        },
        {
          "type": "list",
          "items": [
            "One plugin, many environments — parameterize namespaces, regions, cluster names via pipeline.metadata.*",
            "One pipeline template, many deployments — compose names and vars via self-references",
            "Opt-in — plugins and pipelines that use no {{ ... }} tokens behave exactly as they did before"
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
          "content": "This reference documents the {{ path.to.value }} template syntax available in pipeline configs (pipeline.json) and plugin specs (plugin-spec.yaml) — its grammar, scopes, filters, the plugin contract, CLI/editor tooling, and error catalog. It's for plugin and pipeline authors who want a single spec to serve many environments. Resolution is server-side, happens once at synthesis time, and never executes code."
        }
      ]
    },
    {
      "id": "process-overview-synth-time-resolution",
      "title": "Process overview (synth-time resolution)",
      "blocks": [
        {
          "type": "list",
          "items": [
            "Author writes {{ ... }} tokens in pipeline.json (self-references) and/or plugin-spec.yaml (pipeline., plugin., env.*).",
            "On upload the platform parses and validates every token — unknown paths, cycles, contract gaps, and size/depth limits fail with HTTP 400.",
            "Pass 1 resolves a pipeline config's metadata.* / vars.* self-references.",
            "At synth, each plugin spec is resolved against the invoking pipeline's assembled scope.",
            "Filters apply — | default: fills missing values; | number / | bool / | json coerce whole-field templates.",
            "Resolved text is never re-scanned (no recursive templating); $CODEBUILD_* shell vars stay literal for runtime."
          ]
        }
      ]
    },
    {
      "id": "grammar",
      "title": "Grammar",
      "blocks": [
        {
          "type": "code",
          "content": "Template   := (Literal | Expr)*\nExpr       := \"{{\" ws Path (ws Filter)? ws \"}}\"\nPath       := Identifier (\".\" Identifier)*\nIdentifier := [a-zA-Z_][a-zA-Z0-9_]{0,63}\nFilter     := \"|\" ws \"default\" ws \":\" ws Quoted\nQuoted     := \"'...'\"  |  \"\\\"...\\\"\""
        },
        {
          "type": "list",
          "items": [
            "Escape a literal {{ as {{{{ (doubled).",
            "Max path depth: 5 identifiers.",
            "Max templated-field size: 4 KiB.",
            "Supported filters: | default: '...', | number, | bool, | json.",
            "default may appear once; at most one coercion filter per expression."
          ]
        }
      ]
    },
    {
      "id": "scope-reference",
      "title": "Scope reference",
      "blocks": [
        {
          "type": "text",
          "content": "Different docs see different scopes."
        },
        {
          "type": "text",
          "content": "In a pipeline config (pipeline.json)"
        },
        {
          "type": "text",
          "content": "Pipeline templates can only self-reference — one metadata key can interpolate another, or reference a vars key."
        },
        {
          "type": "table",
          "headers": [
            "Scope root",
            "Available inside"
          ],
          "rows": [
            [
              "metadata.*",
              "Any other metadata key in the same pipeline"
            ],
            [
              "vars.*",
              "Any vars key in the same pipeline"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Templatable fields in a pipeline config: project, metadata.* string values, vars.* string values. Identity fields (id, orgId, stages, plugins[]) are not templatable."
        },
        {
          "type": "text",
          "content": "Exception — the GitHub source token. synth.source.options.token is templatable against the pipeline scope (pipeline.*, the same scope plugin specs see), so a secret reference can be parameterized per org:"
        },
        {
          "type": "code",
          "content": "\"synth\": {\n  \"source\": {\n    \"type\": \"github\",\n    \"options\": {\n      \"repo\": \"owner/repo\",\n      \"branch\": \"main\",\n      \"token\": \"secretsmanager:pipeline-builder/{{ pipeline.vars.orgId }}/github-token\"\n    }\n  }\n},\n\"vars\": { \"orgId\": \"<your-org-id>\" }",
          "language": "json"
        },
        {
          "type": "text",
          "content": "It resolves at synth time to secretsmanager:pipeline-builder/<your-org-id>/github-token, which CodePipeline reads as the OAuth secret reference (only the reference — never the token value — lands in the template). Other source fields (repo, branch, etc.) stay literal."
        },
        {
          "type": "text",
          "content": "In a plugin spec (plugin-spec.yaml)"
        },
        {
          "type": "text",
          "content": "Plugin templates see a richer scope assembled per-synth from the pipeline invoking the plugin."
        },
        {
          "type": "table",
          "headers": [
            "Scope root",
            "Available inside"
          ],
          "rows": [
            [
              "pipeline.projectName",
              "String — the pipeline's project name"
            ],
            [
              "pipeline.orgId",
              "String — org UUID"
            ],
            [
              "pipeline.metadata.*",
              "Any key set on the pipeline's metadata object"
            ],
            [
              "pipeline.vars.*",
              "Any key set on the pipeline's vars object"
            ],
            [
              "plugin.name / plugin.version",
              "Plugin record fields"
            ],
            [
              "env.FOO",
              "Any key declared in the same plugin's env: map"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Templatable fields in a plugin spec: description, commands[], installCommands[], env.* values, buildArgs.* values. Identity/security fields (name, version, pluginType, computeType, timeout, secrets, failureBehavior) are not templatable."
        },
        {
          "type": "text",
          "content": "Reserved paths"
        },
        {
          "type": "list",
          "items": [
            "secrets.* is reserved — use the plugin's secrets: yaml field instead of templating.",
            "Host env vars (process.env) are not in scope — they will never leak into a template."
          ]
        }
      ]
    },
    {
      "id": "plugin-contract-declare-your-requirements",
      "title": "Plugin contract: declare your requirements",
      "blocks": [
        {
          "type": "text",
          "content": "When a plugin spec references pipeline.metadata.X or pipeline.vars.Y, it must declare that dependency so pipelines using the plugin are rejected if they don't supply the key."
        },
        {
          "type": "code",
          "content": "name: kubectl-deploy\nversion: 2.0.0\npluginType: CodeBuildStep\ncomputeType: SMALL\n\nrequiredMetadata: [env, namespace, clusterName, region]\nrequiredVars: []\n\nenv:\n  KUBECONFIG: /tmp/{{ pipeline.metadata.env }}-kubeconfig\ninstallCommands:\n  - \"aws eks update-kubeconfig --name {{ pipeline.metadata.clusterName }} --region {{ pipeline.metadata.region }}\"\ncommands:\n  - \"kubectl apply -f k8s/{{ pipeline.metadata.env }}/ -n {{ pipeline.metadata.namespace }}\"",
          "language": "yaml"
        },
        {
          "type": "text",
          "content": "If a template uses | default: '...', the key is treated as optional and can be omitted from requiredMetadata / requiredVars."
        }
      ]
    },
    {
      "id": "example-pipeline-level-self-references",
      "title": "Example: pipeline-level self-references",
      "blocks": [
        {
          "type": "code",
          "content": "{\n  \"id\": \"bb234ff6-8b2e-41e3-9758-fb23b63916cd\",\n  \"project\": \"{{ vars.service }}-{{ metadata.env }}\",\n  \"orgId\": \"acmecorp\",\n  \"metadata\": {\n    \"env\": \"prod\",\n    \"region\": \"us-east-1\",\n    \"clusterName\": \"acme-eks-{{ metadata.env }}\",\n    \"namespace\": \"{{ vars.service }}-{{ metadata.env }}\"\n  },\n  \"vars\": {\n    \"service\": \"checkout\",\n    \"branch\": \"main\",\n    \"slackChannel\": \"#deploys-{{ metadata.env }}\"\n  },\n  \"stages\": [\n    { \"name\": \"deploy\", \"plugins\": [\"kubectl-deploy\", \"slack-notify\"] }\n  ]\n}",
          "language": "json"
        },
        {
          "type": "text",
          "content": "After pass-1 resolution, the pipeline looks like:"
        },
        {
          "type": "code",
          "content": "{\n  \"project\": \"checkout-prod\",\n  \"metadata\": {\n    \"env\": \"prod\",\n    \"region\": \"us-east-1\",\n    \"clusterName\": \"acme-eks-prod\",\n    \"namespace\": \"checkout-prod\"\n  },\n  \"vars\": {\n    \"service\": \"checkout\",\n    \"branch\": \"main\",\n    \"slackChannel\": \"#deploys-prod\"\n  }\n}",
          "language": "json"
        },
        {
          "type": "text",
          "content": "Cycles are detected and rejected at upload time:"
        },
        {
          "type": "code",
          "content": "POST /api/pipelines  →  400 TEMPLATE_VALIDATION_FAILED\n\nPipeline has circular template references:\n  • Template cycle detected: metadata.a -> metadata.b -> metadata.a"
        }
      ]
    },
    {
      "id": "example-plugin-spec-with-pipeline-interpolation",
      "title": "Example: plugin spec with pipeline.* interpolation",
      "blocks": [
        {
          "type": "text",
          "content": "Before templates — hardcoded per environment:"
        },
        {
          "type": "code",
          "content": "name: kubectl-deploy-prod\ncommands:\n  - \"kubectl apply -f k8s/prod/ -n checkout-prod\"\n  - \"kubectl scale deployment checkout --replicas=3 -n checkout-prod\"",
          "language": "yaml"
        },
        {
          "type": "text",
          "content": "After templates — one plugin serves N environments:"
        },
        {
          "type": "code",
          "content": "name: kubectl-deploy\nversion: 2.0.0\npluginType: CodeBuildStep\ncomputeType: SMALL\n\nrequiredMetadata: [env, namespace, replicas]\nrequiredVars: []\n\nenv:\n  NAMESPACE: \"{{ pipeline.metadata.namespace }}\"\ninstallCommands:\n  - \"kubectl config use-context {{ pipeline.metadata.env }}\"\ncommands:\n  - \"kubectl apply -f k8s/{{ pipeline.metadata.env }}/ -n {{ env.NAMESPACE }}\"\n  - \"kubectl scale deployment {{ pipeline.projectName }} --replicas={{ pipeline.metadata.replicas | default: '1' }} -n {{ env.NAMESPACE }}\"",
          "language": "yaml"
        }
      ]
    },
    {
      "id": "example-notification-plugin",
      "title": "Example: notification plugin",
      "blocks": [
        {
          "type": "code",
          "content": "name: slack-notify\nversion: 2.0.0\npluginType: CodeBuildStep\ncomputeType: SMALL\n\nrequiredMetadata: [env]\nrequiredVars: [slackChannel]\n\nsecrets:\n  - name: SLACK_WEBHOOK_URL\n    required: true\n\ncommands:\n  - |\n    curl -X POST \"$SLACK_WEBHOOK_URL\" \\\n      -H 'Content-Type: application/json' \\\n      -d '{\n        \"channel\": \"{{ pipeline.vars.slackChannel }}\",\n        \"text\": \"✅ {{ pipeline.projectName }} deployed to {{ pipeline.metadata.env }} from {{ pipeline.vars.branch | default: 'unknown' }}\"\n      }'",
          "language": "yaml"
        }
      ]
    },
    {
      "id": "example-build-plugin-with-buildargs",
      "title": "Example: build plugin with buildArgs",
      "blocks": [
        {
          "type": "code",
          "content": "name: docker-build-push\nversion: 2.0.0\npluginType: CodeBuildStep\ncomputeType: MEDIUM\n\nrequiredMetadata: [region, ecrRepoName]\nrequiredVars: []\n\nbuildArgs:\n  BUILD_ENV: \"{{ pipeline.metadata.env | default: 'staging' }}\"\n  COMMIT_SHA: \"$CODEBUILD_RESOLVED_SOURCE_VERSION\"   # literal — runtime var\n\ncommands:\n  - \"aws ecr get-login-password --region {{ pipeline.metadata.region }} | docker login --password-stdin {{ pipeline.orgId }}.dkr.ecr.{{ pipeline.metadata.region }}.amazonaws.com\"\n  - \"docker build --build-arg BUILD_ENV=$BUILD_ENV -t {{ pipeline.metadata.ecrRepoName }}:$COMMIT_SHA .\"\n  - \"docker push {{ pipeline.metadata.ecrRepoName }}:$COMMIT_SHA\"",
          "language": "yaml"
        },
        {
          "type": "text",
          "content": "Note the mix: {{ ... }} is resolved at synth time, while $CODEBUILD_* variables stay literal and are evaluated at runtime by the shell."
        }
      ]
    },
    {
      "id": "filters",
      "title": "Filters",
      "blocks": [
        {
          "type": "text",
          "content": "| default: '...' — fallback value"
        },
        {
          "type": "text",
          "content": "Use | default: '...' to supply a fallback when a scope path is undefined or empty:"
        },
        {
          "type": "code",
          "content": "commands:\n  - \"kubectl scale deployment {{ pipeline.projectName }} --replicas={{ pipeline.metadata.replicas | default: '1' }}\"\n  - \"curl -s https://api.example.com/{{ pipeline.metadata.endpoint | default: 'v1/health' }}\"",
          "language": "yaml"
        },
        {
          "type": "list",
          "items": [
            "Default value must be a single- or double-quoted string.",
            "Backslash-escape \\\\, \\', \\\" are supported inside the quoted default.",
            "When the template uses | default:, the referenced key does not need to appear in requiredMetadata / requiredVars."
          ]
        },
        {
          "type": "text",
          "content": "| number, | bool, | json — type coercion"
        },
        {
          "type": "text",
          "content": "Coercion filters turn the resolved text into a native value, but only when the template is the entire field (no surrounding literal text):"
        },
        {
          "type": "code",
          "content": "metadata:\n  replicas:  \"{{ vars.count | number }}\"        # → 3 (number)\n  isProd:    \"{{ vars.env | bool }}\"             # → true\n  features:  \"{{ vars.featureJson | json }}\"     # → parsed JSON\n\nenv:\n  MSG: \"count={{ vars.count | number }}\"         # → \"count=3\" (string)",
          "language": "yaml"
        },
        {
          "type": "text",
          "content": "Coercion rules:"
        },
        {
          "type": "table",
          "headers": [
            "Filter",
            "Accepts",
            "Produces"
          ],
          "rows": [
            [
              "`\\",
              "number`",
              "Any string Number() can parse",
              "number"
            ],
            [
              "`\\",
              "bool`",
              "true / false / 1 / 0 / yes / no / \"\" (case-insensitive)",
              "boolean"
            ],
            [
              "`\\",
              "json`",
              "Any valid JSON string",
              "`string \\",
              "number \\",
              "bool \\",
              "null \\",
              "object \\",
              "array`"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Coercion filters can chain with default:"
        },
        {
          "type": "code",
          "content": "replicas: \"{{ vars.replicas | default: '1' | number }}\"   # → 1 (number) if vars.replicas missing",
          "language": "yaml"
        },
        {
          "type": "text",
          "content": "Unparseable values (e.g. \"abc\" | number) throw TEMPLATE_TYPE_MISMATCH at synth time."
        }
      ]
    },
    {
      "id": "cli-tools",
      "title": "CLI tools",
      "blocks": [
        {
          "type": "text",
          "content": "Preview resolved output"
        },
        {
          "type": "code",
          "content": "pipeline-manager pipeline deploy --id <uuid> --show-resolved\npipeline-manager pipeline synth  --id <uuid> --show-resolved",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "Validate templates without uploading"
        },
        {
          "type": "code",
          "content": "pipeline-manager template validate --file ./plugin-spec.yaml\n\npipeline-manager template validate --pipeline <uuid>\n\npipeline-manager template validate --plugin kubectl-deploy:2.0.0",
          "language": "bash"
        }
      ]
    },
    {
      "id": "frontend-editor-integration",
      "title": "Frontend editor integration",
      "blocks": [
        {
          "type": "text",
          "content": "The dashboard editor understands {{ ... }} tokens:"
        },
        {
          "type": "list",
          "items": [
            "Metadata value fields show a template-count hint below the input while you type:"
          ]
        },
        {
          "type": "text",
          "content": "_\"Contains 2 template tokens — resolved at synth time\"_"
        },
        {
          "type": "list",
          "items": [
            "Parse errors surface inline under the field with the source position:"
          ]
        },
        {
          "type": "text",
          "content": "_\"Expected '}}' at line 1, col 10\"_"
        },
        {
          "type": "list",
          "items": [
            "useTemplateValidation(source, scope?) hook powers this feedback. It returns { valid, tokens, hasTemplates, error, errorPos, resolved, resolveError }, so any custom editor can parse for diagnostics and (when a scope is supplied) preview the resolved value live."
          ]
        },
        {
          "type": "text",
          "content": "No rich editor, no auto-escape — what you type is saved verbatim. Template resolution is a server-side concern; the client only parses for diagnostics + preview."
        }
      ]
    },
    {
      "id": "api-resolve-true",
      "title": "API: ?resolve=true",
      "blocks": [
        {
          "type": "text",
          "content": "Pipeline read endpoints return the source by default (with {{ ... }} intact) so editors can round-trip. Pass ?resolve=true to get the resolved form."
        },
        {
          "type": "code",
          "content": "GET /api/pipelines/{id}            # source form (for editing)\nGET /api/pipelines/{id}?resolve=true  # resolved form (for preview/inspection)",
          "language": "http"
        }
      ]
    },
    {
      "id": "error-catalog",
      "title": "Error catalog",
      "blocks": [
        {
          "type": "text",
          "content": "All template errors map to HTTP 400 with one of these codes:"
        },
        {
          "type": "table",
          "headers": [
            "Code",
            "Meaning"
          ],
          "rows": [
            [
              "TEMPLATE_PARSE_ERROR",
              "Malformed {{ ... }} — bad syntax, missing }}, unknown filter"
            ],
            [
              "TEMPLATE_UNKNOWN_PATH",
              "Path references an unknown scope root (e.g. {{ foo.bar }})"
            ],
            [
              "TEMPLATE_CYCLE",
              "Self-referencing pipeline has a cycle across metadata/vars fields"
            ],
            [
              "TEMPLATE_TYPE_MISMATCH",
              "Path resolved to an object where a scalar was expected"
            ],
            [
              "TEMPLATE_SECRETS_RESERVED",
              "Reserved secrets.* path — use the plugin's secrets: yaml field instead"
            ],
            [
              "TEMPLATE_CONTRACT_VIOLATION",
              "Pipeline is missing a key declared in a referenced plugin's requiredMetadata / requiredVars"
            ],
            [
              "TEMPLATE_SIZE_EXCEEDED",
              "Field exceeded 4 KiB or path depth exceeded 5"
            ],
            [
              "TEMPLATE_VALIDATION_FAILED",
              "Batched umbrella — one or more of the above present in a single doc"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Every error includes field, line, col (when applicable), and the exact path or cycle that triggered it."
        }
      ]
    },
    {
      "id": "what-s-not-supported-by-design",
      "title": "What's not supported (by design)",
      "blocks": [
        {
          "type": "list",
          "items": [
            "Conditionals / if-else — prefer separate plugins or a thin shell wrapper",
            "Loops — use a single plugin spec that iterates at runtime in its commands:",
            "Math / string manipulation filters — keep composition in shell, not templates",
            "Runtime templating — {{ ... }} is resolved once at synth time, never again",
            "Dockerfile templating — Dockerfiles are COPY'd verbatim; parameterize via buildArgs:",
            "Templating secrets:, name:, version:, pluginType: — identity/security-sensitive fields are literal-only",
            "Recursive resolution — resolved values are never re-scanned for {{ ... }} tokens (prevents template-injection through user-supplied metadata)"
          ]
        }
      ]
    },
    {
      "id": "migrating-an-existing-plugin",
      "title": "Migrating an existing plugin",
      "blocks": [
        {
          "type": "text",
          "content": "Adopting templates on an existing plugin changes nothing for current callers when you use | default::"
        },
        {
          "type": "text",
          "content": "1. Add the contract block"
        },
        {
          "type": "code",
          "content": "requiredMetadata: []   # pipeline.metadata keys you require (empty if all optional)\nrequiredVars: []\nmetadataTypes:         # type hints enable coercion safety\n  replicas: number\n  isProd: bool\nvarsTypes:\n  branch: string",
          "language": "yaml"
        },
        {
          "type": "text",
          "content": "2. Replace hardcoded env defaults with templates"
        },
        {
          "type": "text",
          "content": "Before:"
        },
        {
          "type": "code",
          "content": "env:\n  KUBE_NAMESPACE: default\n  ROLLOUT_TIMEOUT: \"300s\"",
          "language": "yaml"
        },
        {
          "type": "text",
          "content": "After:"
        },
        {
          "type": "code",
          "content": "env:\n  KUBE_NAMESPACE: \"{{ pipeline.metadata.namespace | default: 'default' }}\"\n  ROLLOUT_TIMEOUT: \"{{ pipeline.metadata.rolloutTimeoutSeconds | default: '300' }}s\"",
          "language": "yaml"
        },
        {
          "type": "text",
          "content": "3. Bump the plugin version"
        },
        {
          "type": "text",
          "content": "Minor bump (e.g. 1.0.0 → 1.1.0) so pipelines can pin the pre-template version if needed."
        },
        {
          "type": "text",
          "content": "Reference conversions in this repo"
        },
        {
          "type": "text",
          "content": "Five production plugins now show the pattern:"
        },
        {
          "type": "table",
          "headers": [
            "Plugin",
            "Metadata keys used"
          ],
          "rows": [
            [
              "notification/slack-notify",
              "env, vars.branch, vars.slackChannel, projectName"
            ],
            [
              "notification/teams-notify",
              "env, vars.branch, projectName"
            ],
            [
              "deploy/kubectl-deploy",
              "context, namespace, manifestPath, rolloutTimeoutSeconds"
            ],
            [
              "deploy/helm-deploy",
              "namespace, helmRelease, helmChart, helmTimeoutSeconds"
            ],
            [
              "deploy/ecs-deploy",
              "ecsCluster, ecsService, imageUri, ecsTaskFamily"
            ]
          ]
        },
        {
          "type": "text",
          "content": "All pipelines continue to work unchanged; when they start supplying metadata keys, the plugin auto-populates the env vars."
        }
      ]
    },
    {
      "id": "troubleshooting",
      "title": "Troubleshooting",
      "blocks": [
        {
          "type": "text",
          "content": "\"Template references unknown scope root 'foo'\" → Only pipeline, plugin, env (for plugins) and metadata, vars (for pipelines) are accepted scope roots."
        },
        {
          "type": "text",
          "content": "\"'secrets' is a reserved scope\" → Move secret references into the plugin's top-level secrets: yaml field. Secrets Manager handles the injection as env vars."
        },
        {
          "type": "text",
          "content": "\"Plugin spec uses template paths not declared in contract\" → Add the missing key to your plugin's requiredMetadata: or requiredVars: list, or use | default: '...' to make it optional."
        },
        {
          "type": "text",
          "content": "\"Template cycle detected\" → One of your metadata.* or vars.* fields references another that references back to the first. The error message includes the full cycle chain."
        },
        {
          "type": "text",
          "content": "{{ ... }} still visible in my CodeBuild logs → The plugin was loaded without pipelineScope — this happens only in legacy direct-invocation paths. The platform-managed synth flow always passes scope."
        }
      ]
    },
    {
      "id": "golden-pipeline-templates",
      "title": "Golden pipeline templates",
      "blocks": [
        {
          "type": "text",
          "content": "A golden pipeline template is a reusable, governed pipeline config — a BuilderProps with {{ vars.* }} placeholders — plus a set of declared inputs. Teams instantiate it (filling the inputs) to spin up a real pipeline in a few fields instead of hand-building one. It's the same {{ … }} engine documented above: each declared input becomes a vars.<name> value, baked in at instantiate time."
        },
        {
          "type": "text",
          "content": "Create one from an existing pipeline — Save as template (a pipeline's detail page) or Templates → New template — or Import a template JSON on the Templates page. Declare inputs (e.g. repoUrl, branch) and parameterize the repository so one template targets any repo: the authoring form swaps the source pipeline's concrete repo URL for {{ vars.repoUrl }} (the \"Parameterize repository\" button auto-detects it)."
        },
        {
          "type": "text",
          "content": "Example — a Node build → test → deploy starter, parameterized on the target repo"
        },
        {
          "type": "text",
          "content": "project / organization come from the Use-template form; repoUrl / branch are declared inputs:"
        },
        {
          "type": "code",
          "content": "{\n  \"name\": \"node-service\",\n  \"category\": \"backend\",\n  \"description\": \"Golden path: Node build -> tests -> CDK deploy, pointed at any repo.\",\n  \"inputs\": [\n    { \"name\": \"repoUrl\", \"label\": \"Repository URL\", \"type\": \"string\", \"required\": true },\n    { \"name\": \"branch\",  \"label\": \"Branch\",         \"type\": \"string\", \"default\": \"main\" }\n  ],\n  \"props\": {\n    \"synth\": {\n      \"plugin\": { \"name\": \"cdk-synth\" },\n      \"source\": { \"repositoryUrl\": \"{{ vars.repoUrl }}\", \"branch\": \"{{ vars.branch }}\" }\n    },\n    \"stages\": [\n      { \"stageName\": \"build\",  \"steps\": [{ \"plugin\": { \"name\": \"nodejs\" } }] },\n      { \"stageName\": \"test\",   \"steps\": [{ \"plugin\": { \"name\": \"jest\" } }] },\n      { \"stageName\": \"deploy\", \"steps\": [{ \"plugin\": { \"name\": \"cdk-deploy\" } }] }\n    ]\n  }\n}",
          "language": "json"
        },
        {
          "type": "text",
          "content": "Use it — Templates → Use template → enter Project, Target repository (Git URL) and Branch → Create. The instantiate call renders the vars into the props, then creates the pipeline (compliance + quota still apply):"
        },
        {
          "type": "code",
          "content": "POST /api/pipeline-templates/<id>/instantiate\n{\n  \"project\": \"checkout\",\n  \"organization\": \"acme\",\n  \"inputs\": { \"repoUrl\": \"https://github.com/acme/checkout\", \"branch\": \"main\" }\n}\n// -> props.synth.source.repositoryUrl == \"https://github.com/acme/checkout\"\n//    a new pipeline builds github.com/acme/checkout",
          "language": "json"
        },
        {
          "type": "text",
          "content": "Visibility — templates use the same three-rung ladder every catalog entity uses (Permissions → the visibility ladder); templates differ only in that they default to private:"
        },
        {
          "type": "table",
          "headers": [
            "Rung",
            "Who can see it",
            "Who can edit it"
          ],
          "rows": [
            [
              "private (default)",
              "Only you — a personal draft",
              "Only you"
            ],
            [
              "org",
              "Everyone in your organization",
              "Anyone with templates:write"
            ],
            [
              "public",
              "Your org and its teams; from the system org, every org",
              "templates:publish"
            ]
          ]
        },
        {
          "type": "text",
          "content": "New templates start private, so you can iterate before sharing. Moving one to public needs templates:publish — a caller without it is clamped to org rather than silently dropped back to a draft. The shared system catalog across all orgs is a superadmin action from the system org."
        },
        {
          "type": "text",
          "content": "Related docs: Metadata Keys | CDK Usage | Plugin Catalog | API Reference"
        }
      ]
    }
  ],
  "sourceDoc": "docs/templates.md"
};
