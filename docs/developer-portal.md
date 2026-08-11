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

## Golden-path templates

A **pipeline template** is a parameterized starter: its body is a `BuilderProps` with `{{ vars.* }}` placeholders, and it declares the `inputs` a developer fills in to instantiate it. System-org **public** templates form a shared golden-path catalog visible to every org (the same sharing model as sample pipelines and compliance rule templates); org-private templates are visible only to their org.

**Instantiate flow** (dashboard → Build → *Templates* → *Use template*):

1. Pick a template and fill its declared inputs (typed `string` / `number` / `boolean`, with optional defaults and fixed choice `options`).
2. The server renders the template into a concrete pipeline `props` — the supplied inputs are baked into `props.vars`; the `{{ vars.* }}` placeholders resolve at synth time like any pipeline var.
3. The resolved props flow through the **normal pipeline-create path**, so compliance validation and quota still apply — a template can't bypass governance.

### API

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/pipeline-templates` | List the catalog (own-org + shared system-org), paginated/filterable. |
| `GET` | `/pipeline-templates/{id}` | Fetch a template. |
| `POST` | `/pipeline-templates/{id}/instantiate` | Render → `{ props, description, keywords }`. Body: `{ project, organization, pipelineName?, inputs }`. |
| `POST` | `/pipeline-templates` | Author a template (`pipelines:write`; `pipelines:publish` to make it public). |
| `PUT` / `DELETE` | `/pipeline-templates/{id}` | Update / soft-delete (`pipelines:write`). |

## Maturity scorecards

Each pipeline has a **maturity scorecard** — a single 0–100 score and an A–F grade that blends two dimensions the platform already computes:

- **Compliance posture** — the pipeline is dry-run against the org's compliance rules; the score is the pass ratio (a warning counts as half a violation).
- **Delivery performance** — the four per-pipeline **DORA** bands (deployment frequency, change-failure rate, time-to-restore, lead-time proxy) over the trailing 30 days, mapped Elite→Low to points.

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

Scorecards are gated by **Advanced Reporting** (Enterprise, or the Advanced Reporting add-on) — the same feature that gates DORA — and the card is hidden when it is off. Lead time remains an approximate run-time proxy (the event stream doesn't capture commit time); see [DORA Metrics](dora-metrics.md).
