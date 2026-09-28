// GENERATED FROM docs/developer-portal.md — DO NOT EDIT.
// Regenerate: npm run generate:help  (see frontend/scripts/generate-help.mjs)
// SOURCE-SHA256: 2089b9c34a629f32c60161602d1e41be9c979fea553655f197897c14a5744649
// SPDX-License-Identifier: Apache-2.0
import { LayoutDashboard } from 'lucide-react';
import type { HelpTopic } from '../types';

export const developerPortalTopic: HelpTopic = {
  "icon": LayoutDashboard,
  "id": "developer-portal",
  "title": "Developer Portal",
  "description": "Catalog ownership, My Services, golden-path templates, maturity scorecards",
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
          "content": "Pipeline Builder is a self-service internal developer platform. Beyond creating pipelines, it gives developers a catalog of what they own, golden-path templates to start from, and a per-pipeline maturity scorecard."
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
            "Nothing is ownerless. Every pipeline and plugin carries catalog metadata, and ownerId defaults to the creator.",
            "Ownership survives a re-create. It is never silently transferred to whoever re-ran the action.",
            "Templates can't bypass governance. An instantiated template flows through the normal pipeline-create path, so compliance and quota still apply.",
            "Scorecards reuse machinery you already have — compliance dry-run plus the four DORA bands, weighted 50/50.",
            "Either scorecard dimension is independently nullable, so a pipeline with no rules or no run history still scores on whichever has data.",
            "Watch for shadowing. An own-org plugin with the same name as an Official listing wins for unqualified references; the UI flags it in three places."
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
          "content": "These are the building blocks of a Backstage- or Port-style portal, backed by the platform's existing RBAC, compliance and DORA machinery rather than a parallel system:"
        },
        {
          "type": "table",
          "headers": [
            "Building block",
            "Answers"
          ],
          "rows": [
            [
              "Catalog ownership",
              "Who owns this, how mature is it, where are its runbooks?"
            ],
            [
              "Golden-path templates",
              "How do I start a new pipeline the way we want it done?"
            ],
            [
              "Maturity scorecards",
              "Is this pipeline actually in good shape?"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Written for developers and platform teams using the dashboard. Template syntax is covered in Template Syntax; the metric definitions behind the scorecard are in DORA Metrics."
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
            "Resources carry catalog metadata from birth. On create, ownerId/ownerType default to the creator and lifecycle defaults to production, so the catalog is populated without anyone curating it.",
            "Discovery reads that metadata. List endpoints filter on ownerId and lifecycle; My Services is a view keyed off ownerId; the command palette searches real resources by name and keywords.",
            "A template is a parameterized BuilderProps with {{ vars.* }} placeholders plus a declaration of the inputs a developer fills in.",
            "Instantiating renders, then goes through the front door. The server bakes supplied inputs into props.vars and hands the resolved props to the normal pipeline-create path — compliance validation and quota apply exactly as they would to a hand-written pipeline.",
            "A scorecard blends two existing signals. The pipeline is dry-run against the org's compliance rules (pass ratio, a warning counting as half a violation) and its trailing-30-day DORA bands are mapped Elite→Low to points. The two are weighted 50/50 into one 0–100 score and an A–F grade."
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
            "Enable Advanced Reporting to expose scorecards. They are gated by the advanced_reporting feature — Enterprise, or the Advanced Reporting add-on — the same feature that gates DORA. With it off, the card is hidden.",
            "Deploy the forwarder with --with-dora if you want measured lead time. Without it, lead time reports unknown and the DORA half of the score is computed from the remaining bands. See DORA Metrics.",
            "Decide template visibility. New templates default to visibility: private. org shares one org-wide; public puts it in the shared golden-path catalog and requires templates:publish.",
            "Grant the template permissions you intend: templates:write to author, templates:publish to publish org-wide golden paths.",
            "Audit for shadowing before rolling out the ecosystem catalog: GET /api/plugins/shadowing lists every own-org plugin name that shadows a listing."
          ]
        }
      ]
    },
    {
      "id": "catalog-ownership-and-metadata",
      "title": "Catalog ownership and metadata",
      "blocks": [
        {
          "type": "text",
          "content": "Every pipeline and plugin carries developer-portal catalog metadata, so resources are discoverable and attributable rather than anonymous rows:"
        },
        {
          "type": "table",
          "headers": [
            "Field",
            "Meaning"
          ],
          "rows": [
            [
              "ownerId / ownerType",
              "Who owns the resource — a user or a team. Defaults to the creator at creation time, so nothing is ownerless."
            ],
            [
              "lifecycle",
              "experimental \\",
              "production \\",
              "deprecated (defaults to production)."
            ],
            [
              "criticality",
              "Optional low \\",
              "medium \\",
              "high \\",
              "critical."
            ],
            [
              "labels",
              "Free-form typed classification, e.g. { team: \"payments\", tier: \"gold\" }."
            ],
            [
              "links",
              "Titled external links (docs, dashboards, runbooks)."
            ]
          ]
        },
        {
          "type": "text",
          "content": "List endpoints (GET /pipelines, GET /plugins) accept ownerId and lifecycle filters, and the metadata is editable through the normal update endpoints. Owner is preserved across a re-create/re-upload — it is never silently transferred to whoever re-ran the action."
        },
        {
          "type": "text",
          "content": "My Services"
        },
        {
          "type": "text",
          "content": "The My Services page (dashboard → Overview → My Services) lists the pipelines and plugins the current user owns across the org catalog, with lifecycle badges and a lifecycle filter — a personal \"what do I own?\" view keyed off ownerId."
        },
        {
          "type": "text",
          "content": "Cross-resource search"
        },
        {
          "type": "text",
          "content": "The command palette (⌘K) searches actual resources — pipelines and plugins by name and keywords — not just page names, so you can jump straight to a resource without knowing which page it lives on."
        },
        {
          "type": "text",
          "content": "Plugin catalog: listings and installs"
        },
        {
          "type": "text",
          "content": "The plugins a developer can use are the org's own plugins plus the ecosystem listings the org has installed. The in-app catalog (dashboard → Plugins) shows every listing with the org's install state:"
        },
        {
          "type": "list",
          "items": [
            "installed or not",
            "the version a new synth resolves to",
            "whether installing needs approval",
            "whether the org's consumption policy blocks it"
          ]
        },
        {
          "type": "text",
          "content": "Official listings (publisher pipeline-builder) count as installed for every org through the implicit install. See Plugin Installing. Each listing also shows a 0–100 health score — runtime success, vulnerabilities, freshness, signing, smoke test, docs and rating; see Health score."
        },
        {
          "type": "text",
          "content": "Shadowing warning. An own-org plugin with the same name as an Official listing wins for unqualified references (plugin: { name: trivy }). The Plugins page flags that plugin, the pipeline editor flags each step that uses it, and lookup warns PLUGIN_SHADOWS_LISTING. GET /api/plugins/shadowing lists every shadowed name. Add publisher: pipeline-builder to a step to use the listing instead."
        }
      ]
    },
    {
      "id": "golden-path-templates",
      "title": "Golden-path templates",
      "blocks": [
        {
          "type": "text",
          "content": "A pipeline template is a parameterized starter: its body is a BuilderProps with {{ vars.* }} placeholders, and it declares the inputs a developer fills in to instantiate it."
        },
        {
          "type": "text",
          "content": "System-org public templates form a shared golden-path catalog visible to every org — the same sharing model as the sample template catalog and compliance rule templates. Org-private templates are visible only to their org."
        },
        {
          "type": "text",
          "content": "Instantiate flow"
        },
        {
          "type": "text",
          "content": "Dashboard → Build → Templates → Use template:"
        },
        {
          "type": "list",
          "items": [
            "Pick a template and fill its declared inputs — typed string / number / boolean, with optional defaults and fixed choice options.",
            "The server renders the template into a concrete pipeline props. The supplied inputs are baked into props.vars; the {{ vars.* }} placeholders resolve at synth time like any pipeline var.",
            "The resolved props flow through the normal pipeline-create path, so compliance validation and quota still apply — a template can't bypass governance."
          ]
        },
        {
          "type": "text",
          "content": "API"
        },
        {
          "type": "table",
          "headers": [
            "Method",
            "Path",
            "Notes"
          ],
          "rows": [
            [
              "GET",
              "/pipeline-templates",
              "List the catalog you can see — your org's shared templates, your own private drafts, and the system-org catalog. Paginated/filterable (incl. visibility)."
            ],
            [
              "GET",
              "/pipeline-templates/{id}",
              "Fetch a template."
            ],
            [
              "POST",
              "/pipeline-templates/{id}/instantiate",
              "Render → { props, description, keywords }. Body: { project, organization, pipelineName?, inputs }."
            ],
            [
              "POST",
              "/pipeline-templates",
              "Author a template (templates:write). Defaults to visibility: private; org shares it org-wide, public needs templates:publish."
            ],
            [
              "PUT / DELETE",
              "/pipeline-templates/{id}",
              "Update / soft-delete (templates:write, plus templates:publish for a public template and authorship for a private one)."
            ]
          ]
        }
      ]
    },
    {
      "id": "maturity-scorecards",
      "title": "Maturity scorecards",
      "blocks": [
        {
          "type": "text",
          "content": "Each pipeline has a maturity scorecard — a single 0–100 score and an A–F grade that blends two dimensions the platform already computes:"
        },
        {
          "type": "table",
          "headers": [
            "Dimension",
            "How it scores"
          ],
          "rows": [
            [
              "Compliance posture",
              "The pipeline is dry-run against the org's compliance rules; the score is the pass ratio, with a warning counting as half a violation."
            ],
            [
              "Delivery performance",
              "The four per-pipeline DORA bands — deployment frequency, change-failure rate, time-to-restore, measured lead time — over the trailing 30 days, mapped Elite→Low to points."
            ]
          ]
        },
        {
          "type": "text",
          "content": "The two dimensions are weighted 50/50, and either is independently nullable, so a pipeline with no rules or no run history scores on whichever dimension has data. The scorecard surfaces as a card on the pipeline detail page."
        },
        {
          "type": "code",
          "content": "GET /pipelines/{id}/scorecard      # requires the `advanced_reporting` feature"
        },
        {
          "type": "text",
          "content": "Response (abridged):"
        },
        {
          "type": "code",
          "content": "{\n  \"scorecard\": {\n    \"pipelineId\": \"…\",\n    \"score\": 82,\n    \"grade\": \"B\",\n    \"compliance\": { \"score\": 90, \"rulesEvaluated\": 10, \"violations\": 1, \"warnings\": 0 },\n    \"dora\": { \"score\": 74, \"basis\": \"run\", \"deploymentFrequency\": \"high\", \"changeFailureRate\": \"high\",\n              \"meanTimeToRestore\": \"medium\", \"leadTime\": \"high\" },\n    \"computedAt\": \"…\"\n  }\n}",
          "language": "json"
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
            "Template Syntax — the {{ ... }} grammar templates are written in",
            "Plugin Installing — install state, consumption policy, health score",
            "DORA Metrics — the metric definitions behind the delivery half of the score",
            "Permissions — templates:write, templates:publish"
          ]
        }
      ]
    }
  ],
  "sourceDoc": "docs/developer-portal.md"
};
