# Changelog — @pipeline-builder/pipeline-data

Release versions are stamped by `nx release` (conventional commits). This file records
breaking changes in the public surface only.

## 5.0.0 (unreleased)

### BREAKING CHANGES — unused barrel exports removed.

No workspace consumer imported these, so they are no longer exported from `.` (the definitions stay internal): `openCasesForContact`, `QUEUE_STATUSES`, `SUPPORT_CASE_PAGE_DEFAULT`, `readOrgToolchainOverviewWith`, `listEligibleReleasesWith`, `isEligibleReleaseWith`, `managedToolchainRefusal`, `isToolchainReleaseVersion`, `releaseExists`, `releaseLifecycleProblems`, `stageAndStep`, `upsertDeployments`, `isDeployEvent`, `leadTimeGapOf`, `rebuildDay`, `rollupSettleHours`, `rollupBatchDays`, `isTeamActionable`, `FAILURE_CATEGORY_LABELS`, `getPipelineBreakdown`, `getFailureAnalysis`, `getStagePerformance`, `getResourceConsumption`, `getPromotionView`, `getOutdatedPlugins`, `getPluginVulnerabilities`, `getAdoption` (use `ReportingService`), `evaluateNeedsAttention`, `thresholdsFrom`, `DEFAULT_THRESHOLDS`, `upsertExposures`, `closeFixedExposures`, `closeVersionExposures`, `exposureFromScan`, `liveExposurePredicate`, `lapsedAcceptances`, `versionGap`, `canaryPerOrgCap`, `deployedToolchainOf`, `evaluateCanaryGate`, `SELF_MUTATION_ACTION`, `SELF_MUTATION_STAGE`, `SYNTH_STEP_KEY`, `toolchainActionOf`, `toolchainOutcomeOf`, `registerReportSection`, `allSections`, `sectionIds`, `REPORT_TEMPLATE_SPECS`, `LOW_SAMPLE_THRESHOLD`, `REPORT_FEATURE_SUBSTITUTES`, `trendSentence`, `hashReportToken`, `mintReportToken`, `RECIPIENT_VERIFICATION_TTL_MS`.

### Fixes

- `purgeOrgData`: soft-purged rows on tables with `is_active` are now also set `is_active = false`. They were tombstoned with `deleted_at` only, and list reads filter on `is_active`, so a purged org's pipelines, plugins, compliance policies/rules, messages, support cases and report definitions kept appearing in lists until the retention sweep ran.
- `ingestEvents`: the inserted-row projection now includes `duration_ms`, so the compute fan-out (`IngestMetric` `kind: 'compute'`) reports real `durationMs`/`credits` instead of `null` (unmeasured) for every terminal action.
- `upsertDeployments` (ingest's DORA rollup): a batch with two deploy events for the same (org, execution, environment) — a retried deploy stage's FAILED + SUCCEEDED, or two deploy stages into one environment — failed the whole upsert (`ON CONFLICT DO UPDATE command cannot affect row a second time`) and, because the rollup never throws, silently dropped every deploy in the batch. Duplicates are now folded in deploy-time order before the insert, with the same fill-in semantics as consecutive upserts.

### BREAKING CHANGES — Backward-compatibility shims removed.

- `HealthBreakdown` (the `plugin_stats` / `ecosystem_listing_stats` `health_breakdown` column type) is now api-core's `Record<HealthComponent, HealthComponentScore>`, re-exported. It was widened to `Record<string, …>` only to accept rows written with an older component set.

### BREAKING CHANGES — `./lib/*` removed; `./testing` is workspace-only.

The package's public surface is now exactly its `exports` map. Anything not listed below cannot be imported (`ERR_PACKAGE_PATH_NOT_EXPORTED`).

- **Entries:** `.`, `./package.json`.
- The `./lib/*` wildcard is gone, so `@pipeline-builder/pipeline-data/lib/...` deep imports no longer resolve.
- `./testing` is no longer in the published map. The tarball never contained `lib/testing/` (it needs the PGlite devDependency and the repo's `deploy/` init script), so the old entry pointed at nothing. It stays a workspace-only entry for this repo's test suites.
