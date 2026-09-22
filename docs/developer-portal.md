---
layout: default
title: Developer Portal
image: /assets/og-image-solution.png
---

# Developer Portal

Pipeline Builder is a self-service internal developer platform. Beyond creating pipelines, it gives developers a **catalog** of the things they own, **golden-path templates** to start from, and a per-pipeline **maturity scorecard** — the building blocks of a Backstage/Port-style portal, backed by the platform's existing RBAC, compliance, and DORA machinery.

## Catalog ownership & metadata

Every **pipeline** and **plugin** carries developer-portal catalog metadata, so resources are discoverable and attributable rather than anonymous rows:

| Field | Meaning |
|-------|---------|
| `ownerId` / `ownerType` | Who owns the resource — a `user` or a `team`. **Defaults to the creator** at creation time, so nothing is ownerless. |
| `lifecycle` | `experimental` \| `production` \| `deprecated` (defaults to `production`). |
| `criticality` | Optional `low` \| `medium` \| `high` \| `critical`. |
| `labels` | Free-form typed classification, e.g. `{ team: "payments", tier: "gold" }`. |
| `links` | Titled external links (docs, dashboards, runbooks). |

List endpoints (`GET /pipelines`, `GET /plugins`) accept `ownerId` and `lifecycle` filters, and the metadata is editable through the normal update endpoints. Owner is **preserved** across a re-create/re-upload — it is never silently transferred to whoever re-ran the action.

### My Services

The **My Services** page (dashboard → Overview → *My Services*) lists the pipelines and plugins the current user owns across the org catalog, with lifecycle badges and a lifecycle filter — a personal "what do I own?" view keyed off `ownerId`.

### Cross-resource search

The command palette (**⌘K**) searches actual resources — pipelines and plugins by name/keywords — not just page names, so you can jump straight to a resource without knowing which page it lives on.

### Plugin catalog: listings and installs

The plugins a developer can use are the org's **own plugins** plus the ecosystem **listings** the org has installed. The in-app catalog (dashboard → Plugins) shows every listing with the org's install state: installed or not, the version a new synth resolves to, whether installing needs approval, and whether the org's consumption policy blocks it. Official listings (publisher `pipeline-builder`) count as installed for every org through the implicit install. See [Plugin Installing](plugin-installing.md). Each listing also shows a 0–100 **health score** (runtime success, vulnerabilities, freshness, signing, smoke test, docs and rating); see [Health score](plugin-installing.md#health-score).

**Shadowing warning.** An own-org plugin with the same name as an Official listing wins for unqualified references (`plugin: { name: trivy }`). The Plugins page flags that plugin, the pipeline editor flags each step that uses it, and lookup warns `PLUGIN_SHADOWS_LISTING`. `GET /api/plugins/shadowing` lists every shadowed name. Add `publisher: pipeline-builder` to a step to use the listing instead.

## Golden-path templates

A **pipeline template** is a parameterized starter: its body is a `BuilderProps` with `{{ vars.* }}` placeholders, and it declares the `inputs` a developer fills in to instantiate it. System-org **public** templates form a shared golden-path catalog visible to every org (the same sharing model as the sample template catalog and compliance rule templates); org-private templates are visible only to their org.

**Instantiate flow** (dashboard → Build → *Templates* → *Use template*):

1. Pick a template and fill its declared inputs (typed `string` / `number` / `boolean`, with optional defaults and fixed choice `options`).
2. The server renders the template into a concrete pipeline `props` — the supplied inputs are baked into `props.vars`; the `{{ vars.* }}` placeholders resolve at synth time like any pipeline var.
3. The resolved props flow through the **normal pipeline-create path**, so compliance validation and quota still apply — a template can't bypass governance.

### API

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/pipeline-templates` | List the catalog you can see — your org's shared templates, your own private drafts, and the system-org catalog. Paginated/filterable (incl. `visibility`). |
| `GET` | `/pipeline-templates/{id}` | Fetch a template. |
| `POST` | `/pipeline-templates/{id}/instantiate` | Render → `{ props, description, keywords }`. Body: `{ project, organization, pipelineName?, inputs }`. |
| `POST` | `/pipeline-templates` | Author a template (`templates:write`). Defaults to `visibility: private`; `org` shares it org-wide, `public` needs `templates:publish`. |
| `PUT` / `DELETE` | `/pipeline-templates/{id}` | Update / soft-delete (`templates:write`, plus `templates:publish` for a `public` template and authorship for a `private` one). |

## Maturity scorecards

Each pipeline has a **maturity scorecard** — a single 0–100 score and an A–F grade that blends two dimensions the platform already computes:

- **Compliance posture** — the pipeline is dry-run against the org's compliance rules; the score is the pass ratio (a warning counts as half a violation).
- **Delivery performance** — the four per-pipeline **DORA** bands (deployment frequency, change-failure rate, time-to-restore, measured lead time) over the trailing 30 days, mapped Elite→Low to points.

The two dimensions are weighted 50/50; either is independently nullable, so a pipeline with no rules or no run history scores on whichever dimension has data. The scorecard surfaces as a card on the pipeline detail page.

```
GET /pipelines/{id}/scorecard      # requires the `advanced_reporting` feature
```

Response (abridged):

```json
{
  "scorecard": {
    "pipelineId": "…",
    "score": 82,
    "grade": "B",
    "compliance": { "score": 90, "rulesEvaluated": 10, "violations": 1, "warnings": 0 },
    "dora": { "score": 74, "basis": "run", "deploymentFrequency": "high", "changeFailureRate": "high",
              "meanTimeToRestore": "medium", "leadTime": "high" },
    "computedAt": "…"
  }
}
```

Scorecards are gated by **Advanced Reporting** (Enterprise, or the Advanced Reporting add-on) — the same feature that gates DORA — and the card is hidden when it is off. Lead time is measured commit→deploy when the forwarder is deployed with `--with-dora`, and `unknown` otherwise; see [DORA Metrics](dora-metrics.md#how-each-metric-is-defined).
