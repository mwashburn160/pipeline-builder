---
layout: default
title: Plan — Versioned CodeBuild bootstrap image
---

<!--
Copyright 2026 Pipeline Builder Contributors
SPDX-License-Identifier: Apache-2.0
-->

# Plan — Every pipeline on the latest toolchain unless it pins one

**Move the CodeBuild bootstrap image (`pipeline-bootstrap`) out of operator
environment variables and into the plugin catalog. Manage it together with the
`cdk-synth` image built from it as one versioned *toolchain release*, which the
platform resolves for every pipeline on every synth. In order of precedence, a
pipeline gets the release it pins, else its organization's own default, else a
canary release for selected orgs, else the platform default. The system
organization publishes releases and sets the platform default and the canary.
Each organization may override the platform default for itself.**

## Highlights

- **The synth step already follows "latest". The defaults do not.** The synth
  step runs on `cdk-synth`. What is frozen is the **pipeline-wide default
  image** (`codeBuildDefaults`), which runs self-mutation, asset publishing, the
  runtime vulnerability check, the cold-start bootstrap synth, and plugin-less
  steps. `resolveDefaultBuildImage` reads it from the operator's
  `CODEBUILD_DEFAULT_IMAGE[_DIGEST]`, and `pipeline-builder.ts:627-628` copies
  both into the pipeline, so every in-pipeline synth bakes the same pin back in.
- **How customers get `cdk-synth` today is ungated.** A system-org plugin
  reaches other orgs only as an Official listing, through the org's install,
  and gate-green patch and minor versions are auto-approved. So a new
  `cdk-synth` already reaches every org with no canary, and the system row's
  `isDefault` plays no part. **Managed toolchain plugins leave the listing path
  entirely** and resolve from system-org rows only (D5).
- **The unit of change is a release, with one version.** `pipeline-bootstrap@V`
  and `cdk-synth@V` always share the version `V`. Any change to either half
  bumps both, so "the matching `cdk-synth`" is unique by construction, and a
  base-image CVE fix can ship without a pipeline-manager release (D6).
- **One resolver, in the data layer.** `resolveManagedToolchain` lives in
  pipeline-data and is the only code that decides which release a pipeline
  gets. That covers the plugin service's lookup, the pipeline service's
  contract check, compliance, upgrades, declared-resolution refresh and the AI
  catalog. The CLI sends only a pipeline's pin.
- **Self-mutation leaves the managed image (D10).** It runs on the AWS curated
  image with a pinned `aws-cdk` CLI, so a release whose **base image** is bad
  can always be rolled back by setting the previous default. That is a narrow
  guarantee: the likeliest bad release is a pipeline-manager bug, which breaks
  the **synth** step. For that, the primary defence is the canary gate, and the
  recovery path is §9.
- **Who controls what has three levels.** The system org publishes releases
  and sets the platform default and the canary. Each org may set its own
  default from **eligible** releases (D15). A pipeline may pin an eligible
  release. Uploading a release promotes nothing. Today an upload or a yank can
  silently move a default, and the plan closes both paths (§1, §5).
- **The footprint is load-bearing.** The step manifest records the release
  each pipeline is deployed with. That record feeds in-use deletion
  protection, the security surfaces, adoption counts and recovery.
- **Two environment variables, a directory and a script are deleted**, not
  deprecated: `CODEBUILD_DEFAULT_IMAGE[_DIGEST]`, `deploy/codebuild/` and
  `build-codebuild-bootstrap.sh`, along with every hardcoded
  `pipeline-bootstrap:1.0`.

## Overview

### How it works today

| Concern | Source today | Consequence |
|---|---|---|
| `cdk-synth` for a customer org | The system org's **Official listing**, through the org's implicit or explicit install. Plugins are queried with `systemCatalog: false` (`pipeline-data/src/api/query-builders.ts:38-41`). The version is picked by `selectListingVersion` (`pipeline-data/src/api/plugin-resolution.ts:216-275`), and the image is `public/<publisher>/cdk-synth`. | Ungated: the loader sends `publishRequest=true`, and gate-green patch/minor versions are auto-approved (`load-plugin-worker.sh:140-171`). The system row's `isDefault` plays no part. Listed versions are frozen, so yank throws `PLUGIN_VERSION_FROZEN` (`plugin-service.ts:745-751`). |
| Uploading a version | `deployVersion` → `shouldBecomeDefault` (`api/plugin/src/helpers/default-version.ts:27-42`) | The first upload becomes the default, and any newer stable upload in the same major takes over. Upload = promotion. `deployVersion` also overwrites an existing (name, version) in place. |
| `codeBuildDefaults.buildImage` (self-mutation, assets, vuln check, plugin-less steps) | `CODEBUILD_DEFAULT_IMAGE[_DIGEST]` env (`pipeline-core/src/config/infrastructure-config.ts:184`) | Frozen: copied into the pipeline's env (`pipeline-builder.ts:603, 624-628`) and re-applied on every in-pipeline synth |
| `aws-cdk` / `cdk-assets` used by self-mutation and asset publishing | `cliVersion` / `cdkAssetsCliVersion` are set nowhere; they appear only as metadata passthrough (`pipeline-core/src/core/metadata-builder.ts:43`). CDK installs `aws-cdk@2` and `cdk-assets@latest`. | Unpinned. The bootstrap image doesn't even contain `cdk-assets`. |
| In-use protection / security surface for the default image | not recorded in the step manifest | Not covered |
| Yanking a default | `promoteNextDefault` (`plugin-service.ts:768-818`): the highest live stable version whose major is ≤ the removed one's | Promotes whatever is newest, with no guards |
| No default at all | lookup falls back to the highest version (`plugin-service.ts:773`) | An unpromoted upload goes live |
| A same-named row in the caller's org | `pluginResolutionOrderBy` ranks own org 0, parent 1, others 2 (`query-builders.ts:155-167`) | The org's own row wins |

The bootstrap image is built **per deployment**, not by the release.
`sync-image-tags.sh:241-261` only bumps its pinned `PIPELINE_MANAGER_VERSION`,
and `release.yml` has no bootstrap step.
`plugin-base-freshness.yml` (lines 74, 100, 113) and `plugin-catalog.yml`
(lines 29, 95, 166-172) assume the image is rebuilt in place, and `cdk-synth`
is `FROM pipeline-bootstrap:1.0`.

### How a run picks up a new release

```
run N   (template from run N-1: synth on cdk-synth@V1, default image pipeline-bootstrap@V1)
  synth step     cdk-synth@V1     pipeline-manager pipeline synth
                                    └─ lookup → resolveManagedToolchain → release V2
                                    └─ cdk.out: synth = cdk-synth@V2, codeBuildDefaults = pipeline-bootstrap@V2,
                                                cliVersion / cdkAssetsCliVersion = V2's toolchain
                                    └─ manifest (release V2) registered with the platform by this synth
  self-mutation  CURATED image    npm i -g aws-cdk@<pinned>; cdk -a <asm> deploy → restart     (D10)
run N+1  synth on cdk-synth@V2, default-image actions on pipeline-bootstrap@V2
```

- **Self-mutation doesn't re-synthesize** (verified against aws-cdk-lib 2.275
  `pipelines`): it installs `aws-cdk@${cliVersion}` and runs `cdk -a <asm>
  deploy`. On the curated image, a bad `pipeline-bootstrap@V2` can't stop it
  deploying a template that rolls back.
- **A bad `cdk-synth@V2`** breaks the synth step, which runs on the digest baked
  into the template. Such a pipeline can't heal itself (§9).

### Target model

```
resolveManagedToolchain(caller: { orgId }, releasePin?)      ← pipeline-data, elevated reads
  release pin given   → that release if it EXISTS; yanked/deprecated/ex-canary ⇒ resolves + warning; deleted ⇒ 404
                        (eligibility, D15, is enforced when the pin is SET, not here)
  else org default    → nearest org_toolchain_default walking caller → … → root   (same existence rule)
  else canary         → nearest toolchain_rollout membership walking caller → … → root (one per org)
  else platform       → toolchain_platform_default
  else                → 409 TOOLCHAIN_NO_DEFAULT   (never "highest version")
  returns { releaseVersion, resolvedVia, bootstrap: Plugin, synth: Plugin }   both halves of ONE release
  never returns rollout membership or other orgs' defaults

callers: /plugins/lookup + /plugins/find (plugin service) · pipeline contract check (api/pipeline)
         · declared-resolution refresh (api/plugin) · compliance step facts (api/compliance)
         · plugin upgrades + AI plugin catalog (api/pipeline) · similar-plugin lookup (api/plugin)
         · every pluginResolutionOrderBy row query and the row branch of /plugins/lookup

pipeline-manager pipeline synth
  ├─ resolvePluginsForProps(props)          a managed cdk-synth ref sends releasePin = props.toolchain?.release
  └─ resolveBootstrapImage(client, props)   sends the same releasePin; FATAL on any failure
PipelineBuilder
  ├─ codeBuildDefaults.buildImage           = resolveDefaultBuildImage(scope, orgId, resolvedBootstrap)
  ├─ selfMutationCodeBuildDefaults.image    = curated aws/codebuild/standard:8.0 (D10)
  ├─ cliVersion / cdkAssetsCliVersion       = resolvedBootstrap.toolchain
  └─ stepManifest.recordBuildImage(resolvedBootstrap)   platform-side record of the release (§4, §7)
```

The bootstrap reference is **not** a step. `collectPluginRefs` is a private
CLI helper (`pipeline-manager/src/utils/plugin-resolver.ts:37`). The
deploy-time Lambda and the contract check walk steps with `collectPluginSteps`
(`pipeline-core/src/core/plugin-contract.ts:230`). Neither sees the bootstrap,
and `codeBuildDefaults` has no deploy-time fallback.

## How it works

### 1. Catalog: managed toolchain releases

- **Reserved names:** `pipeline-bootstrap` and `cdk-synth` are listed in
  `MANAGED_TOOLCHAIN_PLUGINS` (api-core). Only the system org may create rows
  with these names. A customer who wants a custom synth environment publishes
  it under another name.
- **Never listed (D5).** For managed names:
  - the upload route refuses `publishRequest=true`, and
    `load-plugin-worker.sh` stops sending it
  - ecosystem publish, submission, listing and install routes refuse them
    (`PLUGIN_MANAGED_NOT_LISTABLE`)
  - installs, implicit Official installs, the consumption policy and blocked
    listings don't apply
  - resolution reads system-org rows through `resolveManagedToolchain` (§2),
    never `selectListingVersion`. The image repository is `system/<name>`;
    `PLUGIN_IMAGE_REPOSITORY_RE` already allows it, and the registry token
    grants pull on `system/*` to any authenticated identity.
- **A release is one version for both halves (D6).** `pipeline-bootstrap@V`
  and `cdk-synth@V` share `V`, which is the **release version**. It is its own
  semver, starting at `1.0.0`, not the pipeline-manager version, which is
  recorded separately in `toolchain.pipelineManager`.
  - `sync-image-tags.sh` keeps a `sourceDigest` (a hash of both directories'
    build inputs: Dockerfiles, `ARG`s, base digests) in the bootstrap spec. When
    the hash changes, it bumps the patch of **both** specs' `version`, and a
    human bumps minor or major for notable or breaking changes.
  - So a pipeline-manager release, a `node:` digest bump from Renovate, or a
    Python update in `cdk-synth` each produce a new release.
  - `(name, version)` is unique, so the pair is unique.
  - **`sourceDigest` excludes the generated spec fields** (`version`,
    `toolchain`, `sourceDigest` itself), so re-running the script is
    idempotent.
  - **No dev overrides for managed images.** The base stage has no
    `PIPELINE_MANAGER_VERSION=latest` resolution and no in-place `--force`
    for managed names. Either would put different bits under the same `V`, or
    an image whose pipeline-manager disagrees with the spec's `toolchain`. A
    local experiment builds `pipeline-bootstrap:<V>-dev.<n>`, a prerelease that
    upload validation refuses for managed names.
- **Upload never promotes, and never overwrites.** For managed names,
  `deployVersion` skips `shouldBecomeDefault` and always writes
  `isDefault = false`. Managed rows never use `isDefault` at all; the platform
  default lives in `toolchain_platform_default`. An upload of an existing
  (name, version) gets 409 `PLUGIN_VERSION_IMMUTABLE`.
- **Toolchain metadata** on the bootstrap spec: `toolchain: { pipelineManager,
  awsCdk, cdkAssets, esbuild, pnpm, node }`. `sync-image-tags.sh` writes it from
  the Dockerfile `ARG`s, and upload validation refuses a spec whose `toolchain`
  disagrees with the image labels. The Dockerfile gains a pinned
  `CDK_ASSETS_VERSION` `ARG` and install; today there is no `cdk-assets` in the
  image.
- **Packaging (D4, D16): the toolchain's own source root.** `deploy/codebuild/`
  (which holds only this Dockerfile) and `build-codebuild-bootstrap.sh` are
  deleted. Both halves live in `deploy/toolchain/`, beside the plugin catalog
  (`deploy/plugins/`), not in it:

  ```
  deploy/toolchain/
    .gitignore           # image.tar, plugin.zip
    cdk-synth/           # git mv from deploy/plugins/infrastructure/cdk-synth (history kept)
    pipeline-bootstrap/
      Dockerfile         # git mv from deploy/codebuild/bootstrap/Dockerfile (history kept)
      config.yaml        # pluginSpec: plugin-spec.yaml; dockerfile: Dockerfile; buildType: build_image
                         #   (flipped to prebuilt + imageTag by build-plugin-images.sh, reverted on cleanup, like every plugin)
      plugin-spec.yaml   # name, version (= release), pluginType: BuildImage, toolchain:{…}, sourceDigest, description, category
      README.md          # what the image is; "version, toolchain and sourceDigest are generated, never edit by hand"
      image.tar          # gitignored; written by build-plugin-images.sh
  ```

  - **Placement:** the pair is one release, not catalog plugins, so it has its
    own root. The build and load scripts know it as a second source root
    (`TOOLCHAIN_DIR` in `common.sh`) and handle it first, outside their
    per-plugin catalog walk, so the walk needs no "skip `pipeline-bootstrap`"
    or "managed names first" special cases. `--category toolchain` selects it.
  - **Base stage:** `build-plugin-images.sh` builds it after the `_base`
    images and before any plugin. That stage pushes
    `library/pipeline-bootstrap:<V>` (the base `cdk-synth` builds `FROM`) and
    saves `image.tar`.
  - **Loader:** `load-plugins.sh` uploads both halves first, serially, through
    the ordinary plugin upload API, then walks the catalog.
- **Tables** (all six in the four `postgres-init.sql` copies, plus drizzle
  definitions; §12, §13):

  | Table | Holds | RLS |
  |---|---|---|
  | `toolchain_release(release_version PK, release_notes, created_at, created_by)` | one row per release; both plugin rows share `release_version` | system-org only |
  | `toolchain_platform_default(singleton PK, release_version, set_at, set_by)` | **the** platform default | system-org only |
  | `toolchain_default_history(id, release_version, previous_release_version, set_by, set_at, reason, kind)` | every platform-default change, where `kind` is `set` / `initial` / `restore` | system-org only |
  | `toolchain_rollout(org_id PK, release_version, added_by, added_at)` | canary membership, **one release per org**; `org_id` is a **member**, not an owner | system-org only |
  | `org_toolchain_default(org_id PK, release_version, set_by, set_at, reason)` | an org's override | dedicated policy: own `org_id` read/write; system-org read |
  | `org_toolchain_default_history(id, org_id, release_version, …)` | that org's changes | own `org_id` read; system-org read |

  These are **dedicated per-table policies**, not the generic loop
  (`postgres-init.sql:3073-3137`). That loop's system-org read carve-out would
  expose system rows to every org, and three of the tables have no owner
  `org_id`. There is no team-to-parent RLS read path: **inheritance is
  resolved in `resolveManagedToolchain` with elevated reads**, the same way
  `versionReferences` does (`runWithTenantContext({ isSuperAdmin: true })`).
  Customers never query these tables directly; they go through the §5 routes.
- **Fresh install:** `init-platform.sh` builds and uploads the first release,
  then sets it as the platform default with `kind: 'initial'` (D14). From then
  on there is always a default, and no default is an error (D11).

### 2. Resolution: one resolver, every caller

`resolveManagedToolchain` lives in **pipeline-data** beside `plugin-resolution.ts`,
because several of its callers resolve straight from the database without the
plugin service. Every path that can resolve a managed name calls it, and for a
managed name nothing else may answer:

| Caller | Today | Change |
|---|---|---|
| `/plugins/lookup`, `/plugins/find` (api/plugin) | row/listing resolution | managed name → `resolveManagedToolchain` |
| pipeline contract check (`api/pipeline/src/helpers/plugin-contract-check.ts:54-60, 166, 201`) | `resolveListingReference` from the DB | managed name → `resolveManagedToolchain` |
| declared-resolution refresh (`api/plugin/src/services/declared-resolution-refresh.ts:95`) | listing resolution | managed name → `resolveManagedToolchain` |
| compliance step facts (`api/compliance/src/helpers/pipeline-step-facts.ts`) | listing resolution | managed name → `resolveManagedToolchain` |
| plugin upgrades (`api/pipeline/src/helpers/plugin-upgrades.ts`) | listing version choice | managed names are never offered as upgrades; the toolchain moves through §6 |
| AI plugin catalog (`api/pipeline/src/services/plugin-catalog.ts`) | lists plugins | excludes `BuildImage`; offers `cdk-synth` as a synth choice with no version |
| similar-plugin lookup (`api/plugin/src/services/similar-plugin-lookup.ts:80`) | reads the system catalog for the AI generator's "similar plugins" hint | excludes both managed names |
| **row queries** via `pluginResolutionOrderBy` (`plugin-contract-check.ts:166`, `pipeline-step-facts.ts:176`, `similar-plugin-lookup.ts:80`, the row branch of `/plugins/lookup`) | owner-ranked row resolution. For a **system-org** caller, this would resolve a managed name from its own rows. Managed rows never have `isDefault`, so it would fall back to the highest version: an unpromoted release, which D11 forbids. | managed name → `resolveManagedToolchain`, for the system org too |
| deploy-time Lambda | posts to `/plugins/lookup` | unchanged; inherits the lookup change |

A contract test enumerates every `resolveListingReference`,
`selectListingVersion` **and `pluginResolutionOrderBy`** call site, plus the
row branch of `/plugins/lookup`. It fails if a new one can be reached with a
managed name without going through `resolveManagedToolchain`.

**What the resolver does:**

- **Reads system-org rows only, elevated.** It ignores
  `pluginResolutionOrderBy`'s owner rank, so a same-named row elsewhere is never
  a candidate.
- **Precedence:** release pin, then org default, then canary, then platform
  default.
  - **Walking the hierarchy:** for the org default and the canary, the resolver
    walks the caller's chain **from itself up to the root** (the same walk as
    `org-reachability.ts:47`, depth-capped like `reporting-retention.ts:74`).
    The **nearest** org that has an org default, or a canary membership, wins.
    A team's own setting beats any ancestor's.
  - **An org with its own default** has opted out of canaries, because the
    org default is checked first at every level.
  - **Canary membership is unique per org.** `toolchain_rollout` has primary
    key `org_id`, so an org is in at most one canary at a time. Adding it to
    another release moves it.
- **Eligibility (D15) is checked when a pin or org default is *set*, never at
  resolve time.** At set time the release must be live (both halves active,
  unyanked, not deprecated) and **either** appear in
  `toolchain_default_history` **or** be in canary for the caller.
- **At resolve time, a pin or org default needs only to exist** (both halves
  present and not deleted). If it is now yanked, deprecated, or a former
  canary release that was never promoted, it **still resolves**, with a
  warning that carries the reason. That is the exact-selection contract, the
  same one yanked pins already have. Its owners are notified (§10). Deletion
  can't happen underneath it, because in-use protection counts pins and org
  defaults (§4).
- **A canary candidate** is served only while it passes the §8 scan and
  metadata guards. If it stops passing, members fall through to the platform
  default.
- **Returns one release:** both halves, checked to share `releaseVersion`.
  Anything else is refused (`TOOLCHAIN_PAIR_MISMATCH`), never served.
- **No fallback:** no platform default returns 409 `TOOLCHAIN_NO_DEFAULT`.
- **Privacy:** the response carries `resolvedVia: 'pin' | 'org-default' |
  'canary' | 'default'` and nothing about other orgs.

**CLI:**

- **`resolveBootstrapImage(client, props)`** sends `{ name:
  'pipeline-bootstrap', releasePin: props.toolchain?.release }`. A managed
  `cdk-synth` reference sends the same `releasePin` through
  `resolvePluginsForProps`, so both halves come from one release.
- **Failure:** any failure is fatal (`BOOTSTRAP_IMAGE_UNRESOLVED`; D2). It
  sends `context: { pipelineId, stepKeys: ['build-image'] }`, so warnings land
  on the pipeline's "Build image" row.
- **Wiring:** `pipeline-config.ts` stores the result on
  `props.resolvedBootstrap`. Direct CDK consumers pass it themselves, and synth
  throws without it.
- **`pipeline deploy --local-spec`** deploys without contacting the
  platform (`pipeline-manager/src/commands/deploy.ts:39`). In that mode the CLI
  requires `--toolchain-file <path>`: a JSON export of a resolved release, from
  the new `pipeline-manager toolchain export --release <V>` (or the current
  default). It holds both halves' image digests, repositories and the
  toolchain. Without the file, local-spec deploys refuse with
  `BOOTSTRAP_IMAGE_UNRESOLVED` and say how to produce one.
- **`PluginLookup.bootstrap()`:** still the synth step when the synth plugin
  wasn't pre-resolved. It runs on the resolved bootstrap image. It needs the
  platform, like everything else under D2.

### 3. Synthesis

- **Default image:** `resolveDefaultBuildImage(scope, orgId, bootstrap:
  Plugin)` reuses `resolvePluginImage`: digest required,
  `system/pipeline-bootstrap`, external pull host, registry-push secret.
  - **Deleted:** the env-driven branches, `pinnedDefaultImageRef` and
    `curatedLinuxBuildImage`.
  - **Kept:** `STANDARD_8_0`, renamed `CURATED_SELF_MUTATION_IMAGE`, because
    D10 needs it as a curated image with CodeBuild credentials.
- **Call sites:** `codeBuildDefaults` (`pipeline-builder.ts:646`) and the
  plugin-less fallback in `createCodeBuildStep` (`pipeline-helpers.ts:642`).
- **Freeze removed:** `pipelineEnvVars` stops carrying `CODEBUILD_DEFAULT_IMAGE*`
  (`pipeline-builder.ts:603, 624-628`). The release is recorded **platform-side**
  in the step manifest (§4), not as a pipeline tag: tags live in the
  customer's account and can be changed there, and pipeline-events caches them
  for 15 minutes (`POS_CACHE_TTL_MS` in `pipeline-events/src/tags.ts`).
- **Self-mutation (D10):** `selfMutationCodeBuildDefaults.buildImage` is
  `CURATED_SELF_MUTATION_IMAGE`, with `cliVersion` pinned, and
  `partialBuildSpec.phases.install.runtime-versions.nodejs` pinned to a major
  in the CLI's `engines.node`. The step needs only Node and the CDK CLI. Its
  `npm install -g aws-cdk@<pin>` is the same install SelfMutate already runs
  today (unpinned, `@2`), so network requirements are unchanged.
- **Toolchain pin:**
  - `cliVersion` and `cdkAssetsCliVersion` come from
    `resolvedBootstrap.toolchain`.
  - Explicit pipeline metadata (`cliVersion`, `cdkAssetsCliVersion`,
    `selfMutationCodeBuildDefaults`, `assetPublishingCodeBuildDefaults`;
    `pipeline-core/src/core/metadata-builder.ts:43`) still wins.
  - npm `latest` is never used, because both CLIs are always pinned.
- **Cloud-assembly compatibility holds by construction.** Both halves come
  from one release, so `cliVersion` matches the CDK the synth image was built
  `FROM`. With a custom, non-managed synth plugin, the pipeline is flagged
  "toolchain unmanaged", and its owner sets `cliVersion` explicitly if needed.

### 4. Footprint: the release in the step manifest

- **The entry:** `StepManifestRecorder.recordBuildImage(plugin)` writes a
  `build-image` entry with `releaseVersion`, `imageDigest`, `imageRepository`
  and `resolvedVia`.
- **In-use protection:** the entry flows through the deploy-reference path,
  so `findVersionReferences` counts it, and in-use protection covers
  bootstrap rows. The synth half is already recorded as the synth step.
  Deleting a release checks references to **both** rows, and to org defaults
  and pipeline pins (§5).
- **"Deployed", not "declared":** the bootstrap isn't a step, so
  `pipeline_plugin_resolution` never records it. Adoption and in-use counts
  come from **deployed** manifests plus `toolchain.release` pins in pipeline
  configs; there is no "declared" count.
- **Reproducibility:** every deployed template records exactly which release
  it runs.

### 5. Who controls what

**Invariants:**

- **Only the system org publishes releases** and sets the platform default and
  canary membership.
- **Each org controls only itself.** It may set an org default from eligible
  releases (D15), which applies to it and its teams unless a team sets its own.
  It never sees or affects another org's choice.
- **A pipeline release pin** overrides everything for that pipeline, and is
  also limited to eligible releases.

| Level | Who sets it | Scope | Can choose |
|---|---|---|---|
| Platform default | system org, `toolchain:operate` (D9) | every org without an org default | any release passing the §8 guards |
| Canary | system org, `toolchain:operate` | member orgs without an org default | any release passing the §8 scan, metadata and pair guards |
| Org default | `toolchain:manage` holders (D13) | that org and its teams | an eligible release (D15) |
| Pipeline release pin | pipeline writers (`pipelines:write`) | one pipeline | an eligible release (D15) |

**Step-up applies to writes only, by people.** Every **write** route in this
section uses `requireStepUp` (`api-core/src/middleware/step-up.ts:181`), which
is always on. Reads (`GET`) never require step-up. It does not use
`requireOrgAdminAssurance` (`assurance.ts:172`), which reads the
`org_admin_aal` claim and is a no-op unless an org has opted into
"administrative actions require MFA". The org's policy still applies on top
where enabled.

**The one exception is D14's initial default.** `requireStepUp` refuses
service accounts outright (403 `STEP_UP_NOT_AVAILABLE`, `step-up.ts:226-227`),
and the initial default is set by a script. It gets its own route, gated by
identity rather than step-up (D14).

| Entry point | Read | Write |
|---|---|---|
| plugin upload / create | n/a | Managed name from a non-system org → 403 `PLUGIN_MANAGED_NAME_RESERVED`. `publishRequest=true` for a managed name → 400 `PLUGIN_MANAGED_NOT_LISTABLE`. It never sets `isDefault`. A prerelease version of a managed name → 400 `PLUGIN_MANAGED_PRERELEASE`. An existing (name, version) → 409 `PLUGIN_VERSION_IMMUTABLE`. |
| ecosystem publish / submission / listing / install | n/a | managed name → 400 `PLUGIN_MANAGED_NOT_LISTABLE` |
| `update-plugin.ts`, `version-lifecycle.ts`, `deleteVersion`, purge | n/a | managed name → 400 `TOOLCHAIN_USE_CONSOLE`, **for the system org too**. Release lifecycle exists only in the console routes, which act on both halves at once. |
| `/plugins/toolchain/releases/*` (console) | `toolchain:operate` | `toolchain:operate` + `requireStepUp`, audited |
| `/plugins/toolchain/initial-default` (D14) | n/a | the `deploy-bootstrap` **service principal** only, and only while no platform default exists; no step-up |
| `/plugins/toolchain/org-default` (+ `/history`) | caller's own org, `pipelines:read` | caller's own org, `toolchain:manage` + `requireStepUp`, eligibility (D15), audited |
| `/plugins/toolchain/eligible` | caller's own org, `pipelines:read`; returns only the releases that caller may pin or set | n/a |
| every resolver (§2) | `resolveManagedToolchain` only | n/a |

**Release lifecycle** (console only, acts on both halves):

- **Deprecate:** the release stays resolvable but stops being eligible for
  **new** org defaults and pins. Its rollout rows are removed. Audit
  `toolchain.release.deprecate`.
- **Yank:**
  - **Not the platform default:** both halves are yanked and the rollout rows
    removed. Existing pins and org defaults keep resolving it with a warning,
    which is the exact-selection contract; their owners are notified.
  - **The platform default:** the yank also **restores the previous default**
    from `toolchain_default_history` (`kind: 'restore'`, audit
    `toolchain.default.restore`), if that release is still live. A restore
    needs no canary gate, because that release already served as default, but
    it does need the scan and pair guards and `requireStepUp`. Otherwise the
    yank is refused with 409 `TOOLCHAIN_DEFAULT_REQUIRED` ("set another default
    first"). The newest release, or one in canary, is never promoted
    implicitly. `promoteNextDefault` is never called for managed names.
  - Audit `toolchain.release.yank`.
- **Delete / purge:** refused while any deployed manifest, pipeline pin or org
  default references the release (409 `PLUGIN_VERSION_IN_USE`). Audit
  `toolchain.release.delete`.

**Org default:**

- **Choice:** "Follow platform default (currently X)", or an eligible release.
  Choosing a release overrides the platform default and any canary for the
  org's unpinned pipelines.
- **Validation:** an ineligible release → 400 `TOOLCHAIN_RELEASE_NOT_ELIGIBLE`.
  Vulnerabilities found after promotion are warnings, not refusals.
- **Rollback:** "Revert to previous" (from `org_toolchain_default_history`),
  or "Follow platform default", which deletes the row.
- **Teams:** a team holding `toolchain:manage` sets its own default;
  otherwise it inherits its root org's.

**Pipeline release pin:**

```jsonc
{
  "plugin": { "name": "cdk-synth" },
  "toolchain": { "release": "1.4.2" },   // optional; omit = org default, canary or platform default
  "stages": [ ... ]
}
```

- **Pins the whole release.** A managed `cdk-synth` can't be pinned on its own
  (`plugin.filter.version` → `TOOLCHAIN_PIN_VIA_RELEASE`).
- **Checked only when the pin changes:** it must name an eligible release. A
  pipeline whose pinned release was later yanked can still be saved for
  unrelated edits.
- **Templates:** pipeline templates (`pipeline_templates.props`) never carry
  `toolchain`. Saving strips it, and instantiating ignores it (D12).
- **Escape hatch:** the raw `aws:cdk:codebuild:buildenvironment:buildimage`
  metadata key remains, per step.

### 6. Release, canary and promotion

**Producing a release (in the repo):**

1. Any change to either half's build inputs changes the `sourceDigest`. For
   example: a pipeline-manager release (via `sync-image-tags.sh`), a Renovate
   `node:` digest bump, or a `cdk-synth` edit.
2. `sync-image-tags.sh` bumps both specs' `version` (patch) and rewrites
   `toolchain` and `sourceDigest`. CI fails until it has been run
   (`toolchain-drift-contract`).
3. `release.yml` builds nothing. As today, images are built per deployment.

**Renovate `node:` digest PRs (runbook).** `sync-image-tags.sh` runs only in
`release.yml` (line 428), and `renovate.json` has no `postUpgradeTasks`. A
Renovate PR that bumps a base digest therefore stays red on
`toolchain-drift-contract` until someone runs the script on its branch. That
is accepted: a base bump **is** a new release and deserves a human look. The
runbook step is to check out the PR branch, run `deploy/bin/sync-image-tags.sh`,
commit and push. Two such PRs open at once both bump to the same patch, so the
second needs a rebase and a re-run after the first merges. The contract's
failure message names the command.

**Into each deployment (operator):**

1. `deploy/bin/upgrade-toolchain.sh` runs `build-plugin-images.sh --only
   pipeline-bootstrap,cdk-synth`, then `load-plugins.sh` for both, with
   `pipeline-bootstrap` first. It never promotes. `init-platform.sh` does the
   same on a fresh install, then sets the initial default (D14).
2. The release is now `available` in the console and reaches **no pipeline**.
   Uploads never promote, managed names are never listed, and pins and org
   defaults can only name eligible releases.

**Canary (console, D8):**

1. Add canary orgs (`toolchain_rollout`). Their unpinned pipelines without an
   org default resolve the release on their next run. The org picker flags
   orgs with their own default: "canary has no effect".
2. **Gate:** "Promote" stays disabled until the canary has **at least N synth
   runs across at least M orgs, and a failure rate within T points of the
   current default's** (defaults N=20, M=2, T=5, set on the console). Override
   requires a written reason, recorded in history and the audit log.

**Promote:** "Set as platform default" writes `toolchain_platform_default` and
`toolchain_default_history` (`kind: 'set'`) in one transaction. It clears the
release's rollout rows, recomputes "behind default" (§11), and notifies
customers (§10). Audit `toolchain.default.set` (with `gateOverride` details when
used). Canary membership changes are audited `toolchain.rollout.update`, and
release-note edits `toolchain.release.notes`. Orgs with their own default don't
move.

**Rollback:**

- **Normal:** "Set previous as default", an ordinary promotion through the §8
  guards. Its canary gate is waived because the release has already been
  default.
- **Orgs that chose the bad release as their own default** aren't moved;
  they're notified, and they revert.
- **Yank** of the default restores the previous one (§5).

**Custom synth plugins:** a pipeline whose synth plugin isn't the managed
`cdk-synth` runs whatever `pipeline-manager` its image carries, and is flagged
"toolchain unmanaged".

### 7. Watch and alert

**Where the data comes from.** pipeline-events is a Lambda **in the customer's
AWS account**. It emits no metrics; it POSTs CodePipeline state changes,
including Action Execution State Change events with `actionName`
(`events-stack.json:63-69`, `parse.ts`), to `/api/reports/events`
(`pipeline-events/src/index.ts:86`). So all toolchain run data is built
**platform-side, in `api/reporting`**, from the events it already receives:

- **Run rows, not a tag.** When the reporting ingest records a `synth` or
  `self-mutation` action outcome, it stamps the action row with
  `toolchain_release`. The value comes from the **platform's own** deployed step
  manifest for that pipeline (§4), as of the execution's synth, never from a
  customer-controlled pipeline tag. Tags can be changed in the customer's
  account, and pipeline-events caches them for 15 minutes, so a rolled-back
  stack would be counted against the wrong release.
- **No new ingest field and no customer redeploy.** The Lambda already sends
  everything needed. The release is joined platform-side, so customers don't
  have to update their events stacks.
- **Per-org data lives on the rows.** The §6 canary gate (N runs, M orgs, T
  points) and the §9 Affected view (latest synth failed, by org) are **queries
  over these rows**, which carry `org_id`. They are not derived from metric
  labels.
- **Metric (alerting only):** `api/reporting` emits
  `pipeline_toolchain_runs_total{toolchain_release, action, outcome}` from the
  same rows. The `action` label is `synth` or `self-mutation`, and the
  cardinality is a handful of releases × 2 × outcome.
- **Alert:** `PipelineToolchainFailureSpike` fires when a release's failure
  rate exceeds the platform default's by more than X points over 1h, with
  minimum volume. It is promtool-validated and satisfies the rule that
  `*_failed_total`-style series are alerted or exempted.
- **No auto-rollback:** it is outward-facing. The runbook action is "set
  previous as default".

**The gate is advisory, because outcomes are customer-reported.** The events
Lambda, its `pb_sa` key and its payloads are under the customer's control. This
is the known reporting-ingest cross-org residual, recorded as won't-do by
design. A canary org could forge run counts or outcomes, to open or hold the
gate. So:
- **Contributions are capped:** each org counts for at most `ceil(N / M)`
  runs toward N, so one org can't satisfy the gate alone.
- **The release isn't trusted from the payload:** it comes from the platform's
  manifest.
- **The gate informs a human; it isn't a security boundary.** The system-org
  operator still chooses to promote, and an override records a reason.
  Forging can at most make a canary look healthier or sicker than it is. It
  can never promote anything by itself.

### 8. Guards on "Set as platform default"

These are enforced in one service function, `setPlatformDefault`, used by the
console route, the D14 initial route and yank-restore. The UI only explains
them. Callers differ only in **authorization** (step-up for people, the
`deploy-bootstrap` identity gate for `initial`) and in which guards are waived,
as listed below.

- **Pair:** both halves exist, share `releaseVersion`, and are active,
  unyanked and not deprecated.
- **Scan:** both are scanned and within the fixable-Critical floor
  (`PLUGIN_VULN_MAX_CRITICAL`). This gates promotion only; vulnerabilities
  never block pipelines.
- **Metadata:** the bootstrap carries `toolchain` and it matches the labels.
- **Canary gate (§6)** has passed, or an override reason is given. The override
  is recorded in the `toolchain.default.set` audit details (`gateOverride:
  { reason }`). The gate is waived for `restore`, for re-promoting a former
  default, and for `initial`.
- **Scan floor for `initial`:** not waived. If a fresh install's release fails
  the fixable-Critical floor (a CVE published since the release was cut),
  `init-platform.sh` stops with `TOOLCHAIN_GUARD_VULN_FLOOR` and says how to
  proceed:
  - (a) produce a patched release (bump `sourceDigest`, rebuild), or
  - (b) re-run with `--accept-initial-vulnerabilities "<reason>"`, which passes
    an explicit, audited override (`toolchain.default.initial` details). That
    is the only override of the floor anywhere, and it applies only to the
    initial default.
- **Concurrency:** the request carries `expectedCurrentDefault`. A mismatch →
  409 `TOOLCHAIN_DEFAULT_CHANGED`. The singleton row is locked (`SELECT … FOR
  UPDATE`), so two admins can't race.
- **Step-up and confirmation** (people only; not `initial`): `requireStepUp`, and a confirmation that shows
  the blast radius: "N pipelines in M orgs follow the platform default and
  will move on their next run; Q orgs have their own default and P pipelines
  are pinned, so they won't move."

### 9. Recovery: pipelines that can't heal themselves

A release whose synth step fails strands pipelines on that `cdk-synth` digest.
D10 doesn't cover it, and the platform has no credentials in customer AWS
accounts. **This is the main recovery path for the likeliest failure, a
pipeline-manager bug.**

- **Affected view** (console): pipelines whose deployed release is R and whose
  latest synth failed, by org. Built from §4 manifests and the §7 run rows.
- **"Notify affected owners"** (confirmed, audited
  `toolchain.recovery.notify`): sends each owner
  `pipeline-manager pipeline deploy --id <id>`. Run from a workstation, it
  re-synthesizes against the restored default and deploys.
- **Runbook:** "My pipeline's synth step fails after a toolchain update", in
  `docs/pipeline-manager.md`.

### 10. Customer communication

- **Release notes:** `toolchain_release.release_notes`, edited in the console
  before promotion. They are shown in the org panel and the pipeline's "Build
  image" row.
- **On promotion:** through the existing notification paths (the ones
  `version-withdrawal` and plugin-security notifications use):
  - **Orgs following the platform default:** "Pipeline toolchain is updating
    to 1.4.2, effective on each pipeline's next run."
  - **Orgs with their own default:** "A newer platform toolchain (1.4.2) is
    available. Your org stays on 1.3.9 until you change it."
  - **Canary orgs:** notified when added.
- **Hygiene:** org admins are notified when their org default is yanked or
  deprecated, picks up a KEV or fixable Critical finding, or falls more than K
  releases behind the platform default (K=3).
- **Run history:** a "toolchain 1.4.1 → 1.4.2" marker on the first run after a
  change, from consecutive `build-image` entries.

### 11. Frontend

Built on `PluginDetailModal`, `PluginLifecycleModal`, `usePluginColumns` and
`useCrudResource`. Nav entries follow "locks, not hides".

**"Behind default" means the caller's effective default** (org default, else
platform default), never `isDefault`. Managed rows don't use `isDefault`, and
`refreshLatestForPlugin` is not called for them; "behind" is computed from
`resolveManagedToolchain`.

**System org: Toolchain console:** `frontend/pages/dashboard/toolchain.tsx`,
alongside the other system consoles (`build-queue`, `registry`, `admin`),
gated on `toolchain:operate`.

| Panel | Shows | Actions |
|---|---|---|
| Releases | release version, pipeline-manager / `aws-cdk` / `cdk-assets` versions, both digests, scan summary for both, status (`default` / `canary` / `available` / `deprecated` / `yanked`), release notes | Edit notes, Add canary orgs, Set as default, Deprecate, Yank |
| Canary | member orgs, org picker ("no effect" for orgs with their own default), run count, failure rate vs default, gate status | add or remove orgs, Promote (or override with a reason) |
| Adoption | pipelines per release across all orgs, from deployed manifests and pins: by `resolvedVia`, per org; orgs on each release by org default | drill-down, CSV export |
| Affected | the §9 view | Notify affected owners |
| History | `toolchain_default_history` (`set` / `initial` / `restore`) | Set previous as default |
| Cleanup | releases no deployed manifest, pin or org default references, older than the last K defaults (K=5) | Delete (in-use protection applies) |

**Organization settings: "Pipeline toolchain"** (editable with
`toolchain:manage`, read-only otherwise; teams get the same panel with
"Inherit from <root org>"):

- **Selector:** "Follow platform default (currently X)" or eligible releases,
  with notes, toolchain versions, scan summary, and "newer" / "older" labels.
- **Confirmation:** "N of your pipelines will move on their next run; P pinned
  pipelines won't." `requireStepUp` applies.
- **Status:** the effective release and why, canary status ("no effect while
  your org default is set"), and pinned and behind counts.
- **History** with "Revert to previous", and warnings (§10).

**Pipeline editor:** a "Toolchain" selector in advanced settings: "Org default
(currently X)" or "Platform default (currently X)", then eligible releases.
Yanked and deprecated releases are labelled and can't be newly selected. A
pinned pipeline shows "behind default". A managed `cdk-synth` step has no
version field.

**Pipeline security / detail:** a "Build image" row with release, digest,
`resolvedVia`, scan state, warnings, "behind default" or "toolchain
unmanaged", plus the run-history markers.

**Generic plugin UI:** `EditPluginModal` and `PluginLifecycleModal` hide
default, yank and delete for managed names and link to the console. The routes
enforce the same rule (§5). `BuildImage` plugins don't appear in step pickers.

**Help:** a "Pipeline toolchain" topic in `frontend/src/lib/help/`, plus
regenerated env-var, audit-event and plugin-publishing help.

### 12. Deploy scripts

The four target trees (`deploy/local/docker`, `deploy/local/minikube`,
`deploy/aws/ec2`, `deploy/aws/eks`) stay standalone: each copy is edited, and
drift is caught by contract tests, never by a shared base.

**Image build**

| File | Change |
|---|---|
| `deploy/codebuild/bootstrap/Dockerfile` → `deploy/toolchain/pipeline-bootstrap/Dockerfile` | `git mv`, then delete `deploy/codebuild/`. Add toolchain `LABEL`s (`org.pipeline-builder.toolchain.pipeline-manager`, `.aws-cdk`, `.cdk-assets`, `.esbuild`, `.pnpm`, `.node`), each from its `ARG`. Add the pinned `CDK_ASSETS_VERSION` `ARG` and install. |
| `…/pipeline-bootstrap/config.yaml` (new) | `pluginSpec: plugin-spec.yaml`, `dockerfile: Dockerfile`, `buildType: build_image`. It is flipped and reverted by `build-plugin-images.sh` like any plugin. |
| `…/pipeline-bootstrap/plugin-spec.yaml` (new) | `name`, `version` (release), `pluginType: BuildImage`, `toolchain`, `sourceDigest`, `description`, `category`. The `version`, `toolchain` and `sourceDigest` fields are generated. |
| `…/pipeline-bootstrap/README.md` (new), `deploy/toolchain/.gitignore` (new) | What the image is and how it's released; ignore `image.tar` / `plugin.zip` |
| `deploy/bin/common.sh` | `TOOLCHAIN_DIR` (`deploy/toolchain`), `MANAGED_TOOLCHAIN_PLUGINS` (build/load order) and the `toolchain` pseudo-category, shared by every script that knows the second root. |
| `deploy/bin/build-codebuild-bootstrap.sh` | **Deleted (D16).** Its duties move to the base stage below: tag, grype, `library/` push, `PIPELINE_MANAGER_VERSION=latest` resolution, `--force`, `DEPLOY_TARGET` transports, `PUBLISH_PLATFORM`, and the digest. |
| `deploy/bin/build-plugin-images.sh` — base stage | After `_base`, before any plugin: build `pipeline-bootstrap:<V>`, run grype `--only-fixed --fail-on "$GRYPE_FAIL_ON"`, and push `library/pipeline-bootstrap:<V>`. It **refuses to re-push** an existing version (`--force` rebuilds locally only). Then save `image.tar` and export the digest. Adds `--only <names>` (searches the toolchain root and the catalog) and `--category toolchain`. `--reset` also reverts the toolchain root's `config.yaml`s. |
| `deploy/bin/build-plugin-images.sh` — `cdk-synth` and loop | Build `cdk-synth` from the toolchain root right after the base stage, outside the catalog walk, with `BOOTSTRAP_IMAGE=<registry>/library/pipeline-bootstrap@<digest>` (one shared `build_plugin_dir` serves it and the walk). One script means one `PUBLISH_PLATFORM`, which removes today's amd64-vs-host-architecture mismatch. The catalog walk never sees either half, so it has no toolchain special case. |
| `deploy/bin/sync-image-tags.sh` | Its `_bootstrap` path (line 248) moves to `deploy/toolchain/pipeline-bootstrap`, cdk-synth's to `deploy/toolchain/cdk-synth`. The hash frames each file by `<dir basename>/<file>`, so the move itself doesn't change it. It computes `sourceDigest` over both directories. On change it bumps both specs' `version` (patch) and writes `toolchain` from the `ARG`s. Deterministic yq writes, idempotent. |
| `deploy/plugins/infrastructure/cdk-synth/` → `deploy/toolchain/cdk-synth/` (`Dockerfile`, `plugin-spec.yaml`) | `git mv`. `ARG BOOTSTRAP_IMAGE` replaces `FROM pipeline-bootstrap:1.0`. `version` = release, written by `sync-image-tags.sh`. |
| `deploy/bin/push-base-images.sh` | Derive the bootstrap tag from the spec, not `1.0`. |
| `deploy/bin/scan-pinned-images.sh` | Its `BOOTSTRAP_IMAGE_REF` defaults to the current platform default's digest from the catalog; the stale comment mentioning `CODEBUILD_DEFAULT_IMAGE` goes. |
| `deploy/bin/report-plugin-go-stdlib.sh` | Walks the catalog only: the toolchain root has no upstream build-stage image to report, so its `pipeline-bootstrap*` exclusion is dropped. |
| `deploy/bin/verify-plugin-urls.sh` | Also walks the toolchain root (the bootstrap downloads the AWS CLI); `toolchain/<name>` selects one half. |

**Catalog load, install and upgrade**

| File | Change |
|---|---|
| `deploy/bin/load-plugins.sh` | Uploads as the system-org `official-catalog-loader` (`common.sh:1325-1328`). Uploads both halves from `deploy/toolchain/` first and serially, `pipeline-bootstrap` before `cdk-synth`, on an unfiltered run or `--category toolchain`; then walks the catalog with no managed-name special case. A missing half fails the run. Sends no `publishRequest` for managed names (with `load-plugin-worker.sh`). Fails if `pipeline-bootstrap/image.tar` is missing. Its reconcile (~line 247) checks both halves of each release uploaded. |
| `deploy/bin/test-plugins.sh` | Also walks the toolchain root (`toolchain/<name>`; its directories must be the managed names, in place of the category check). Skip `pluginType: BuildImage`. |
| `deploy/bin/init-platform.sh` | `build-plugin-images.sh --only pipeline-bootstrap,cdk-synth`, then upload both (the plugin load is passed `--category toolchain,<catalog categories>`; the catalog build gets the catalog categories only). Uploads answer 202 and build, sign and scan asynchronously, so init **blocks until both halves are built and scanned**. It polls with a hard timeout and **fails** the run on timeout. The loader's soft verify (`load-plugins.sh` ~241) and `--no-verify` aren't enough here. For managed names it refuses `--continue-on-build-failure` / `SKIP_MISSING_IMAGE_TAR` and keeps the scan-refused image rather than storing it (`load-plugin-worker.sh:82, 150`). Then it calls the D14 route; on `TOOLCHAIN_GUARD_VULN_FLOOR` it stops with the §8 remediation. The `BUILD_BOOTSTRAP` prompt and opt-out (lines 323-350) are removed. `FORCE_REBUILD_ALL` rebuilds non-managed plugins only (managed images have no in-place `--force`, §1). |
| `deploy/bin/upgrade-toolchain.sh` (new) | Build and upload a new release; never promotes. Supports `DEPLOY_TARGET=docker\|minikube\|ec2\|eks`. Idempotent per version. |
| `deploy/bin/post-provision-smoke.sh` | Assert a platform default exists and both halves resolve for a smoke org. |
| `deploy/*/bin/setup.sh` (×4), `deploy/aws/ec2/bootstrap.sh` | Reach the toolchain step through `init-platform.sh`, asserted by `bringup-contract`. |
| `.github/workflows/plugin-catalog.yml` | Path trigger `deploy/toolchain/**`. `select` lists the toolchain root as `toolchain/<name>` entries (category `toolchain`); a `deploy/toolchain/` change selects both halves (no catalog plugin builds FROM the bootstrap). The tag grep and context mapping (lines 166-172) resolve `toolchain/<name>` under `deploy/toolchain/`. `plugin-urls.yml` gains `deploy/toolchain/**/Dockerfile`. |
| `.github/workflows/plugin-base-freshness.yml` | The matrix `ctx` (line 74) moves to `deploy/toolchain/pipeline-bootstrap`, with the tag from the spec (lines 74, 100, 113). A red run is fixed by a `sourceDigest` bump, which produces a new release. |
| `renovate.json` (line 276) | `deploy/codebuild/**` → `deploy/toolchain/**`, or `node:` digest bumps stop arriving. |
| `projenrc/workflow.ts` (generated `test.yml`) | The service-Dockerfile smoke build excludes `deploy/toolchain/` as it does `deploy/plugins/` (cdk-synth builds FROM a bootstrap tag only `plugin-catalog.yml` builds). `.projenrc.ts` adds `deploy/toolchain` to the `plugin` and `frontend` nx test inputs. |
| `pipeline-manager` `agent/targets.ts` (209-210), `commands/provision.ts` (105, 109), `test/provision-targets.test.ts` | Drop `deploy/codebuild` from checkout paths. `TOOLCHAIN_SPARSE_PATHS` = `deploy/plugins/_base` + `deploy/toolchain`; `--build-bootstrap` runs `build-plugin-images.sh --only pipeline-bootstrap` from them. |

**Schema, environment and docs**

| File | Change |
|---|---|
| `deploy/{local/docker,local/minikube,aws/ec2,aws/eks}/postgres-init.sql` | The six tables and their dedicated policies (§1), identical in all four copies |
| `deploy/bin/backup.sh` / `restore.sh` | No change (`pg_dump` covers everything); a restore round-trip test covers the six tables |
| 4× `.env.example`, `docker-compose.yml:304` | Delete `CODEBUILD_DEFAULT_IMAGE[_DIGEST]`. No k8s manifest references them. |
| `deploy/README.md` | Inventory (line 52): add `upgrade-toolchain.sh`, remove `build-codebuild-bootstrap.sh`. Line 77: drop `codebuild/`. |
| each target `README.md` | An "Upgrading the pipeline toolchain" section |
| `docs/pipeline-manager.md`, `packages/pipeline-manager/README.md`, `docs/aws-deployment.md` (incl. the `BOOTSTRAP_IMAGE_TAG` table ~992-1001), `deploy/plugins/README.md`, `cdk-synth/README.md` | Replace the env-var/restart flow and every old path with §6 |

### 13. Contracts, error codes, audit actions

**Schema contracts.** The six tables need drizzle definitions in
`packages/pipeline-data/src/database/schema/`. They are checked by:
- `schema-reflection.test.ts` (drizzle against postgres-init)
- `postgres-init-rls-drift.test.ts` (the dedicated policies)
- `bringup-contract.test.ts:259-264` and `postgres-replica-contract.test.ts:506-508`
  (the four copies)

**Deploy contracts:**

| Test | Assertion |
|---|---|
| `hardening-contract.test.ts` | Re-pointed, not dropped: the `SERVICE_DIRS` entry (line 30) moves to the new directory; the script entry (line 367) and grype fail-on (line 439) move to `build-plugin-images.sh`; the pinned-`PIPELINE_MANAGER_VERSION` check (lines 433-436) moves too. Added: each `LABEL` equals its `ARG`. |
| `toolchain-drift-contract.test.ts` (exists, extended) | Both specs share `version`; `sourceDigest` matches the current inputs (otherwise run `sync-image-tags.sh`); `toolchain` equals the `ARG`s; `cdk-synth` uses `ARG BOOTSTRAP_IMAGE`; no literal bootstrap tag anywhere; `deploy/codebuild` and `build-codebuild-bootstrap.sh` are referenced nowhere |
| `env-contract.test.ts`, `app-env-split-contract.test.ts` | Updated in the same change as the env-var deletion |
| `bringup-contract.test.ts` | Every target reaches the toolchain step |
| new resolver-coverage test | Every `resolveListingReference` / `selectListingVersion` call site rejects or reroutes managed names |

**New error codes** (`packages/api-core/src/types/error-codes.ts`):

| Code | Status | When |
|---|---|---|
| `BOOTSTRAP_IMAGE_UNRESOLVED` | CLI | The CLI can't resolve the bootstrap (D2), including local-spec without `--toolchain-file` |
| `TOOLCHAIN_NO_DEFAULT` | 409 | No platform default exists (D11) |
| `TOOLCHAIN_PAIR_MISMATCH` | 500 | The resolver found halves with different versions (a bug, never served) |
| `TOOLCHAIN_RELEASE_NOT_ELIGIBLE` | 400 | A pin or org default names an ineligible release (D15) |
| `TOOLCHAIN_PIN_VIA_RELEASE` | 400 | A managed `cdk-synth` step carries its own version |
| `TOOLCHAIN_USE_CONSOLE` | 400 | A generic plugin route was called on a managed name |
| `TOOLCHAIN_DEFAULT_REQUIRED` | 409 | Yanking the default with no live previous default |
| `TOOLCHAIN_DEFAULT_CHANGED` | 409 | `expectedCurrentDefault` mismatch |
| `TOOLCHAIN_INITIAL_ALREADY_SET` | 409 | A second D14 initial call |
| `TOOLCHAIN_GUARD_UNSCANNED`, `_VULN_FLOOR`, `_METADATA`, `_PAIR_INCOMPLETE`, `_CANARY_GATE` | 409 | One per §8 guard |
| `PLUGIN_MANAGED_NOT_LISTABLE` | 400 | A managed name in a publish, listing or install path |
| `PLUGIN_VERSION_IMMUTABLE` | 409 | Re-uploading an existing managed version |
| `PLUGIN_MANAGED_NAME_RESERVED` | 403 | A non-system org creating a managed name |
| `PLUGIN_MANAGED_PRERELEASE` | 400 | Uploading a prerelease (dev) version of a managed name |

**New audit actions** (`audit-context.ts`, `docs/audit-events.md`):
- `toolchain.default.set`, `.initial`, `.restore`
- `toolchain.rollout.update`
- `toolchain.release.notes`, `.deprecate`, `.yank`, `.delete`
- `toolchain.recovery.notify`
- `toolchain.org_default.set`, `.clear`

## Decisions

| # | Decision | Resolution |
|---|---|---|
| D1 | What moves the platform default? | **Only `setPlatformDefault`:** an explicit promotion, the D14 initial call, or the yank-restore of the previous default. All three go through the §8 guards, with the canary gate waived for the latter two. Uploads, yanks of non-default releases and generic routes never move it. |
| D2 | Bootstrap unresolved at synth? | **Fail (`BOOTSTRAP_IMAGE_UNRESOLVED`).** This is forced: `codeBuildDefaults` has no deploy-time fallback. Local-spec deploys supply `--toolchain-file`. |
| D3 | Re-run pipelines on promotion? | **No.** Pipelines move on their next run. |
| D4 | Packaging | **Plugin-shaped directories in the toolchain's own root**: `deploy/toolchain/pipeline-bootstrap/` (`Dockerfile`, `config.yaml`, `plugin-spec.yaml` with `pluginType: BuildImage`) beside `deploy/toolchain/cdk-synth/`, built by `build-plugin-images.sh` and loaded by `load-plugins.sh` through the ordinary plugin upload API, first and outside the catalog walk. Its pull path is the one every system plugin already uses (Phase 0 table). |
| D5 | How do managed names reach orgs? | **Never listed.** System-org rows only, through `resolveManagedToolchain`. No publish request, listing, install or consumption policy. Building on listings was rejected: frozen listings conflict with yank-and-restore, and implicit installs plus auto-approval make the version uncontrollable. |
| D6 | Version scheme | **One release version for both halves**, its own semver. Patch is bumped automatically on any `sourceDigest` change; minor and major by hand. pipeline-manager's version is recorded in `toolchain.pipelineManager`, so base-image CVE fixes ship without a pipeline-manager release. |
| D7 | Org-level default? | **Yes**, from eligible releases only (D15), for the org and its teams unless a team sets its own. Orgs never publish releases or affect other orgs. |
| D8 | Staged rollout | **Canary per release**, in a system-only table, gated on N runs, M orgs and a failure rate within T points of the default, then promoted. An org default beats canary. No percentage rollout and no prerelease channel in v1. |
| D9 | Who operates it? | **A new `toolchain:operate`** (named after `billing:operate`), in `SYSTEM_ORG_ONLY_PERMISSIONS` and the `platform_operator` bundle, plus `requireStepUp`. It must be system-org-only: `ADMIN_PERMISSIONS` derives from `ORG_ASSIGNABLE_PERMISSIONS` (`permissions.ts:496, 569-575, 669-680`), so otherwise every tenant Admin would hold it. |
| D10 | What runs self-mutation? | **The AWS curated `standard:8.0`** with pinned `cliVersion`. A base-image defect can always be rolled back. It does not protect the synth step (§9). It adds no new egress (SelfMutate already npm-installs `aws-cdk` today), and the Node runtime is **pinned** through `partialBuildSpec` `runtime-versions`, checked against the CLI's `engines` by a contract test. |
| D11 | No default exists? | **409 `TOOLCHAIN_NO_DEFAULT`**, never "highest version". |
| D12 | Templates with a pin? | **Stripped.** Templates never carry `toolchain`. |
| D13 | Who sets an org default? | **A new org-assignable `toolchain:manage`**, held by Admin and Owner, plus `requireStepUp`. See below. |
| D14 | First default on a fresh install | **A dedicated route, `POST /plugins/toolchain/initial-default`, calling `setPlatformDefault(kind: 'initial')`**, allowed only while no platform default exists. It is **identity-gated, with no step-up**: the caller must be the `deploy-bootstrap` **service principal** (`isServicePrincipalNamed(req, 'deploy-bootstrap')`, `service-tokens.ts:170`), the ES256 token the deploy scripts already sign (`build-plugin-images.sh:265`). `deploy-bootstrap` is an **opt-in** signer (the least-privilege fix, `dab54d260`): every `requireAuth` rejects it unless the route names it, so this route opts in with `requireAuth({ acceptServices: ['deploy-bootstrap'] })` and no other plugin route can admit it. Its token carries no superadmin anywhere. Two alternatives fail: `official-catalog-loader` is a service **account** (`principalType: 'service_account'`), which `requireServicePrincipal` rejects (it requires `'service'`) and `requireStepUp` refuses (403 `STEP_UP_NOT_AVAILABLE`), and its custom Role can't hold system-only `toolchain:operate`. Audit `toolchain.default.initial`. A second call → `TOOLCHAIN_INITIAL_ALREADY_SET`. |
| D15 | What can a pin or org default name? | **Eligible releases only:** live, both halves complete, and either previously the platform default or currently in canary for the caller. |
| D16 | `deploy/codebuild/` and its script? | **Consolidated and deleted** (option b). The Dockerfile moves with `git mv` to `deploy/toolchain/pipeline-bootstrap/`, and `cdk-synth` moves from `deploy/plugins/infrastructure/` beside it; the script's duties move into `build-plugin-images.sh`; no wrapper is left. Why `deploy/toolchain/` and not the catalog: the pair is one release, not catalog plugins; its own root removes the generic loop's special cases. |

### D13 — why a new permission

`permissions.ts` splits permissions **by blast radius**, by "what a mistaken
grant costs". An org default changes the toolchain of every pipeline in the
org on its next run.

| Option | Verdict | Why |
|---|---|---|
| `pipelines:write` | Rejected | Far too broad: anyone editing one pipeline could move all of them. |
| `plugin_installs:manage` | Rejected | It is the closest match ("the org's consumption policy… org-local only") but a different blast radius: it governs future installs, not running pipelines. Sharing it would grant one silently with the other. |
| **New `toolchain:manage`** | **Chosen** | One permission for one effect, mapping one to one onto `toolchain.org_default.*` audit actions. |

- **Org-assignable**, so it is in `ORG_ASSIGNABLE_PERMISSIONS`, from which
  `ADMIN_PERMISSIONS` derives; Admin and Owner hold it automatically. It is not
  added to Member or any pipeline-editor seed. Orgs can grant it to a custom
  Role.
- **It never confers** anything on the platform default, canary or catalog,
  which stay with `toolchain:operate`.
- **`requireStepUp`** on every write. Members keep the read-only panel
  (`pipelines:read`) and release pins (`pipelines:write`).
- **Fail closed:** without it, writes return 403. Hidden UI is never the
  enforcement.
- **Contracts that move together** (each must actually run green):
  - `permissions.ts` and `docs/permission-contract.md`
  - the `api/plugin` route-permissions and route-table snapshot tests
  - `dynamicAuthz` declarations, verified against each route, never copied
  - frontend capability gating and the disposition map
  - audit context, docs and help

## Phases

Ordered so that nothing depends on a later phase.

**Status** (branch `feat/toolchain-releases`, one commit per phase, not pushed):

| Phase | State |
|---|---|
| 0 | No commit of its own: its checks are tests in the Phase 1–3 suites (synth shape, SelfMutate pin, engines contract, D14 identity) |
| 1 | Done — `e61d98b6c` |
| 2 | Done — `e08f52eb9` (+ `5111354be`, the post-rebase deploy-bootstrap signer fix) |
| 3 | Done — `331c94b6b` |
| 4 | Done — `b9f78643d` |
| 5 | Done — toolchain console |
| 6 | Pending |
| 7 | Pending |

**Merge units.** Phases 1, 2 and 3 are **one merge unit**: they are built and
committed in order on the branch, but nothing merges until all three are
green.
- Phase 1 alone breaks every customer synth: it takes managed names out of
  listings before the Phase 2 resolver exists.
- Phase 1 alone also leaves pipeline-core reading a `CODEBUILD_DEFAULT_IMAGE`
  that nothing builds any more.
- Phases 4, 5, 6 and 7 each merge on their own after that.

The §12 work is split explicitly by phase. "Everything in §12" is never a
phase item.

### Phase 0 — Local verification (no AWS account, no merge)

Nothing in this plan needs an AWS account to build or to verify before merge.
Every assumption is either (a) behaviour production already depends on today,
or (b) checkable against a **locally synthesized template**, code or fixtures.
Phase 0 records each check's result in the PR description.

| Assumption | How it's verified without AWS |
|---|---|
| CodeBuild can pull `system/pipeline-bootstrap@<digest>` with the registry-push secret (D4) | **Existing behaviour.** Every system-org plugin image (`cdk-synth` and the rest) is already pulled this way: `resolvePluginImage` builds `system/<name>@<digest>` with `secretsManagerCredentials`, and the registry token already grants pull on `system/*`. The bootstrap uses the same function (§3). A synth test asserts the CodeBuild project's `Image` and `RegistryCredential` match a plugin step's shape exactly. |
| Self-mutation installs the pinned CLI (D10) | **Read from the installed `aws-cdk-lib` 2.275** (`pipelines/lib/codepipeline/codepipeline.js`): SelfMutate runs `npm install -g aws-cdk@${cliVersion}` (default `"2"`) and then `cdk -a <asm> deploy`, with no re-synth. A synth test asserts the SelfMutate buildspec carries the exact pinned version. |
| npm egress for self-mutation (D10) | **Not a new requirement.** Every existing pipeline's SelfMutate already runs `npm install -g aws-cdk@2` (above), so any pipeline that works today already has npm egress, VPC-attached or not. Moving the step to the curated image changes the image, not the network path. |
| Node on `standard:8.0` satisfies the pinned `aws-cdk` CLI's `engines` (D10) | **Pinned, not assumed.** `selfMutationCodeBuildDefaults.partialBuildSpec` sets `phases.install.runtime-versions.nodejs` to a major that the CLI's `engines.node` accepts. The CLI's `package.json` is read locally, and a contract test fails if the pinned major falls outside `engines`. `standard:8.0`'s supported Node runtimes are taken from AWS's published image definition (`aws/aws-codebuild-docker-images`, `ubuntu/standard/8.0`), checked in as a constant with a source link. |
| The image runs as root, so global npm installs work | The curated image's default user is root, per its public Dockerfile in the same repo. The bootstrap image's root user is asserted by `hardening-contract` against the Dockerfile. |
| The run data's inputs exist (§7) | Code and fixtures: pipeline-events already forwards Action Execution State Change events with `actionName` (`events-stack.json:63-69`, `parse.ts`). `api/reporting` ingest tests replay recorded payloads and assert the action rows are stamped with the release from a seeded platform manifest. No tag and no customer-side change are involved. |
| D14's `deploy-bootstrap` identity works on the plugin service | A route test signs a `deploy-bootstrap` service token with the test key pair (as image-registry's tests do), and asserts that the initial route accepts it while every other toolchain route rejects it |
| D14's guard identifies `official-catalog-loader` | Code reading of `permission-gates.ts:189` and `common.sh` (~1325-1370), plus a route test with the loader's actual service-account token shape. |
| A non-step `build-image` manifest entry reaches `findVersionReferences` | An integration test against the local Postgres (the repo's existing integration harness). |
| §2 resolver inventory is complete | A grep-backed contract test (§13) that fails on an unrouted `selectListingVersion` / `resolveListingReference` call site. |

**Rejected for the record:** the `cdk-synth` image as `codeBuildDefaults`. It
runs as uid 1000, and the synth plugin is user-selectable.

**After merge, on any real deployment (not a merge gate):** the first real
pipeline run on a new release is observed through the §7 metric and the canary
gate, which exist for exactly this. The canary *is* the live verification.

### Phase 1 — Catalog, schema, deploy scripts (merge unit with Phases 2 and 3)

- **Managed names:** `MANAGED_TOOLCHAIN_PLUGINS`, the listing exclusion (D5),
  and refusals on generic routes (`TOOLCHAIN_USE_CONSOLE`).
- **Upload:** `deployVersion` never promotes managed names and refuses
  re-upload (`PLUGIN_VERSION_IMMUTABLE`).
- **Plugin-spec schema** (`api-core/src/validation/plugin-spec-schema.ts`):
  - `BuildImage` in `PLUGIN_TYPES` (line 26), exempted from `commands` in
    `pluginSpecRequiredFieldsProblem` (line 187)
  - a `BuildImage` spec must be `prebuilt`, carry `toolchain` and
    `sourceDigest`, carry no `commands` / `installCommands` / `metadata`, and
    use a managed name
  - the `toolchain` object schema
  - `BuildImage` excluded from step pickers, stage-step validation and AI
    selection
- **Tables:** the six tables with dedicated RLS in the four `postgres-init.sql`
  copies, drizzle definitions, and the four schema contracts (§13).
- **Deploy scripts in this phase** (the §12 subset):
  - **Image build:** the whole table. That covers consolidation (D16): the
    two `git mv`s into `deploy/toolchain/`, the deleted script and
    `deploy/codebuild/`, the toolchain root and its `common.sh` constants, the
    base stage and `--only`, `sync-image-tags.sh` with
    `sourceDigest`, the `cdk-synth` `ARG BOOTSTRAP_IMAGE`, and
    `push-base-images.sh` / `scan-pinned-images.sh`.
  - **Path re-pointing**, because the directory moves in this phase:
    `plugin-catalog.yml`, `plugin-base-freshness.yml`, `plugin-urls.yml`,
    `renovate.json`, `projenrc/workflow.ts` (regenerated `test.yml`), the
    `pipeline-manager provision` targets, `hardening-contract`,
    `toolchain-drift-contract`, and the doc and comment path references.
  - **Second-root walkers** (each also reads `deploy/toolchain/`):
    `test-plugins.sh`, `verify-plugin-urls.sh`, `sample-template-plugin-versions`,
    `plugin-spec-smoke`, the pipeline-manager `plugin-lint` suite and the frontend
    icon-set suite (`SOURCES.md` rows become `toolchain/<name>`).
  - **Loader:** the `load-plugins.sh` / `load-plugin-worker.sh` changes (the
    toolchain root first, `--category toolchain`) and the `test-plugins.sh`
    skip.
  - **Schema:** all four `postgres-init.sql` copies.
- **Not in this phase:**
  - `init-platform.sh`'s D14 call and its wait-for-scan, and `upgrade-toolchain.sh`
    (Phase 2, which needs the route)
  - `post-provision-smoke.sh` (Phase 2, which needs the resolver)
  - the env-var deletions (Phase 7)
- Tests:
  - managed upload never changes any default, including the first upload
  - a prerelease managed upload → `PLUGIN_MANAGED_PRERELEASE`
  - re-upload → 409
  - `publishRequest`, submission, install and generic lifecycle routes on
    managed names are refused
  - a customer org can't create a managed name
  - schema: `BuildImage` without `commands` validates; with `commands`, without
    `toolchain`, or under a non-managed name it is refused
  - `sync-image-tags.sh` bumps both versions on a `sourceDigest` change, and is
    idempotent
  - `build-plugin-images.sh`: base stage before `cdk-synth`, grype, `library/`
    push, refusal to re-push, the revert on cleanup, `--only`
  - `load-plugins.sh` order, and failure on a missing `image.tar` or half
  - `toolchain-drift-contract`: the root holds exactly the two halves, the
    catalog holds neither, and nothing references the old catalog paths
  - `provision --build-bootstrap` paths
  - RLS: customers can't read any `toolchain_*` table; an org reads and writes
    only its own `org_toolchain_default`
  - restore round-trip
  - all §13 deploy contracts

### Phase 2 — Resolver, platform-default service, synthesis (merge unit with Phases 1 and 3)

- **pipeline-data:** `resolveManagedToolchain` (precedence, eligibility, pair
  check, elevated reads, privacy), wired into **every** §2 caller, plus the
  resolver-coverage contract.
- **Platform-default service:** `setPlatformDefault` with the §8 guards.
  - The canary-gate check is stubbed **closed** until Phase 3's run rows exist.
    Until then the runnable paths are `initial`, `restore`, re-promoting a
    former default, and override-with-reason; all four waive or override the
    gate.
  - It also covers `toolchain_default_history` and the release lifecycle
    (deprecate, yank-restore, delete) as service functions.
  - Error codes and audit actions per §13.
- **D14 route:** `POST /plugins/toolchain/initial-default` with the
  `deploy-bootstrap` identity gate. The plugin service accepts the
  `deploy-bootstrap` signer for this route only.
- **Deploy scripts in this phase:**
  - `init-platform.sh`: build, upload, the blocking wait-for-scan with hard
    fail, the D14 call and the `--accept-initial-vulnerabilities` path
  - `upgrade-toolchain.sh`
  - `post-provision-smoke.sh`
  - the `bringup-contract` toolchain-step assertion
- **Save-time pin eligibility (D15):** the pipeline contract check refuses an
  ineligible `toolchain.release` **in this phase**, in the same change that
  introduces the field, so no window exists where a pin can name an
  unpromoted release.
- **pipeline-manager:**
  - `resolveBootstrapImage` and `releasePin` on managed `cdk-synth` refs
  - `toolchain export` and `--toolchain-file` for local-spec
  - error codes
- **pipeline-core:**
  - the `resolveDefaultBuildImage` rewrite and the `resolvedBootstrap` prop
  - `CURATED_SELF_MUTATION_IMAGE` for `selfMutationCodeBuildDefaults`
  - `cliVersion` / `cdkAssetsCliVersion` from the toolchain
  - the env-var carry removed
- **Pipeline schema:** optional `toolchain.release`; `TOOLCHAIN_PIN_VIA_RELEASE`
  on a managed `cdk-synth` version.
- Tests:
  - precedence across pin, org default, canary and platform default, walking
    a **three-level** chain (team → mid → root): the nearest setting wins
  - a second canary membership for an org moves it (PK `org_id`)
  - eligibility is enforced at set time; at resolve time a yanked, deprecated
    or ex-canary pin or org default still resolves with a warning
  - D14: the `deploy-bootstrap` token is accepted on the initial route and
    rejected on every other toolchain route; a service account is rejected;
    init waits for scan, hard-fails on timeout, and stops on the vuln floor
    unless the override is given
  - both halves always come from one release
  - customer same-named rows are never resolved through any of the §2 callers
  - no default → 409
  - a yanked pin resolves with a warning
  - no rollout data in responses
  - the template has no `CODEBUILD_DEFAULT_IMAGE*`, self-mutation is curated,
    and `cliVersion` / `cdkAssetsCliVersion` match
  - the Phase 0 synth assertions:
    - the default-image project's `Image` / `RegistryCredential` have the same
      shape as a plugin step's
    - the SelfMutate buildspec installs exactly `aws-cdk@<pin>` and sets
      `runtime-versions.nodejs`
    - a contract test fails if that Node major is outside the pinned CLI's
      `engines.node` or outside `standard:8.0`'s published runtimes
  - (the run-data tests are in Phase 3, with the reporting ingest)
  - local-spec without `--toolchain-file` is refused, and with it, it deploys
  - guards: each refuses with its own code
  - `expectedCurrentDefault` race
  - D14 once only, and identity-gated
  - yank-restore, and its refusal with no live previous default
  - rewrite the image assertions in `vuln-pipeline-surface.test.ts` and
    `pipeline-builder.test.ts`

### Phase 3 — Footprint and run data (merge unit with Phases 1 and 2)

- **Footprint:** `recordBuildImage` and its persistence in deploy references.
  In-use counts span both halves, pins and org defaults.
- **Run data (`api/reporting`):** stamp `synth` / `self-mutation` action rows
  with `toolchain_release`, taken from the platform's deployed manifest, and
  emit the `pipeline_toolchain_runs_total` metric. pipeline-events and its
  customer-side stack are unchanged.
- **Gate and alert:** the canary gate as a query over those rows (N runs, M
  orgs, T points, with each org capped at `ceil(N/M)`), turned on in
  `setPlatformDefault`, plus the `PipelineToolchainFailureSpike` alert
  (promtool).
- **Pipeline security:** the "Build image" row and run-history markers.
- Tests:
  - a release referenced only through `build-image`, a pin, or an org default
    → 409 on delete and purge
  - recorded CodePipeline payloads replayed through the reporting ingest stamp
    the release from the seeded manifest, never from a payload field or tag
  - the gate opens only at N/M/T, and one org can't satisfy N alone (the
    per-org cap)
  - route contracts, if the security response shape changes

### Phase 4 — Org default and pipeline pin

- **Capability:** `toolchain:manage`, with every D13 contract.
- **Routes** (caller's own org; reads need `pipelines:read`; writes need
  `toolchain:manage` + `requireStepUp` and are audited):
  - `GET    /plugins/toolchain/org-default`: effective release, `resolvedVia`,
    canary status, counts
  - `PUT    /plugins/toolchain/org-default` `{ releaseVersion, reason? }`
  - `DELETE /plugins/toolchain/org-default`
  - `GET    /plugins/toolchain/org-default/history`
  - `GET    /plugins/toolchain/eligible`, for the selectors (outside the
    console's `releases/*` prefix)
- **Templates:** strip `toolchain` (D12).
- **Frontend:** the org and team settings panel, and the pipeline-editor
  selector.
- **Notifications:** hygiene (§10), and yank notices to pinned pipelines and
  org defaults.
- Tests:
  - an org can set, clear and revert only its own default
  - Admin and Owner hold `toolchain:manage` and Member doesn't; a custom Role
    granted it works; `pipelines:write` and `plugin_installs:manage` give
    nothing here
  - step-up is required on writes even with the org MFA policy off, and never
    on reads
  - a Member (`pipelines:read`) can read the panel and the eligible list but
    can't write
  - org-default eligibility refusals
  - `toolchain:manage` gets 403 on every console route
  - templates never round-trip a pin
- **Docs:** `docs/pipeline-manager.md` (pin, local-spec, recovery runbook) and
  the pipeline configuration reference.

### Phase 5 — Toolchain console

- **Capability:** `toolchain:operate` in `SYSTEM_ORG_ONLY_PERMISSIONS` and
  `platform_operator`. Test: it's not in `ORG_ASSIGNABLE_PERMISSIONS` or
  `ADMIN_PERMISSIONS`, and a tenant Admin gets 403.
- **Routes** (system org, `toolchain:operate`; writes also need
  `requireStepUp` and are audited), wrapping the Phase 2 services:
  - `GET  /plugins/toolchain/releases`
  - `GET  …/releases/:v/adoption`
  - `PUT  …/releases/:v/rollout`
  - `POST …/releases/:v/default` `{ expectedCurrentDefault, overrideReason? }`
  - `PATCH …/releases/:v` `{ releaseNotes }`
  - `POST …/releases/:v/deprecate`, `/yank`; `DELETE …/releases/:v`
  - `GET  /plugins/toolchain/affected`, `POST …/affected/notify`
- **Frontend:**
  - `frontend/pages/dashboard/toolchain.tsx` (all §11 panels) and its nav
    entry
  - managed-name controls hidden in the generic modals
  - the help topic
- **Contracts:** the route-table snapshot, route-permissions,
  `docs/permission-contract.md`, the disposition map and audit docs.
- Tests:
  - console flows end to end through the Phase 2 services
  - non-system → 403
  - the blast-radius confirm
  - adoption equals in-use counts

### Phase 6 — CI, communication, end-to-end

- **CI:** already re-pointed in Phase 1. This phase adds the Renovate runbook
  (§6) to the contributing docs, and the `toolchain-drift-contract` failure
  message that names the command.
- **Notifications:** on promotion, to canary orgs, recovery; release notes in
  the org panel.
- **Bring-up:** the `post-provision-smoke.sh` toolchain check; target READMEs.
- **End-to-end on the local targets (`local/docker`, `local/minikube`), no AWS
  account:**
  1. Fresh install: the initial default is set and `post-provision-smoke.sh`
     passes.
  2. A second release via `upgrade-toolchain.sh`: uploaded, `available`,
     reaches no pipeline.
  3. Canary, promote, rollback and yank-restore through the console API.
  4. `pipeline-manager pipeline synth` against the local platform for a test
     pipeline after each step. The synthesized template is asserted to carry
     the expected release's two digests, the curated SelfMutate image, the
     pinned `cliVersion` / `cdkAssetsCliVersion` and the runtime-versions pin,
     and the platform's recorded manifest names that release.

  This exercises every platform-side path. Only CodeBuild executing the
  template is left, and it is covered by the Phase 0 table.
- **`aws/ec2` and `aws/eks`:** their deploy-tree changes (schema copies,
  `.env.example`, READMEs) are verified by the deploy contracts, which run
  without AWS. A live run on them is welcome when an account is at hand but is
  **not** a merge requirement.

### Phase 7 — Delete the env vars and leftovers

- **Remove `CODEBUILD_DEFAULT_IMAGE[_DIGEST]` from:**
  - `infrastructure-config.ts`, `config-types.ts` and
    `infrastructure-config.test.ts`
  - `registry-pull-guard.test.ts` and `step-manifest.test.ts` (both set it)
  - the four `.env.example` files and `docker-compose.yml:304`
  - `docs/environment-variables.md`, `docs/aws-deployment.md` and the plugins
    README
  - the regenerated `env-variables.ts` help
- **Remove the stale `pipeline-bootstrap:1.0` / `standard:7.0` comments** in
  `pipeline-helpers.ts`, `plugin-lookup.ts`, `pipeline-builder.ts`, the
  bootstrap Dockerfile, `init-platform.sh` and `push-base-images.sh`.
- **Env contracts** are updated in the same change, never split.

## Risks

- **Broken synth step strands pipelines.** This is the likeliest failure, and
  D10 doesn't cover it. The defences are the run-count canary gate, the guards
  and the alert; recovery is §9. Residual risk: affected owners must run one
  command.
- **D10 costs nothing new.** SelfMutate already npm-installs `aws-cdk` on every
  run today. The change pins the version and swaps the image.
- **CodeBuild execution itself isn't exercised before merge.** Everything up
  to the synthesized template is tested locally. What CodeBuild does with the
  template rests on behaviour production already depends on (Phase 0 table).
  The first real runs of a new release are watched by the canary gate and the
  §7 alert, which is the purpose of the canary.
- **Org-default and pin drift.** These are respected, never overridden, and
  surfaced through "behind default", hygiene notices and vulnerability notices.
  A platform rollback doesn't reach orgs with their own default, by design.
- **Footprint and resolver coverage are load-bearing.** Phases 2 and 3 ship
  together. Phase 7 merges after both. The resolver-coverage contract stops a
  new listing-resolution call site from silently serving a managed name.
- **The canary gate reads customer-reported outcomes.** Forging can skew it
  but can't promote anything. Mitigations: per-org caps, the release taken from
  the platform's manifest, and a human promotion decision (§7). This is the
  existing reporting-ingest residual, accepted by design.
- **Merge unit 1–3 is large.** It is built and committed phase by phase on the
  branch, with the full gate run after each phase, and merged only when all
  three are green.
- **Default blast radius.** One action moves every pipeline following the
  platform default. The mitigations are the canary gate, server-side guards, a
  precondition, step-up, a confirm with counts, notifications and one-action
  rollback, all enforced in `setPlatformDefault`.
- **Reserving `cdk-synth` and unlisting it.** Customers can't publish a row
  named `cdk-synth`, and the existing Official `cdk-synth` listing does not
  exist on fresh installs (no migration).
- **Gate verification.** Verify with `nx run-many -t build --all`, not jest
  alone, and confirm every gate step actually ran.
