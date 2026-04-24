---
title: Template Syntax
layout: default
---

# Template Syntax (synth-time scripting)

**Related docs:** [Metadata Keys](metadata-keys.md) | [CDK Usage](cdk-usage.md) | [Plugin Catalog](plugins/README.md) | [API Reference](api-reference.md)

Pipeline Builder supports a minimal `{{ path.to.value }}` template syntax in both **pipeline configs** (`pipeline.json`) and **plugin specs** (`plugin-spec.yaml`). Templates are resolved once, at synthesis time, against a fixed scope — no runtime evaluation, no code execution.

- One plugin, many environments — parameterize namespaces, regions, cluster names via `pipeline.metadata.*`
- One pipeline template, many deployments — compose names and vars via self-references
- Zero-config backward compatibility — plugins and pipelines without `{{ ... }}` tokens are unchanged

---

## Grammar

```
Template   := (Literal | Expr)*
Expr       := "{{" ws Path (ws Filter)? ws "}}"
Path       := Identifier ("." Identifier)*
Identifier := [a-zA-Z_][a-zA-Z0-9_]{0,63}
Filter     := "|" ws "default" ws ":" ws Quoted
Quoted     := "'...'"  |  "\"...\""
```

- Escape a literal `{{` as `{{{{` (doubled).
- Max path depth: 5 identifiers.
- Max templated-field size: 4 KiB.
- Supported filters: `| default: '...'`, `| number`, `| bool`, `| json`.
- `default` may appear once; at most one coercion filter per expression.

---

## Scope reference

Different docs see different scopes.

### In a pipeline config (`pipeline.json`)

Pipeline templates can only **self-reference** — one metadata key can interpolate another, or reference a `vars` key.

| Scope root | Available inside |
|---|---|
| `metadata.*` | Any other metadata key in the same pipeline |
| `vars.*` | Any `vars` key in the same pipeline |

Templatable fields in a pipeline config: `projectName`, `metadata.*` string values, `vars.*` string values. Identity fields (`id`, `orgId`, `stages`, `plugins[]`) are **not** templatable.

### In a plugin spec (`plugin-spec.yaml`)

Plugin templates see a richer scope assembled per-synth from the pipeline invoking the plugin.

| Scope root | Available inside |
|---|---|
| `pipeline.projectName` | String — the pipeline's project name |
| `pipeline.orgId` | String — org UUID |
| `pipeline.metadata.*` | Any key set on the pipeline's `metadata` object |
| `pipeline.vars.*` | Any key set on the pipeline's `vars` object |
| `plugin.name` / `plugin.version` / `plugin.imageTag` | Plugin record fields |
| `env.FOO` | Any key declared in the same plugin's `env:` map |

Templatable fields in a plugin spec: `description`, `commands[]`, `installCommands[]`, `env.*` values, `buildArgs.*` values. Identity/security fields (`name`, `version`, `pluginType`, `computeType`, `timeout`, `secrets`, `failureBehavior`) are **not** templatable.

### Reserved paths

- `secrets.*` is **reserved** — use the plugin's `secrets:` yaml field instead of templating.
- Host env vars (`process.env`) are **not** in scope — they will never leak into a template.

---

## Plugin contract: declare your requirements

When a plugin spec references `pipeline.metadata.X` or `pipeline.vars.Y`, it **must declare that dependency** so pipelines using the plugin are rejected if they don't supply the key.

```yaml
name: kubectl-deploy
version: 2.0.0
pluginType: CodeBuildStep
computeType: SMALL

# Contract — pipelines using this plugin must set these metadata keys
requiredMetadata: [env, namespace, clusterName, region]
requiredVars: []

env:
  KUBECONFIG: /tmp/{{ pipeline.metadata.env }}-kubeconfig
installCommands:
  - "aws eks update-kubeconfig --name {{ pipeline.metadata.clusterName }} --region {{ pipeline.metadata.region }}"
commands:
  - "kubectl apply -f k8s/{{ pipeline.metadata.env }}/ -n {{ pipeline.metadata.namespace }}"
```

If a template uses `| default: '...'`, the key is treated as **optional** and can be omitted from `requiredMetadata` / `requiredVars`.

---

## Example: pipeline-level self-references

```json
{
  "id": "bb234ff6-8b2e-41e3-9758-fb23b63916cd",
  "projectName": "{{ vars.service }}-{{ metadata.env }}",
  "orgId": "acmecorp",
  "metadata": {
    "env": "prod",
    "region": "us-east-1",
    "clusterName": "acme-eks-{{ metadata.env }}",
    "namespace": "{{ vars.service }}-{{ metadata.env }}"
  },
  "vars": {
    "service": "checkout",
    "branch": "main",
    "slackChannel": "#deploys-{{ metadata.env }}"
  },
  "stages": [
    { "name": "deploy", "plugins": ["kubectl-deploy", "slack-notify"] }
  ]
}
```

After pass-1 resolution, the pipeline looks like:

```json
{
  "projectName": "checkout-prod",
  "metadata": {
    "env": "prod",
    "region": "us-east-1",
    "clusterName": "acme-eks-prod",
    "namespace": "checkout-prod"
  },
  "vars": {
    "service": "checkout",
    "branch": "main",
    "slackChannel": "#deploys-prod"
  }
}
```

Cycles are detected and rejected at upload time:

```
POST /api/pipelines  →  400 TEMPLATE_VALIDATION_FAILED

Pipeline has circular template references:
  • Template cycle detected: metadata.a -> metadata.b -> metadata.a
```

---

## Example: plugin spec with `pipeline.*` interpolation

Before templates — hardcoded per environment:

```yaml
# plugins/deployment/kubectl-deploy-prod/plugin-spec.yaml
name: kubectl-deploy-prod
commands:
  - "kubectl apply -f k8s/prod/ -n checkout-prod"
  - "kubectl scale deployment checkout --replicas=3 -n checkout-prod"
```

After templates — one plugin serves N environments:

```yaml
# plugins/deployment/kubectl-deploy/plugin-spec.yaml
name: kubectl-deploy
version: 2.0.0
pluginType: CodeBuildStep
computeType: SMALL

requiredMetadata: [env, namespace, replicas]
requiredVars: []

env:
  NAMESPACE: "{{ pipeline.metadata.namespace }}"
installCommands:
  - "kubectl config use-context {{ pipeline.metadata.env }}"
commands:
  - "kubectl apply -f k8s/{{ pipeline.metadata.env }}/ -n {{ env.NAMESPACE }}"
  - "kubectl scale deployment {{ pipeline.projectName }} --replicas={{ pipeline.metadata.replicas | default: '1' }} -n {{ env.NAMESPACE }}"
```

---

## Example: notification plugin

```yaml
# plugins/notification/slack-notify/plugin-spec.yaml
name: slack-notify
version: 2.0.0
pluginType: CodeBuildStep
computeType: SMALL

requiredMetadata: [env]
requiredVars: [slackChannel]

secrets:
  - name: SLACK_WEBHOOK_URL
    required: true

commands:
  - |
    curl -X POST "$SLACK_WEBHOOK_URL" \
      -H 'Content-Type: application/json' \
      -d '{
        "channel": "{{ pipeline.vars.slackChannel }}",
        "text": "✅ {{ pipeline.projectName }} deployed to {{ pipeline.metadata.env }} from {{ pipeline.vars.branch | default: 'unknown' }}"
      }'
```

---

## Example: build plugin with buildArgs

```yaml
# plugins/artifact/docker-build-push/plugin-spec.yaml
name: docker-build-push
version: 2.0.0
pluginType: CodeBuildStep
computeType: MEDIUM

requiredMetadata: [region, ecrRepoName]
requiredVars: []

buildArgs:
  BUILD_ENV: "{{ pipeline.metadata.env | default: 'staging' }}"
  COMMIT_SHA: "$CODEBUILD_RESOLVED_SOURCE_VERSION"   # literal — runtime var

commands:
  - "aws ecr get-login-password --region {{ pipeline.metadata.region }} | docker login --password-stdin {{ pipeline.orgId }}.dkr.ecr.{{ pipeline.metadata.region }}.amazonaws.com"
  - "docker build --build-arg BUILD_ENV=$BUILD_ENV -t {{ pipeline.metadata.ecrRepoName }}:$COMMIT_SHA ."
  - "docker push {{ pipeline.metadata.ecrRepoName }}:$COMMIT_SHA"
```

Note the mix: `{{ ... }}` is resolved **at synth time**, while `$CODEBUILD_*` variables stay literal and are evaluated **at runtime** by the shell.

---

## Filters

### `| default: '...'` — fallback value

Use `| default: '...'` to supply a fallback when a scope path is undefined or empty:

```yaml
commands:
  - "kubectl scale deployment {{ pipeline.projectName }} --replicas={{ pipeline.metadata.replicas | default: '1' }}"
  - "curl -s https://api.example.com/{{ pipeline.metadata.endpoint | default: 'v1/health' }}"
```

- Default value must be a **single-** or **double-quoted string**.
- Backslash-escape `\\`, `\'`, `\"` are supported inside the quoted default.
- When the template uses `| default:`, the referenced key does **not** need to appear in `requiredMetadata` / `requiredVars`.

### `| number`, `| bool`, `| json` — type coercion

Coercion filters turn the resolved text into a native value, but **only when the template is the entire field** (no surrounding literal text):

```yaml
# Whole-field template — produces native types
metadata:
  replicas:  "{{ vars.count | number }}"        # → 3 (number)
  isProd:    "{{ vars.env | bool }}"             # → true
  features:  "{{ vars.featureJson | json }}"     # → parsed JSON

# Mixed with literal text — stays a string (the filter is ignored)
env:
  MSG: "count={{ vars.count | number }}"         # → "count=3" (string)
```

Coercion rules:

| Filter | Accepts | Produces |
|---|---|---|
| `\| number` | Any string Number() can parse | `number` |
| `\| bool` | `true / false / 1 / 0 / yes / no / ""` (case-insensitive) | `boolean` |
| `\| json` | Any valid JSON string | `string \| number \| bool \| null \| object \| array` |

Coercion filters can chain with `default`:

```yaml
replicas: "{{ vars.replicas | default: '1' | number }}"   # → 1 (number) if vars.replicas missing
```

Unparseable values (e.g. `"abc" | number`) throw `TEMPLATE_TYPE_MISMATCH` at synth time.

---

## CLI tools

### Preview resolved output

```bash
# Print what the pipeline will look like after resolution (no CDK deploy)
pipeline-manager deploy --id <uuid> --show-resolved
pipeline-manager synth  --id <uuid> --show-resolved
```

### Validate templates without uploading

```bash
# Validate a local plugin-spec.yaml before upload
pipeline-manager validate-templates --file ./plugin-spec.yaml

# Validate a pipeline by ID against the platform
pipeline-manager validate-templates --pipeline <uuid>

# Validate a published plugin
pipeline-manager validate-templates --plugin kubectl-deploy:2.0.0
```

---

## Frontend editor integration

The dashboard editor understands `{{ ... }}` tokens:

- **Metadata value fields** show a template-count hint below the input while you type:  
  _"Contains 2 template tokens — resolved at synth time"_
- **Parse errors** surface inline under the field with the source position:  
  _"Expected '}}' at line 1, col 10"_
- **`TemplateText` + `TemplateInput` components** are exported from `@/components/ui/` and can be dropped into any screen to render templates as inline chips with hover tooltips (path, default, coercion, resolved preview).
- **`useTemplateValidation(source, scope?)` hook** returns `{ valid, tokens, error, resolved }` for custom editors.

No rich editor, no auto-escape — what you type is saved verbatim. Template resolution is a server-side concern; the client only parses for diagnostics + preview.

---

## API: `?resolve=true`

Pipeline read endpoints return the **source** by default (with `{{ ... }}` intact) so editors can round-trip. Pass `?resolve=true` to get the resolved form.

```http
GET /api/pipelines/{id}            # source form (for editing)
GET /api/pipelines/{id}?resolve=true  # resolved form (for preview/inspection)
```

---

## Error catalog

All template errors map to HTTP `400` with one of these codes:

| Code | Meaning |
|---|---|
| `TEMPLATE_PARSE_ERROR` | Malformed `{{ ... }}` — bad syntax, missing `}}`, unknown filter |
| `TEMPLATE_UNKNOWN_PATH` | Path references an unknown scope root (e.g. `{{ foo.bar }}`) |
| `TEMPLATE_CYCLE` | Self-referencing pipeline has a cycle across metadata/vars fields |
| `TEMPLATE_TYPE_MISMATCH` | Path resolved to an object where a scalar was expected |
| `TEMPLATE_SECRETS_RESERVED` | Reserved `secrets.*` path — use the plugin's `secrets:` yaml field instead |
| `TEMPLATE_CONTRACT_VIOLATION` | Pipeline is missing a key declared in a referenced plugin's `requiredMetadata` / `requiredVars` |
| `TEMPLATE_SIZE_EXCEEDED` | Field exceeded 4 KiB or path depth exceeded 5 |
| `TEMPLATE_VALIDATION_FAILED` | Batched umbrella — one or more of the above present in a single doc |

Every error includes `field`, `line`, `col` (when applicable), and the exact `path` or `cycle` that triggered it.

---

## What's **not** supported (by design)

- **Conditionals** / `if-else` — prefer separate plugins or a thin shell wrapper
- **Loops** — use a single plugin spec that iterates at runtime in its `commands:`
- **Math / string manipulation filters** — keep composition in shell, not templates
- **Runtime templating** — `{{ ... }}` is resolved once at synth time, never again
- **Dockerfile templating** — Dockerfiles are COPY'd verbatim; parameterize via `buildArgs:`
- **Templating `secrets:`, `name:`, `version:`, `pluginType:`** — identity/security-sensitive fields are literal-only
- **Recursive resolution** — resolved values are never re-scanned for `{{ ... }}` tokens (prevents template-injection through user-supplied metadata)

---

## Migrating an existing plugin

Adopting templates on a legacy plugin is backward-compatible when you use `| default:`:

### 1. Add the contract block

```yaml
# plugin-spec.yaml
requiredMetadata: []   # pipeline.metadata keys you require (empty if all optional)
requiredVars: []
metadataTypes:         # type hints enable coercion safety
  replicas: number
  isProd: bool
varsTypes:
  branch: string
```

### 2. Replace hardcoded env defaults with templates

Before:
```yaml
env:
  KUBE_NAMESPACE: default
  ROLLOUT_TIMEOUT: "300s"
```

After:
```yaml
env:
  KUBE_NAMESPACE: "{{ pipeline.metadata.namespace | default: 'default' }}"
  ROLLOUT_TIMEOUT: "{{ pipeline.metadata.rolloutTimeoutSeconds | default: '300' }}s"
```

### 3. Bump the plugin version

Minor bump (e.g. `1.0.0 → 1.1.0`) so pipelines can pin the pre-template version if needed.

### Reference conversions in this repo

Five production plugins now show the pattern:

| Plugin | Metadata keys used |
|---|---|
| [notification/slack-notify](../deploy/plugins/notification/slack-notify/plugin-spec.yaml) | `env`, `vars.branch`, `vars.slackChannel`, `projectName` |
| [notification/teams-notify](../deploy/plugins/notification/teams-notify/plugin-spec.yaml) | `env`, `vars.branch`, `projectName` |
| [deploy/kubectl-deploy](../deploy/plugins/deploy/kubectl-deploy/plugin-spec.yaml) | `context`, `namespace`, `manifestPath`, `rolloutTimeoutSeconds` |
| [deploy/helm-deploy](../deploy/plugins/deploy/helm-deploy/plugin-spec.yaml) | `namespace`, `helmRelease`, `helmChart`, `helmTimeoutSeconds` |
| [deploy/ecs-deploy](../deploy/plugins/deploy/ecs-deploy/plugin-spec.yaml) | `ecsCluster`, `ecsService`, `imageUri`, `ecsTaskFamily` |

All pipelines continue to work unchanged; when they start supplying metadata keys, the plugin auto-populates the env vars.

---

## Troubleshooting

**"Template references unknown scope root 'foo'"**  
→ Only `pipeline`, `plugin`, `env` (for plugins) and `metadata`, `vars` (for pipelines) are accepted scope roots.

**"'secrets' is a reserved scope"**  
→ Move secret references into the plugin's top-level `secrets:` yaml field. Secrets Manager handles the injection as env vars.

**"Plugin spec uses template paths not declared in contract"**  
→ Add the missing key to your plugin's `requiredMetadata:` or `requiredVars:` list, or use `| default: '...'` to make it optional.

**"Template cycle detected"**  
→ One of your `metadata.*` or `vars.*` fields references another that references back to the first. The error message includes the full cycle chain.

**`{{ ... }}` still visible in my CodeBuild logs**  
→ The plugin was loaded without `pipelineScope` — this happens only in legacy direct-invocation paths. The platform-managed synth flow always passes scope.

---

**Related docs:** [Metadata Keys](metadata-keys.md) | [CDK Usage](cdk-usage.md) | [Plugin Catalog](plugins/README.md) | [API Reference](api-reference.md)
