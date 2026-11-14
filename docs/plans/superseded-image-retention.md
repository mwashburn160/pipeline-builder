---
layout: default
title: Plan — Retire superseded system plugin versions
---

<!--
Copyright 2026 Pipeline Builder Contributors
SPDX-License-Identifier: Apache-2.0
-->

# Plan — Retire superseded system plugin versions

**Nothing removes a system plugin version once a newer one replaces it. Each
refresh of the ~125-plugin catalogue adds an image to `system/<name>` and,
for listed plugins, to its `public/<handle>/<name>` copy. Both stay forever.
This plan adds a retention pass to the plugin service. For each system plugin
it keeps the newest N versions and every version anything still needs, and
retires the rest. Retiring a version yanks its listing, soft-deletes its row
and, after the purge window, hands its digest to image-registry for deletion.
The existing weekly blob GC then frees the bytes.**

## Highlights

- **This is a gap in the code, not a setting.** `REGISTRY_GC_ENABLED` does not
  help:
  - The scheduler sweeps only `org-*` namespaces (`gc-scheduler.ts`), and the
    age sweep never touches `public/*` (`registry-gc.ts`).
  - Inside `org-*`, every plugin row's digest counts as in use, including
    soft-deleted rows (`orgImageDigestsInUse`). A version is never
    "superseded" to the GC while its row exists.
  - `public/*` is collected only when a version was **yanked** more than 180
    days ago and no pipeline references it (`ecosystem/image-gc.ts`).
    Nothing ever yanks a version for being old.
- **Keeping everything is the safe failure.** Pipelines pull by digest, so
  deleting too much breaks deployed pipelines and keeping too much only costs
  money. Every rule below fails closed: an unanswerable check keeps the
  version.
- **The decision lives in the plugin service.** It owns the rows, the
  listings and the reference checks (`findVersionReferences`,
  `versionReferencedPredicate`). image-registry only deletes digests it is
  handed, the same split `POST /internal/plugin-publications/gc` already uses.
- **Bytes come back only when every copy is gone.** A listed version's
  `system/` build copy and its `public/` copy share blobs. Distribution frees
  a blob only when no manifest in any repository references it. Retiring one
  copy frees nothing, so the pass must retire both. Layers shared with the
  `pipeline-*-base` images are never freed, and they shouldn't be.
- **Measure before building past Phase 0.** No one has measured the growth
  yet. If superseded versions add up to a few GB, stop after Phase 0 and
  record the number.

## Overview

| Phase | What | Changes behaviour? |
|---|---|---|
| 0 | Measure what superseded system versions cost | No (read-only) |
| 1 | Selection rule plus a dry-run report | No |
| 2 | The retire action and its scheduler, off by default | Only when enabled |
| 3 | Delete the `system/` build copy after the purge | Only when enabled |
| 4 | Metrics, alerts and docs | No |

## How it works

### Which versions are retirable

The unit is one system-org plugin name (`plugins.org_id = 'system'`) and,
when it is listed, its Official listing. Versions are ordered by semver,
newest first. Build time is not used, because a rebuild of an old version
would otherwise count as new. Prereleases never count toward N and are
retirable under the same guards.

**Other orgs never hold a plugin row for a system version.** Official
listings are installed implicitly (no row at all), and an explicit install is
a `plugin_installs` row with a `version_policy` (`pinned`, `patch`, `minor`
or `latest`) from a `pinned_version` baseline. The resolver
(`selectListingVersion` in `pipeline-data/src/api/plugin-resolution.ts`)
skips yanked versions, so a yank can change what an org resolves next, or
leave it with nothing. The guards protect **what an org would resolve**, not
just what it has already deployed.

A version is **retirable** only when **all** of these hold:

1. **N per live major.** It is outside the newest `PLUGIN_RETENTION_KEEP`
   versions (D1, default 3) **of its own major**. The newest version of
   **every** live major is always kept. Only versions that are not yanked,
   deprecated or soft-deleted count toward N.
   - Why per major: the implicit Official install resolves within the
     **lowest live major** (`implicitInstallRange`). If retention yanked the
     last `1.x`, every org on the implicit install would move to `2.x` on its
     next synth, across a breaking change, with no one choosing it.
     Retiring a whole major is a separate, explicit operator action (D7).
2. **No explicit install depends on it.** For each `plugin_installs` row on
   the listing, the pass keeps:
   - its `pinned_version` (`pinned` policy) and its last `resolved_version`;
   - the newest version its policy admits (`installAdmits`), so a `patch`
     install on `~1.2.0` never loses its last `1.2.x`.
3. It is not the plugin's default version (`isDefault`), and no protected
   floating tag (`REGISTRY_GC_PROTECTED_TAGS`) points at its digest.
4. **No pipeline in any org references it**, by the rule every removal path
   already asks (`versionReferencedPredicate`). That covers:
   - a live pipeline's declared resolution;
   - any deployed step manifest (including a soft-deleted pipeline's, which
     can be restored);
   - any open deployed vulnerability exposure.
5. **No template, and no soft-deleted pipeline, pins it exactly**
   (`filter.version` equal to the version).
   - Templates and sample templates are not pipelines, so they are checked
     from their stored config.
   - A saved pipeline's declared resolution is written **at save time**
     (`recordPipelineResolution`, on create, update, bulk update, plugin
     upgrade and restore). The plugin service rewrites it when the catalog
     moves (`declared-resolution-refresh.ts`), so rule 4 covers live
     pipelines.
   - A soft-deleted pipeline keeps its resolution rows until it is purged,
     but `versionReferencedPredicate` filters them out
     (`p.deleted_at IS NULL`). A never-deployed, soft-deleted pipeline with
     an exact pin is therefore invisible. Restoring it would then fail on a
     yanked version. Rule 5 reads those rows too.
6. **Before selecting, the pass refreshes each candidate plugin's declared
   resolutions synchronously.** It runs `declared-resolution-refresh` for that
   plugin name and pages through every pipeline, without the
   `PLUGIN_RESOLUTION_REFRESH_MAX` cap. It does not trust a missing row as
   "unreferenced":
   - the save-time write is fire-and-forget: a failure only logs `Pipeline
     plugin resolution not recorded`;
   - the trigger-time refresh stops at 500 pipelines.
   
   A live pipeline that declares the plugin but still has no rows after the
   refresh holds **every** version of that plugin for this pass. They are checked from their own
   stored config, and the result is reported in the dry run (Phase 1).
7. It is not a managed toolchain plugin (`pipeline-bootstrap`, `cdk-synth`).
   Releases have their own rules (D3).
8. It is not paused (`paused_at`). A paused version still serves installs that
   resolved it before the pause, which is invisible to rule 2's "newest
   admitted".

The rule is one SQL predicate (rules 3–5, 7 and 8) plus a pure function that applies
rules 1 and 2 by reusing `implicitInstallRange` and `installAdmits` as they
are. The function is unit-tested on its own. The predicate is tested on
PGlite with the shipped `postgres-init.sql`, against seeded pipelines,
templates, installs and listings.

### What retiring a version does

Retiring goes through the **existing lifecycle services**, never by writing
columns directly. Those services already keep the row and its listing in
step, promote a new default, notify orgs and audit. It has two stages, so
nobody is surprised:

1. **Deprecate** (`POST /plugins/:id/deprecate`, the service behind it). The
   version keeps resolving, but lookups and `pipeline synth` print a warning,
   and AI plugin selection stops offering it. This is the notice period
   (`PLUGIN_RETENTION_NOTICE_DAYS`, D8, default 30).
2. **Yank**, with reason `superseded`, once the notice period has passed and
   the version is **still** retirable. The rules are re-read at this point,
   because a deploy may have landed during the notice period. Ranges,
   `latest` and the default skip it from then on. Then soft-delete the
   system row through the normal delete path, which sets `purge_after`.

Each stage is audited: `plugin.version.retire` with `details.stage`
(`deprecate` / `yank`), the version, its digest and the rule that made it
retirable, under the system actor.

**Notifications must be grouped.** A yank notifies every org on the version
(`services/version-withdrawal.ts`). One pass can retire dozens of versions,
so it sends one grouped "superseded versions" notice per org and pass, never
one per version. Rules 2 and 4 mean an org should rarely be on a retired
version at all. When one is, the notice names the version to move to.

**Two resolvers treat a yanked exact pin differently.** The row resolver
still finds a yanked exact pin, with a warning. The listing resolver refuses
it (`PLUGIN_UNAVAILABLE`, reason `yanked`). Rules 2, 4 and 5 exist so no
exact pin is ever yanked. The tests cover both resolvers.

Then the existing machinery takes over:

- The retention purge hard-deletes the row at `purge_after`. The purge is
  already guarded by `versionReferencedPredicate`, so a row a pipeline picked
  up after the yank stays a tombstone. Phase 4 reports those as stuck,
  instead of retrying them forever without saying so.
- `ecosystem/image-gc.ts` collects the `public/` copy 180 days after the yank,
  re-checking references right before the delete.
- **New in Phase 3:** once the row is purged, the plugin service hands the
  `system/<name>` digest to image-registry, re-checking rules 2, 4, 5 and 6
  first.
- The weekly `registry-blob-gc` job frees the bytes once both copies are gone.

**Restoring.** Before the purge, `POST /plugins/:id/unyank` and a row
restore bring the version back completely. Unyank does not make it the
default again, which is the existing unyank contract. After the purge, the
version is gone for good, even though its `public/` copy may still be on
disk until the 180-day collection.

**How long until bytes come back.** The notice period (30 days), then the
purge window, then 180 days for the `public/` copy, then up to a week for the
blob GC. That is roughly 7–8 months from the start of the deprecation.
Phase 0's estimate has to use this lag, not "next week".

## Phases

### Phase 0 — Measure (read-only)

- A script, `api/plugin/src/scripts/measure-superseded.ts`, joins the
  system-org rows with image-registry's `/internal/storage-breakdown`. It
  reports, per plugin: version count, versions outside the newest N, and the
  **marginal** bytes those versions hold. Marginal means bytes no kept version
  or base image shares.
- It also reports how many of those versions rules 2–6 would protect, and
  which rule protects each one, which is the size of the hold-outs. A plugin
  whose old versions are all held by one `pinned` install is a different
  problem: an org to talk to, not something a retention pass can fix.
- It counts **orphan manifests** in `system/*`: digests no tag and no plugin
  row points at. Nothing sweeps `system/*` today, so any orphans there are a
  second, separate leak. If they exist, Phase 3's endpoint covers them too.
- **Exit:** a number in this plan. Below about 10 GB total, record it and
  stop. Above it, continue.

### Phase 1 — Selection and dry run

- `services/retention/select.ts`: the predicate and ordering function above.
- `GET /plugins/retention/plan`: system org only, `registry:purge`, aal2.
  Returns the retirable versions, the rule that protects each kept version,
  the orgs a retirement would notify, and the bytes retiring would free
  (marginal, from the breakdown).
- A read-only "Retention" panel in the system org's plugin console, beside
  the existing storage view. Without it the dry run is only usable through
  `curl`.
- **Contracts this route trips:** the route-table snapshot, route-permissions,
  `docs/permission-contract.md`, and the frontend disposition map. See the
  plugin-route reference for the order in which they surface.

### Phase 2 — Retire, off by default

- `services/retention/retire.ts`: both stages above, through the existing
  deprecate, yank and delete services. Each stage re-reads the rules inside
  its transaction (check, then act), so a version a deploy referenced since
  selection is skipped and its deprecation is reversed
  (`{ deprecated: false }`).
- Grouped notices: one per org and pass, through the existing ecosystem
  notification path (one new notice type, added to the notification catalog
  and `docs/notifications.md`).
- A scheduler in the plugin service, behind `PLUGIN_RETENTION_ENABLED`
  (default `false`), runs daily under `leaderLockKey('plugin',
  'superseded-retention')`. It retires at most `PLUGIN_RETENTION_BATCH`
  versions per pass (default 50). A pass that would retire more than
  `PLUGIN_RETENTION_MAX_FRACTION` of a plugin's live versions (default 0.5)
  refuses that plugin and alerts instead. That limit catches a selection
  bug before it yanks half the catalogue.
- `POST /plugins/retention/run`, gated like Phase 1's route, runs one pass on
  demand and returns what it retired.
- New audit action `plugin.version.retire`, added to the audit catalog and to
  `docs/audit-events.md`.

### Phase 3 — Delete the `system/` build copy

- Extend `POST /internal/plugin-publications/gc` (image-registry) to accept
  `system/<name>` repositories as well as `public/*`, or add a sibling
  `POST /internal/system-images/gc` (D4).
  - The registry-side guard is "no tag other than the retired version's tag
    resolves to this digest".
- The plugin service calls it from the purge hook for retired system rows,
  after re-checking rules 2, 4, 5 and 6. A failed call leaves the digest for the
  next pass, which keys off purged rows whose digest has not been collected.

### Phase 4 — Observability and docs

- Metrics:
  - `plugin_retention_retired_total`;
  - `plugin_retention_failed_total{stage}`;
  - a `plugin_retention_retirable` gauge;
  - a `plugin_retention_stuck` gauge: retired rows the purge guard keeps
    refusing because a pipeline picked them up after the yank.
- `*_failed_total` must be alerted (`PluginRetentionFailing`) or exempted.
  Validate the rule files with `promtool`. The scheduler joins
  `SchedulerJobStale`.
- Add `PLUGIN_RETENTION_ENABLED`, `PLUGIN_RETENTION_KEEP`,
  `PLUGIN_RETENTION_NOTICE_DAYS`, `PLUGIN_RETENTION_BATCH` and
  `PLUGIN_RETENTION_MAX_FRACTION` to the four `.env.example` files,
  `docker-compose.yml`, and `docs/environment-variables.md`, then run
  `npm run generate:help`.
- `docs/deploy-operations.md` gets a "Plugin version retention" section,
  covering the dry run, enabling it, restoring, and how long until bytes come
  back (about 7–8 months; see "How long until bytes come back").

## Decisions

| # | Question | Proposal |
|---|---|---|
| D1 | How many versions to keep (N) | 3 |
| D2 | Order by semver or by creation time | Semver |
| D3 | Toolchain releases | Out of scope. Former platform defaults stay eligible as org defaults forever, so N-based retention would break the "Pipeline toolchain" setting. Retiring a release needs its own rule: never default, never canary, no org default, no pin, unreferenced. |
| D4 | Reuse the publications GC endpoint or add a sibling | Reuse it, with a namespace-specific guard |
| D5 | Tenant (`org-*`) plugins too | No. Tenants keep manual `POST /storage/prune`, and their bytes are under their own quota. |
| D6 | Enabled by default | No. Turning it on is an operator decision taken after reading the dry run. |
| D7 | Retiring a whole old major | Never automatic. A separate operator action on the dry-run panel, because it moves every implicit install to the next major. |
| D8 | Deprecation notice before the yank | Yes, 30 days (`PLUGIN_RETENTION_NOTICE_DAYS`) |
| D9 | Which permission gates the retention routes | `registry:purge` is superadmin-only. The 2026-11-02 job-Roles work moved vendor tasks onto system-org job Roles, so this probably belongs on the Role that already runs catalogue moderation. Decide before Phase 1, because the route contracts encode it. |

## Not in scope

- Base images (`system/pipeline-*-base`, `library/*`). They have no plugin
  rows, and deleting one breaks rebuilds of every plugin that uses it.
- Changing the 180-day public window or the age sweep's rules.
- Any change to how pipelines pin or resolve versions. The pass reuses
  `implicitInstallRange` and `installAdmits` as they are.

## Review notes (2026-11-14)

The first draft was checked against the code. These are what changed:

- **The cross-org guard was wrong.** The draft protected versions held by
  "another org's plugin row". Installs are not plugin rows: implicit Official
  installs have no row, and explicit ones are `plugin_installs` rows with a
  version policy. Replaced by rules 1 and 2.
- **"Keep the newest N" could cross a major for every org.** The implicit
  install follows the lowest live major. Now it is N per major, the newest of
  each major is always kept, and retiring a whole major is manual (D7).
- **Yanking with no warning.** The draft yanked straight away. Now there is a
  deprecation notice period first (D8), and the rules are re-checked before
  the yank.
- **Writing lifecycle columns directly** would have skipped default
  promotion, listing sync and the withdrawal notices. The draft now goes
  through the existing deprecate, yank and delete services, with grouped
  notices.
- **Templates and exact pins** were not covered by
  `versionReferencedPredicate`. Rule 5 adds them.
- **Paused versions** need their own rule (rule 8).
- **Save time vs synth:** declared resolutions are written at save time and refreshed when the catalog moves. But the write is fire-and-forget, the refresh is capped, and soft-deleted pipelines are filtered out. Rule 5 reads soft-deleted rows, and rule 6 refreshes before selecting.
- **Tombstones the purge guard refuses** were invisible. Now there is a stuck
  gauge.
- **The bytes-back estimate** ignored the notice, purge and 180-day windows.
  It is now stated as about 7–8 months.
- **A safety limit** (`PLUGIN_RETENTION_MAX_FRACTION`) bounds the damage a
  selection bug could do.
- **Orphan manifests in `system/*`** (digests with no tag and no row) are a
  separate leak. Phase 0 counts them.
- **Dependency cleared:** the cosign-signature GC bug from the 2026-11-13
  survey was fixed in `3a5c26580`, so Phase 3 does not wait on it.

## Status

| Phase | State | Commit |
|---|---|---|
| 0 | Not started | — |
| 1 | Not started | — |
| 2 | Not started | — |
| 3 | Not started | — |
| 4 | Not started | — |
