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
- **Flagged plugins are fixed automatically**: after the nightly rescan, the platform rebuilds or library-patches a flagged plugin version, proposes or publishes the fix as the next version, and moves pipelines onto it in waves with automatic rollback.
- **Delete a whole plugin**: Delete plugin removes every version of a name at once, with a preview, and restores or purges it as one batch.
- **Unused plugin versions are tidied**: a weekly digest lists plugin versions nobody has used for 90 days, each with a Keep link. Turn on automatic tidying to deactivate and later delete them; nothing changes until you do.

## Before you deploy this release

Check these before you roll the release out, and watch the last one straight after.

1. **Every org that runs pipelines needs an active 7.0.0 runner, the system org included.** Runners are the only way the platform starts and stops pipelines. An org without an active runner at version 7.0.0 or later in the pipeline's account cannot run: **Run** answers `NO_RUNNER` and the run fails. Check **Settings → Organization → Pipeline runners** in each org (system org too) and install or upgrade a runner before deploying. `MIN_RUNNER_VERSION` ([Environment Variables](environment-variables.md)) is the oldest version the dispatcher accepts.
2. **Some data starts with this release.** These are collected only from the moment this release is deployed, so charts and reports that use them are empty or partial for periods before it. Nothing is backfilled:
   - approval categories;
   - CodeBuild queue and provisioning phases;
   - AI draft outcomes (accepted or discarded) and AI call counts;
   - runner `accepted_at`, the time a runner accepted a start or stop request. The Delivery report's runner latency is exact for requests with it and estimated for older ones, and it says which.
3. **After deploying, watch for the first successful storage snapshot.** The registry's push gate reads per-org storage from a background snapshot. Until the first run completes, storage reads as unknown, and an org with a storage cap **cannot push images** (the gate fails closed). Confirm that `registry_storage_snapshot_last_success_timestamp_seconds` appears and advances, and that `RegistryStorageSnapshotStale` does not fire. See [Deploy Operations](deploy-operations.md) for the snapshot's signals.

## November 2026: automatic plugin version tidying

Unused plugin versions used to stay forever, costing storage and cluttering the version list. Now the platform finds them.

### What changed

- **A weekly digest of stale versions.** A version is stale once nothing has used it for 90 days (a synth or a pipeline save resolving it counts as use; change the number of days, minimum 30). Seven days before, your plugin security recipients get one digest (N41) listing the newly stale versions, each with a **Keep** link. Organizations start in `notify` mode: the digest is all that happens.
- **Turn it on to clean up.** In `on` mode a stale version is deactivated on its date (an exact pin still resolves it, with a warning), deleted 30 days later if still unused (restorable as one batch), and purged 30 days after that. See [Automatic tidying](plugin-publishing.md#automatic-tidying).
- **Never anything in use.** The latest and default versions, anything a pipeline, install or remediation references, frozen, managed and only versions, and KEV-flagged versions under an active risk acceptance are never touched.

### What you will see

- **Automatic tidying** under Settings → Organization → Plugin security: the mode, the number of days, and a preview of what the next pass would do.
- A **Stale** badge with the deactivation date and a **Keep** button on plugin versions, a **Never tidy** switch per plugin, and the bytes tidying will free in the **Storage** section.
- Lookups of a version tidying deactivated answer with a `PLUGIN_TIDY_DEACTIVATED` warning.
- New notice N41 and audit actions `plugin.tidy.warned`, `plugin.tidy.deactivated`, `plugin.tidy.retired`, `plugin.tidy.kept` and `plugin.tidy.settings.update`.

### For operators

`PLUGIN_AUTO_TIDY_ENABLED` (default `true`; only `false`, in any case, turns it off) stops the daily job for every organization. Failures are counted on `plugin_tidy_failed_total{stage}` and alert as `PluginTidyFailing`. The new `plugins` columns and the `plugin_retention_settings` table are created by postgres-init on a new install. See [Environment Variables](environment-variables.md).

## November 2026: nightly plugin CVE remediation

Until now the platform found and reported vulnerable plugin versions every night, then stopped. Now it fixes the ones it can.

### What changed

- **A flagged version gets a fix.** After each completed rescan, a remediation is queued for every flagged version (and every version with fixable High findings) whose organization has remediation on. It rebuilds the version on a freshly pulled base image, then upgrades the named Critical and High libraries to their fixed versions within your allowed upgrade level, and verifies the result through the full build gate, the contract check and the plugin's `smokeTest`. See [Automatic remediation](plugin-publishing.md#automatic-remediation).
- **Fixes are proposed by default.** Organizations start in `propose` mode: a fix waits as **Awaiting approval** on the plugin until someone with `plugins:write` approves it with a step-up. In `apply` mode fixes publish on their own, except major library upgrades, plugins without a `smokeTest`, and ask-agent patches, which are always proposed.
- **Pipelines move onto the fix.** Pinned pipelines get an upgrade proposal by default, or are moved in waves (a canary of 5, then batches of 50) with rollback on failure within 24 hours. Each pipeline can follow its organization, opt out, or choose its own mode. See [Remediation upgrades](plugin-installing.md#remediation-upgrades).
- **What can't be fixed goes to the owner.** Findings with no fixed version, beyond the upgrade level or inside a compiled binary are listed in a remediation request (N39). Third-party listings are never changed; their publisher gets a fix request (N40).
- **Build sources are kept.** A version's build context is now kept in the `plugin-sources` bucket for the version's life, so it can be rebuilt later. Kept sources count toward your storage quota. Prebuilt-image uploads have no source and are fixed with an overlay layer only.
- **Delete plugin.** A whole plugin, every version of the name, can be deleted at once, restored as a batch within the soft-delete window, and purged. A purge now also removes the version's image, signature and attestations, and its kept sources. See [Deleting plugins and versions](plugin-publishing.md#deleting-plugins-and-versions).

### What you will see

- A **remediation card** on each plugin version, a **Remediations** tab on the Plugins page, and **Plugin security** settings (mode, library upgrade level, pipeline rollout) under Settings → Organization.
- An upgrade proposal banner, wave status and rollback history on the pipeline's security tab.
- New notices N36 to N40, and new audit actions `plugin.remediation.*`, `plugin.delete-all`, `plugin.restore-all`, `plugin.purge-all` and `pipeline.remediation-upgrades.update`.

### For operators

`PLUGIN_REMEDIATION_ENABLED` (default `true`; only `false`, in any case, turns it off) and `PLUGIN_REMEDIATION_SEVERITIES` (default `critical`, set `critical,high` to also target Highs; KEV findings are always targeted) control the feature for the whole instance. The new `plugin-sources` bucket is created by rustfs-init on every target and belongs in your backups. See [Environment Variables](environment-variables.md).

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
