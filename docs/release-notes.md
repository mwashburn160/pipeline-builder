---
layout: default
title: Release Notes
image: /assets/og-image-solution.png
---

<!--
Copyright 2026 Pipeline Builder Contributors
SPDX-License-Identifier: Apache-2.0
-->

# Release Notes

Changes that move a number you already watch. Each entry says what changed, why, and what you will see.

## Highlights

- **Reporting accuracy (November 2026)**: several dashboard numbers are now counted more strictly, so some will move. Published stakeholder reports do not change.
- **New on Pipelines → Failures**: your own error patterns by category, flaky stages, and failures grouped per pipeline.
- **Unknown lead time is explained**: the DORA lead-time card says why it could not be measured and how to fix it.

## November 2026: reporting accuracy

A review of the reporting queries found places where the dashboard counted lifecycle rows, windows or samples loosely. Each fix below makes the numbers more correct. Expect some of them to move the first time you look.

### What changed

- **Failure rates count terminal outcomes.** A stage or action that started, ran and then failed is one attempt, not three. Lifecycle rows (`STARTED`, `IN_PROGRESS`, `STOPPING`, `RESUMED`) no longer count as attempts. *Effect:* stage and action failure percentages go **up** where they had been diluted.
- **Post-deploy failures count against their deploy.** A deploy marked failed, or followed by an incident, counts in the window its deploy completed in, however late it was flagged. *Effect:* change failure rate no longer moves a failure into the next month, and it can no longer exceed 100%.
- **Time to restore runs from the failure, and is a median.** A recovery is measured from the incident opening, or the deploy's `failed` marker, to its restoration, not from the deploy's completion. The figure is the median, and it is labelled that way. A `restored` marker with no failure behind it is ignored. *Effect:* time to restore usually goes **down**.
- **DORA bands need 5 samples.** A band (elite, high, medium or low) needs at least 5 observations. Below that the card reads **"Not enough data (n = X)"** instead of a band, and the maturity scorecard treats it as unscored.
- **Dashboards honour the org timezone.** Time-bucketed charts (success rate, plugin builds, the DORA trend) group days in the org's reporting timezone and week start, the same way the stakeholder report does. *Effect:* a team outside UTC sees its weeks start where the report's do.
- **Stakeholder DORA sections use your incident window.** A report's change failure rate and time to restore now correlate incidents with the same incident window the dashboard uses, so the two match. The window a report used is stored in it.

### What did not change

**Published stakeholder reports are frozen.** A report stores the numbers it computed when it ran, so every report already published keeps its numbers exactly. Only reports composed from now on use the new counting. To see a past period counted the new way, regenerate it as a new version. The original stays as it was.

### New on the Pipelines tab

- **Failures per pipeline.** Stage and action failures are grouped by pipeline. Two pipelines that both call a stage `Build` are two rows, and each row links to that pipeline's runs.
- **Error patterns.** Your organization's failures, grouped by the kind of thing that broke, with the most frequent error messages in each. This panel is available to everyone with report access. It used to be visible to platform operators only.
- **Flaky stages.** These are stages that failed and then passed on retry in the same run, with their flake rate. They count as successes in the failure rates, so this list is where they show up. The flake rate over time is part of Advanced Reporting.

### Unknown lead time, explained

When lead time cannot be measured, the DORA card now names the reason recorded for those deploys: no SCM token, rate-limited, a source with no commit-range API, or no commit data. The card's tooltip gives the fix for each. See [DORA Metrics: Why lead time is unknown](dora-metrics.md#why-lead-time-is-unknown).

## Related

- [DORA Metrics](dora-metrics.md): how each metric is counted
- [Stakeholder Reports](stakeholder-reports.md): frozen snapshots, versions and regeneration
