---
layout: default
title: Developer Portal
image: /assets/og-image-solution.png
---

<!--
Copyright 2026 Pipeline Builder Contributors
SPDX-License-Identifier: Apache-2.0
-->

# Developer Portal

Pipeline Builder is a self-service internal developer platform. Beyond creating pipelines, it gives developers a **catalog** of what they own, **golden-path templates** to start from, and a per-pipeline **maturity scorecard**.

## Highlights

- **Nothing is ownerless.** Every pipeline and plugin carries catalog metadata, and `ownerId` defaults to the creator.
- **Ownership survives a re-create.** It is never silently transferred to whoever re-ran the action.
- **Templates can't bypass governance.** Instantiating only renders props; the pipeline is created through the normal pipeline-create path, so compliance and quota still apply.
- **Scorecards reuse machinery you already have** — compliance dry-run, the four DORA bands and the pipeline's open security findings, weighted 40/40/20 (50/50 when there is no security signal).
- **Every scorecard dimension is independently nullable**, so a pipeline with no rules, no deploy history or no security signal still scores on whichever has data.
- **Watch for shadowing.** An own-org plugin with the same name as an Official listing wins for unqualified references; the UI flags it in three places.

## Overview

These are the building blocks of a Backstage- or Port-style portal, backed by the platform's existing RBAC, compliance and DORA machinery rather than a parallel system:

| Building block | Answers |
|---|---|
| **Catalog ownership** | Who owns this, how mature is it, where are its runbooks? |
| **Golden-path templates** | How do I start a new pipeline the way we want it done? |
| **Maturity scorecards** | Is this pipeline actually in good shape? |

Written for developers and platform teams using the dashboard. Template *syntax* is covered in [Template Syntax](templates.md); the metric definitions behind the scorecard are in [DORA Metrics](dora-metrics.md).

## How it works

1. **Resources carry catalog metadata from birth.** On create, `ownerId`/`ownerType` default to the creator and `lifecycle` defaults to `production`, so the catalog is populated without anyone curating it.
2. **Discovery reads that metadata.** List endpoints filter on `ownerId` and `lifecycle`; **My Services** is a view keyed off `ownerId`; the command palette searches real resources by name and keywords.
3. **A template is a parameterized `BuilderProps`** with `{{ vars.* }}` placeholders plus a declaration of the `inputs` a developer fills in.
4. **Instantiating renders, then goes through the front door.** The server bakes supplied inputs into `props.vars` and returns the props, `{{ … }}` placeholders intact; the dashboard submits them to the normal pipeline-create endpoint — compliance validation and quota apply exactly as they would to a hand-written pipeline.
5. **A scorecard blends three existing signals.** The pipeline is dry-run against the org's compliance rules (pass ratio, a warning counting as half a violation), its trailing-30-day DORA bands are mapped Elite→Low to points, and its open security findings cost points. They are weighted 40/40/20 (50/50 without a security signal) into one 0–100 score and an A–F grade.

## Configuration

1. **Enable Advanced Reporting** to expose scorecards. They are gated by the `advanced_reporting` feature — included in Business and Enterprise, or the Advanced Reporting add-on — the same feature that gates DORA. With it off, the card is hidden.
2. **Run `pipeline-manager infra setup-events --with-dora`** if you want measured lead time. Without it, lead time has no rating and the DORA dimension is computed from the remaining bands. See [DORA Metrics](dora-metrics.md#how-each-metric-is-defined).
3. **Decide template visibility.** New templates default to `visibility: private`. `org` shares one org-wide; `public` puts it in the shared golden-path catalog and requires `templates:publish`.
4. **Grant the template permissions** you intend: `templates:write` to author, `templates:publish` to publish org-wide golden paths.
5. **Audit for shadowing** before rolling out the ecosystem catalog: `GET /api/plugins/shadowing` lists every own-org plugin name that shadows a listing.

## Catalog ownership and metadata

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

The **My Services** page (dashboard → Home → *My services*) lists the pipelines and plugins the current user owns across the org catalog, with lifecycle badges and a lifecycle filter — a personal "what do I own?" view keyed off `ownerId`.

### Cross-resource search

The command palette (**⌘K**) searches actual resources — pipelines and plugins by name and keywords — not just page names, so you can jump straight to a resource without knowing which page it lives on.

### Plugin catalog: listings and installs

The plugins a developer can use are the org's **own plugins** plus the ecosystem **listings** the org has installed. The in-app catalog (dashboard → Plugins) shows every listing with the org's install state:

- installed or not
- the version a new synth resolves to
- whether installing needs approval
- whether the org's consumption policy blocks it

Official listings (publisher `pipeline-builder`) count as installed for every org through the implicit install. See [Plugin Installing](plugin-installing.md). Each listing also shows a 0–100 **health score** — runtime success, vulnerabilities, freshness, signing, smoke test, docs and rating; see [Health score](plugin-installing.md#health-score).

**Shadowing warning.** An own-org plugin with the same name as an Official listing wins for unqualified references (`plugin: { name: trivy }`). The Plugins page flags that plugin, the pipeline editor flags each step that uses it, and lookup warns `PLUGIN_SHADOWS_LISTING`. `GET /api/plugins/shadowing` lists every shadowed name. Add `publisher: pipeline-builder` to a step to use the listing instead.

## Golden-path templates

A **pipeline template** is a parameterized starter: its body is a `BuilderProps` with `{{ vars.* }}` placeholders, and it declares the `inputs` a developer fills in to instantiate it.

System-org **public** templates form a shared golden-path catalog visible to every org — the same sharing model as the sample template catalog and compliance rule templates. Org-private templates are visible only to their org.

### Instantiate flow

Dashboard → Build → *Templates* → *Use template*:

1. Pick a template and fill its declared inputs — typed `string` / `number` / `boolean`, with optional defaults and fixed choice `options`.
2. The server renders the template into a concrete pipeline `props`. The supplied inputs are baked into `props.vars`; `{{ vars.* }}` in the `synth.source` repository fields is filled in (so the pipeline builds the supplied repository; a missing value is a 400), and the other placeholders are left as written, resolving at synth; plugin specs read the values at synth as `{{ pipeline.vars.* }}` (see [Template Syntax](templates.md#golden-pipeline-templates) for which fields resolve). Plugin references the org can't resolve, or that resolve to a vulnerable or unscanned version, come back as `pluginWarnings` — nothing is refused at this step.
3. The resolved props are submitted to the **normal pipeline-create path**, so compliance validation and quota still apply — a template can't bypass governance.

### API

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/pipeline-templates` | List the catalog you can see — your org's shared templates, your own private drafts, and the system-org catalog. Paginated/filterable (incl. `visibility`). |
| `GET` | `/pipeline-templates/{id}` | Fetch a template. |
| `POST` | `/pipeline-templates/{id}/instantiate` | Render → `{ props, description, keywords, pluginWarnings? }` (`templates:read`). Body: `{ project, organization, pipelineName?, inputs? }`. Creates nothing. 400 when a `synth.source` placeholder has no value. |
| `POST` | `/pipeline-templates` | Author a template (`templates:write`). Defaults to `visibility: private`; `org` shares it org-wide, `public` needs `templates:publish`. |
| `PUT` / `DELETE` | `/pipeline-templates/{id}` | Update / soft-delete (`templates:write`, plus `templates:publish` for a `public` template and authorship for a `private` one). |
| `GET` | `/pipeline-templates/deleted` | List soft-deleted templates still inside the retention window (`templates:read`). |
| `POST` | `/pipeline-templates/{id}/restore` / `…/purge` | Undo a soft-delete, or hard-delete the tombstone now. Same authority as `DELETE`, plus a step-up. |

## Maturity scorecards

Each pipeline has a **maturity scorecard** — a single 0–100 score and an A–F grade (A ≥ 90, B ≥ 75, C ≥ 60, D ≥ 45, otherwise F; `N/A` with no data) that blends three dimensions the platform already computes:

| Dimension | How it scores |
|---|---|
| **Compliance posture** | The pipeline is dry-run against the org's compliance rules; the score is the pass ratio, with a warning counting as half a violation. |
| **Delivery performance** | The four per-pipeline DORA bands — deployment frequency, change-failure rate, median time to restore, measured lead time — over the trailing 30 days, mapped Elite→Low to points. A band resting on fewer than 5 observations is `insufficient` and **unscored** (left out of the average, never counted as Low); the card shows "Not enough data (n = X)". Bands are scored on the headline environment (`production`, else the first). |
| **Security** | 100 less 25 per KEV-listed, 15 per Critical and 5 per High finding (a KEV finding pays both), floored at 0 — counting the pipeline's open plugin-image exposures (not under an acceptance in force) and its latest artifact security reports. Null when the pipeline has no open exposure and has never uploaded an artifact report: unmeasured, not clean. |

Compliance and DORA are weighted 40/40 and security 20; with no security signal it is 50/50. Each dimension is independently nullable, and a missing one's weight is spread over the present ones. The scorecard surfaces as a card on the pipeline detail page.

All four routes require the `advanced_reporting` feature:

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/pipelines/{id}/scorecard` | One pipeline's card (`pipelines:read`). Optional `?from&to` (default the trailing 30 days), capped at the org's DORA retention. |
| `GET` | `/pipelines/{id}/scorecard/history` | Score and grade for each of the last `?periods` (1–12, default 12) `?interval=week\|month` windows, computed on the fly (`pipelines:read`). |
| `GET` | `/pipelines/scorecard` | Org-wide leaderboard of the org's own pipelines plus aggregate stats (`reports:read`). Paged with `offset` / `limit` (at most `ORG_SCORECARD_MAX_PIPELINES`, default 50), filterable by `project` / `pipelineName`; a page is cached for five minutes. A pipeline whose card failed to compute is marked `unavailable`, not graded F. |
| `GET` | `/pipelines/scorecard/history` | The org leaderboard's grade history, same `interval` / `periods` (`reports:read`). |

Response (abridged):

```json
{
  "scorecard": {
    "pipelineId": "…",
    "score": 85,
    "grade": "B",
    "compliance": { "score": 90, "rulesEvaluated": 10, "violations": 1, "warnings": 0 },
    "dora": { "score": 80, "basis": "deploy", "deploymentFrequency": "high", "changeFailureRate": "high",
              "meanTimeToRestore": "insufficient", "leadTime": "high",
              "samples": { "deploymentFrequency": 12, "changeFailureRate": 13, "meanTimeToRestore": 2, "leadTime": 11 } },
    "security": { "score": 85, "exposures": { "count": 1, "critical": 1, "high": 0, "kev": 0 }, "artifact": null },
    "computedAt": "…"
  }
}
```

## Related

- [Template Syntax](templates.md) — the `{{ ... }}` grammar templates are written in
- [Plugin Installing](plugin-installing.md) — install state, consumption policy, health score
- [DORA Metrics](dora-metrics.md) — the metric definitions behind the delivery half of the score
- [Permissions](permissions.md) — `templates:write`, `templates:publish`
