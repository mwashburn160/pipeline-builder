// GENERATED FROM docs/developer-portal.md — DO NOT EDIT.
// Regenerate: npm run generate:help  (see frontend/scripts/generate-help.mjs)
// SOURCE-SHA256: dc6a488f1a90f644984798e62f147b04fa1afd9fd88c243b926139596ee1d4ed
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
          "content": "Pipeline Builder is a self-service internal developer platform. Beyond creating pipelines, it gives developers a catalog of the things they own, golden-path templates to start from, and a per-pipeline maturity scorecard — the building blocks of a Backstage/Port-style portal, backed by the platform's existing RBAC, compliance, and DORA machinery."
        }
      ]
    },
    {
      "id": "catalog-ownership-metadata",
      "title": "Catalog ownership & metadata",
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
          "content": "The command palette (⌘K) searches actual resources — pipelines and plugins by name/keywords — not just page names, so you can jump straight to a resource without knowing which page it lives on."
        }
      ]
    },
    {
      "id": "golden-path-templates",
      "title": "Golden-path templates",
      "blocks": [
        {
          "type": "text",
          "content": "A pipeline template is a parameterized starter: its body is a BuilderProps with {{ vars.* }} placeholders, and it declares the inputs a developer fills in to instantiate it. System-org public templates form a shared golden-path catalog visible to every org (the same sharing model as the sample template catalog and compliance rule templates); org-private templates are visible only to their org."
        },
        {
          "type": "text",
          "content": "Instantiate flow (dashboard → Build → Templates → Use template):"
        },
        {
          "type": "list",
          "items": [
            "Pick a template and fill its declared inputs (typed string / number / boolean, with optional defaults and fixed choice options).",
            "The server renders the template into a concrete pipeline props — the supplied inputs are baked into props.vars; the {{ vars.* }} placeholders resolve at synth time like any pipeline var.",
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
          "type": "list",
          "items": [
            "Compliance posture — the pipeline is dry-run against the org's compliance rules; the score is the pass ratio (a warning counts as half a violation).",
            "Delivery performance — the four per-pipeline DORA bands (deployment frequency, change-failure rate, time-to-restore, measured lead time) over the trailing 30 days, mapped Elite→Low to points."
          ]
        },
        {
          "type": "text",
          "content": "The two dimensions are weighted 50/50; either is independently nullable, so a pipeline with no rules or no run history scores on whichever dimension has data. The scorecard surfaces as a card on the pipeline detail page."
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
        },
        {
          "type": "text",
          "content": "Scorecards are gated by Advanced Reporting (Enterprise, or the Advanced Reporting add-on) — the same feature that gates DORA — and the card is hidden when it is off. Lead time is measured commit→deploy when the forwarder is deployed with --with-dora, and unknown otherwise; see DORA Metrics."
        }
      ]
    }
  ],
  "sourceDoc": "docs/developer-portal.md"
};
