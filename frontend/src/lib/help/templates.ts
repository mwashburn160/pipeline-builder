// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Braces } from 'lucide-react';
import type { HelpTopic } from './types';

export const templatesTopic: HelpTopic = {
  id: 'templates',
  title: 'Templates',
  description: 'Synth-time {{ … }} templating for pipelines and plugins',
  icon: Braces,
  sections: [
    {
      id: 'overview',
      title: 'Overview',
      blocks: [
        {
          type: 'text',
          content:
            'Pipeline Builder supports a minimal {{ path.to.value }} template syntax in both pipeline configs (pipeline.json) and plugin specs (plugin-spec.yaml). Templates are resolved once, at synthesis time, against a fixed scope — there is no runtime evaluation and no code execution.',
        },
        {
          type: 'list',
          items: [
            'One plugin, many environments — parameterize namespaces, regions, and cluster names via pipeline.metadata.*',
            'One pipeline template, many deployments — compose names and vars via self-references',
            'Zero-config backward compatibility — specs without {{ … }} tokens are unchanged',
          ],
        },
      ],
    },
    {
      id: 'grammar',
      title: 'Grammar',
      blocks: [
        {
          type: 'code',
          content: `Template   := (Literal | Expr)*
Expr       := "{{" ws Path (ws Filter)? ws "}}"
Path       := Identifier ("." Identifier)*
Identifier := [a-zA-Z_][a-zA-Z0-9_]{0,63}
Filter     := "|" ws "default" ws ":" ws Quoted`,
        },
        {
          type: 'list',
          items: [
            'Escape a literal {{ as {{{{ (doubled).',
            'Max path depth: 5 identifiers.',
            'Max templated-field size: 4 KiB.',
            'Supported filters: | default: \'…\', | number, | bool, | json.',
            'default may appear once; at most one coercion filter per expression.',
          ],
        },
      ],
    },
    {
      id: 'scope',
      title: 'Scope Reference',
      blocks: [
        {
          type: 'text',
          content:
            'Pipeline configs can only self-reference — one metadata key can interpolate another, or reference a vars key. Templatable fields: projectName, metadata.* and vars.* string values. Identity fields (id, orgId, stages, plugins[]) are not templatable.',
        },
        {
          type: 'table',
          headers: ['Pipeline scope root', 'Available inside'],
          rows: [
            ['metadata.*', 'Any other metadata key in the same pipeline'],
            ['vars.*', 'Any vars key in the same pipeline'],
          ],
        },
        {
          type: 'text',
          content:
            'Plugin specs see a richer scope assembled per-synth from the invoking pipeline. Templatable fields: description, commands[], installCommands[], env.* values, buildArgs.* values. Identity/security fields (name, version, pluginType, computeType, timeout, secrets, failureBehavior) are not templatable.',
        },
        {
          type: 'table',
          headers: ['Plugin scope root', 'Available inside'],
          rows: [
            ['pipeline.projectName', "String — the pipeline's project name"],
            ['pipeline.orgId', 'String — org UUID'],
            ['pipeline.metadata.*', "Any key on the pipeline's metadata object"],
            ['pipeline.vars.*', "Any key on the pipeline's vars object"],
            ['plugin.name / plugin.version', 'Plugin record fields'],
            ['env.FOO', "Any key declared in the same plugin's env: map"],
          ],
        },
        {
          type: 'note',
          content:
            'secrets.* is reserved — use the plugin\'s secrets: yaml field instead. Host env vars (process.env) are never in scope and will never leak into a template.',
        },
      ],
    },
    {
      id: 'contract',
      title: 'Plugin Contract',
      blocks: [
        {
          type: 'text',
          content:
            'When a plugin spec references pipeline.metadata.X or pipeline.vars.Y, it must declare that dependency so pipelines that omit the key are rejected. If a template uses | default: \'…\', the key is optional and may be omitted from the contract.',
        },
        {
          type: 'code',
          language: 'yaml',
          content: `name: kubectl-deploy
version: 2.0.0
pluginType: CodeBuildStep
computeType: SMALL

# Contract — pipelines using this plugin must set these metadata keys
requiredMetadata: [env, namespace, clusterName, region]
requiredVars: []

env:
  KUBECONFIG: /tmp/{{ pipeline.metadata.env }}-kubeconfig
commands:
  - "kubectl apply -f k8s/{{ pipeline.metadata.env }}/ -n {{ pipeline.metadata.namespace }}"`,
        },
      ],
    },
    {
      id: 'examples',
      title: 'Examples',
      blocks: [
        {
          type: 'text',
          content:
            'Pipeline-level self-references — metadata and vars keys interpolate one another. After pass-1 resolution, projectName becomes "checkout-prod" and clusterName becomes "acme-eks-prod".',
        },
        {
          type: 'code',
          language: 'json',
          content: `{
  "projectName": "{{ vars.service }}-{{ metadata.env }}",
  "metadata": {
    "env": "prod",
    "clusterName": "acme-eks-{{ metadata.env }}",
    "namespace": "{{ vars.service }}-{{ metadata.env }}"
  },
  "vars": {
    "service": "checkout",
    "slackChannel": "#deploys-{{ metadata.env }}"
  }
}`,
        },
        {
          type: 'text',
          content:
            'Plugin spec with pipeline.* interpolation — one plugin serves N environments. Note the mix of {{ … }} (resolved at synth time) and $CODEBUILD_* shell vars (evaluated at runtime).',
        },
        {
          type: 'code',
          language: 'yaml',
          content: `env:
  NAMESPACE: "{{ pipeline.metadata.namespace }}"
commands:
  - "kubectl apply -f k8s/{{ pipeline.metadata.env }}/ -n {{ env.NAMESPACE }}"
  - "kubectl scale deployment {{ pipeline.projectName }} --replicas={{ pipeline.metadata.replicas | default: '1' }} -n {{ env.NAMESPACE }}"`,
        },
        {
          type: 'warning',
          content:
            'Cycles are detected and rejected at upload time: POST /api/pipelines → 400 TEMPLATE_VALIDATION_FAILED ("Template cycle detected: metadata.a -> metadata.b -> metadata.a").',
        },
      ],
    },
    {
      id: 'filters',
      title: 'Filters',
      blocks: [
        {
          type: 'text',
          content:
            'Use | default: \'…\' to supply a fallback when a scope path is undefined or empty. The default must be a single- or double-quoted string, and the referenced key then does not need to appear in the contract.',
        },
        {
          type: 'code',
          language: 'yaml',
          content: `commands:
  - "kubectl scale deployment {{ pipeline.projectName }} --replicas={{ pipeline.metadata.replicas | default: '1' }}"
  - "curl -s https://api.example.com/{{ pipeline.metadata.endpoint | default: 'v1/health' }}"`,
        },
        {
          type: 'text',
          content:
            'Coercion filters turn resolved text into a native value, but only when the template is the entire field (no surrounding literal text). Mixed with literal text, the field stays a string and the filter is ignored.',
        },
        {
          type: 'table',
          headers: ['Filter', 'Accepts', 'Produces'],
          rows: [
            ['| number', 'Any string Number() can parse', 'number'],
            ['| bool', 'true / false / 1 / 0 / yes / no / "" (case-insensitive)', 'boolean'],
            ['| json', 'Any valid JSON string', 'string | number | bool | null | object | array'],
          ],
        },
        {
          type: 'code',
          language: 'yaml',
          content: `# Whole-field template — produces native types
metadata:
  replicas: "{{ vars.count | number }}"              # → 3 (number)
# Chained with default
  replicas: "{{ vars.replicas | default: '1' | number }}"  # → 1 if missing`,
        },
        {
          type: 'note',
          content:
            'Unparseable values (e.g. "abc" | number) throw TEMPLATE_TYPE_MISMATCH at synth time.',
        },
      ],
    },
    {
      id: 'tooling',
      title: 'CLI & API Tooling',
      blocks: [
        {
          type: 'code',
          language: 'bash',
          content: `# Preview resolved output without deploying
pipeline-manager deploy --id <uuid> --show-resolved
pipeline-manager synth  --id <uuid> --show-resolved

# Validate templates before upload
pipeline-manager validate-templates --file ./plugin-spec.yaml
pipeline-manager validate-templates --pipeline <uuid>
pipeline-manager validate-templates --plugin kubectl-deploy:2.0.0`,
        },
        {
          type: 'text',
          content:
            'Pipeline read endpoints return the source form by default (with {{ … }} intact) so editors can round-trip. Pass ?resolve=true to get the resolved form for preview or inspection.',
        },
        {
          type: 'code',
          content: `GET /api/pipelines/{id}                # source form (for editing)
GET /api/pipelines/{id}?resolve=true   # resolved form (for preview)`,
        },
        {
          type: 'note',
          content:
            'The dashboard editor parses {{ … }} tokens client-side for diagnostics (template-count hints, inline parse errors with line/col). The useTemplateValidation(source, scope?) hook returns { valid, tokens, hasTemplates, error, errorPos, resolved, resolveError }. Resolution itself is always server-side.',
        },
      ],
    },
    {
      id: 'errors',
      title: 'Errors & Limits',
      blocks: [
        {
          type: 'text',
          content:
            'All template errors map to HTTP 400. Each error includes field, line, col (when applicable), and the exact path or cycle that triggered it.',
        },
        {
          type: 'table',
          headers: ['Code', 'Meaning'],
          rows: [
            ['TEMPLATE_PARSE_ERROR', 'Malformed {{ … }} — bad syntax, missing }}, unknown filter'],
            ['TEMPLATE_UNKNOWN_PATH', 'Path references an unknown scope root'],
            ['TEMPLATE_CYCLE', 'Self-referencing pipeline has a cycle across metadata/vars'],
            ['TEMPLATE_TYPE_MISMATCH', 'Path resolved to an object where a scalar was expected'],
            ['TEMPLATE_SECRETS_RESERVED', 'Reserved secrets.* path — use the secrets: yaml field'],
            ['TEMPLATE_CONTRACT_VIOLATION', 'Pipeline missing a key declared in a plugin contract'],
            ['TEMPLATE_SIZE_EXCEEDED', 'Field exceeded 4 KiB or path depth exceeded 5'],
            ['TEMPLATE_VALIDATION_FAILED', 'Batched umbrella — one or more of the above in a single doc'],
          ],
        },
        {
          type: 'warning',
          content:
            'Not supported by design: conditionals/if-else, loops, math/string filters, runtime templating, Dockerfile templating, and templating identity/security fields. Resolved values are never re-scanned for {{ … }} tokens, preventing template injection through user-supplied metadata.',
        },
      ],
    },
  ],
};
