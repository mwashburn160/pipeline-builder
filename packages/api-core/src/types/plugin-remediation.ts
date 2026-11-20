// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Nightly plugin CVE remediation (docs/plugin-publishing.md "Scan gates"): the
 * shared vocabulary of the remediation job (plugin service), the pipeline
 * rollout (pipeline service), the settings and the dashboard.
 *
 * A remediation is one record per flagged plugin version (`plugin_remediations`)
 * that moves through {@link PLUGIN_REMEDIATION_STAGES}: Stage 1 rebuilds the
 * version on a freshly pulled base, Stage 2 upgrades the named Critical/High
 * libraries by package type, the fix is published as the next free patch (or
 * minor) version, and Stage 3 moves pipelines onto it.
 *
 * Dependency-free apart from the semver module, so the browser loads it through
 * `@pipeline-builder/api-core/plugin-scan` (which re-exports this module).
 * Nothing here reads the environment: the env NAMES and defaults are constants,
 * and each service reads them with a literal envInt / envBool / envStr call (the env name spelled out) so the
 * env-documented guard sees them.
 */

import type { PluginScanFinding, PluginScanFindingLocation } from './plugin-scan.js';
import { parseSemver } from '../utils/semver.js';

// =============================================================================
// Package types (grype `artifact.type`)
// =============================================================================

/**
 * The grype package types remediation knows how to reason about, plus `other`
 * for anything grype reports that is not in this list (no patcher, no overlay:
 * it always goes to the owner request).
 */
export const GRYPE_PACKAGE_TYPES = [
  'deb', 'apk', 'rpm', 'npm', 'python', 'go-module', 'java-archive', 'gem', 'rust-crate', 'dotnet', 'binary', 'other',
] as const;
export type GrypePackageType = typeof GRYPE_PACKAGE_TYPES[number];

/** How a source patch is possible for a package type. */
export type SourcePatchSupport =
  /** Edit a manifest / lockfile / Dockerfile install line in the kept build context. */
  | 'yes'
  /** Only when the Dockerfile pins the tool's version with a recognised ARG. */
  | 'pinned-arg'
  | 'no';

/** What the patchers need to know about one package type. */
export interface GrypePackageTypeSpec {
  label: string;
  /** A distro package: the upgrade level applies to the upstream version, a revision bump is a patch, an epoch change a major. */
  osPackage: boolean;
  /** Compiled into a binary: a fix needs a source rebuild; no overlay. */
  compiled: boolean;
  sourcePatch: SourcePatchSupport;
  /** An overlay layer (`FROM <digest>` + one RUN upgrading the package in place) can fix it. */
  overlay: boolean;
  /** What the source patch does (docs / owner request copy). */
  sourcePatchHow: string | null;
  /** What the overlay RUN does, with `pkg` / `<fixed>` placeholders; null when no overlay is possible. */
  overlayHow: string | null;
  /** Shipped in the first patcher wave (deb, apk, npm, python). */
  firstWave: boolean;
}

export const GRYPE_PACKAGE_TYPE_CATALOG: Readonly<Record<GrypePackageType, GrypePackageTypeSpec>> = {
  'deb': {
    label: 'Debian package',
    osPackage: true,
    compiled: false,
    sourcePatch: 'yes',
    overlay: true,
    firstWave: true,
    sourcePatchHow: 'Pin pkg=<fixed> in the Dockerfile\'s apt-get install',
    overlayHow: 'apt-get update && apt-get install --only-upgrade -y pkg=<fixed>',
  },
  'apk': {
    label: 'Alpine package',
    osPackage: true,
    compiled: false,
    sourcePatch: 'yes',
    overlay: true,
    firstWave: true,
    sourcePatchHow: 'Pin pkg=<fixed> in apk add',
    overlayHow: 'apk add --no-cache --upgrade \'pkg=<fixed>\'',
  },
  'rpm': {
    label: 'RPM package',
    osPackage: true,
    compiled: false,
    sourcePatch: 'yes',
    overlay: true,
    firstWave: false,
    sourcePatchHow: 'Pin in dnf / microdnf install',
    overlayHow: 'dnf upgrade -y pkg-<fixed>',
  },
  'npm': {
    label: 'npm package',
    osPackage: false,
    compiled: false,
    sourcePatch: 'yes',
    overlay: true,
    firstWave: true,
    sourcePatchHow: 'overrides entry in package.json, then npm install --package-lock-only',
    overlayHow: 'npm install pkg@<fixed> in the reported directory',
  },
  'python': {
    label: 'Python package',
    osPackage: false,
    compiled: false,
    sourcePatch: 'yes',
    overlay: true,
    firstWave: true,
    sourcePatchHow: 'Pin in requirements*.txt or a constraints file',
    overlayHow: 'pip install --no-deps \'pkg==<fixed>\' into the reported site-packages',
  },
  'go-module': {
    label: 'Go module',
    osPackage: false,
    compiled: true,
    sourcePatch: 'yes',
    overlay: false,
    firstWave: false,
    sourcePatchHow: 'go get mod@<fixed> and go mod tidy (rebuilds the binary)',
    overlayHow: null,
  },
  'java-archive': {
    label: 'Java archive',
    osPackage: false,
    compiled: true,
    sourcePatch: 'yes',
    overlay: false,
    firstWave: false,
    sourcePatchHow: 'dependencyManagement (Maven) or constraints (Gradle) override',
    overlayHow: null,
  },
  'gem': {
    label: 'Ruby gem',
    osPackage: false,
    compiled: false,
    sourcePatch: 'yes',
    overlay: true,
    firstWave: false,
    sourcePatchHow: 'bundle update --conservative pkg',
    overlayHow: 'gem install pkg -v <fixed>',
  },
  'rust-crate': {
    label: 'Rust crate',
    osPackage: false,
    compiled: true,
    sourcePatch: 'yes',
    overlay: false,
    firstWave: false,
    sourcePatchHow: 'cargo update -p pkg --precise <fixed>',
    overlayHow: null,
  },
  'dotnet': {
    label: '.NET package',
    osPackage: false,
    compiled: true,
    sourcePatch: 'yes',
    overlay: false,
    firstWave: false,
    sourcePatchHow: 'Update the PackageReference version',
    overlayHow: null,
  },
  'binary': {
    label: 'Binary',
    osPackage: false,
    compiled: true,
    sourcePatch: 'pinned-arg',
    overlay: false,
    firstWave: false,
    sourcePatchHow: 'Bump the tool\'s pinned version when the Dockerfile pins it with a recognised ARG',
    overlayHow: null,
  },
  'other': {
    label: 'Other',
    osPackage: false,
    compiled: false,
    sourcePatch: 'no',
    overlay: false,
    firstWave: false,
    sourcePatchHow: null,
    overlayHow: null,
  },
};

export function isGrypePackageType(value: unknown): value is GrypePackageType {
  return typeof value === 'string' && (GRYPE_PACKAGE_TYPES as readonly string[]).includes(value);
}

/** grype's raw `artifact.type` as a {@link GrypePackageType} (anything uncatalogued is `other`). */
export function toGrypePackageType(raw: string | null | undefined): GrypePackageType {
  const t = (raw ?? '').trim().toLowerCase();
  return isGrypePackageType(t) ? t : 'other';
}

// =============================================================================
// Stages, outcomes, reasons
// =============================================================================

export const PLUGIN_REMEDIATION_STAGES = [
  'queued', 'rebuild', 'libraries', 'awaiting_approval', 'published', 'rolling_out',
  'done', 'needs_owner', 'needs_review', 'failed',
] as const;
export type PluginRemediationStage = typeof PLUGIN_REMEDIATION_STAGES[number];

/** Building, waiting or rolling out: at most one row per (plugin_id, findings_hash) in these (unique index). */
export const LIVE_REMEDIATION_STAGES = [
  'queued', 'rebuild', 'libraries', 'awaiting_approval', 'published', 'rolling_out', 'needs_review',
] as const satisfies readonly PluginRemediationStage[];
/** Before publish: at most ONE row per plugin version in these (unique index) — a version is never remediated twice at once. */
export const ACTIVE_BUILD_REMEDIATION_STAGES = [
  'queued', 'rebuild', 'libraries', 'awaiting_approval',
] as const satisfies readonly PluginRemediationStage[];
/** Finished: nothing more happens unless someone retries. */
export const TERMINAL_REMEDIATION_STAGES = ['done', 'needs_owner', 'failed'] as const satisfies readonly PluginRemediationStage[];

export const PLUGIN_REMEDIATION_STAGE_LABELS: Readonly<Record<PluginRemediationStage, string>> = {
  queued: 'Queued',
  rebuild: 'Rebuilding',
  libraries: 'Upgrading libraries',
  awaiting_approval: 'Awaiting approval',
  published: 'Published',
  rolling_out: 'Rolling out',
  done: 'Done',
  needs_owner: 'Needs owner',
  needs_review: 'Needs review',
  failed: 'Failed',
};

export function isPluginRemediationStage(value: unknown): value is PluginRemediationStage {
  return typeof value === 'string' && (PLUGIN_REMEDIATION_STAGES as readonly string[]).includes(value);
}

/** Why a remediation ended where it did (the `outcome` column and the metric label). */
export const PLUGIN_REMEDIATION_OUTCOMES = [
  /** Every targeted finding cleared. */
  'cleared',
  /** A fix was published, some findings went to the owner request. */
  'partial',
  /** Nothing could be fixed automatically; the owner request lists every finding. */
  'owner_request',
  /** A propose-mode fix was rejected by a plugins:write approver. */
  'rejected',
  /** Cancelled: the version was deleted, or the name deleted. */
  'cancelled',
  /** The owner uploaded a newer clean version; Stage 3 rolls that one out instead. */
  'superseded',
  /** The job itself failed (checksum mismatch, build infrastructure, internal error). */
  'error',
] as const;
export type PluginRemediationOutcome = typeof PLUGIN_REMEDIATION_OUTCOMES[number];

/** How a finding was cleared. */
export const REMEDIATION_FIX_METHODS = ['rebuild', 'source_patch', 'overlay', 'ask_agent'] as const;
export type RemediationFixMethod = typeof REMEDIATION_FIX_METHODS[number];

/** Why a finding is left for the owner (each `remaining` entry carries one). */
export const REMEDIATION_REMAINING_REASONS = [
  /** grype reports no fixed version. */
  'no_fix',
  /** The fix needs a bigger library jump than the effective upgrade level allows (`requiredLevel` names it). */
  'beyond_upgrade_level',
  /** A Go module's fix is a new major (`/vN` module path): always the owner's change. */
  'go_module_major',
  /** Compiled into a binary and the version has no kept source to rebuild. */
  'compiled_binary',
  /** No kept source and no overlay possible for this package type. */
  'no_source',
  /** No patcher fits the package type or the build layout (and the ask-agent draft did not help). */
  'no_patcher',
  /** The patched build failed the contract check, the smokeTest, or changed user / entrypoint / commands. */
  'patch_broke_plugin',
  /** The patch touched more than the named packages' lines or one overlay layer. */
  'patch_out_of_scope',
  /** The patched image has a Critical/High the original version did not. */
  'new_findings',
  /** The patch applied and built, but the rescan still reports the finding. */
  'still_present',
  /** The rebuild / patched build failed. */
  'build_failed',
  /** A listed third-party plugin: the platform sends the publisher a fix request instead. */
  'third_party_listing',
  /** A waiver or OpenVEX statement already covers it (never targeted). */
  'waived',
  /** The remediation was cancelled before the finding was handled. */
  'cancelled',
] as const;
export type RemediationRemainingReason = typeof REMEDIATION_REMAINING_REASONS[number];

export const REMEDIATION_REMAINING_REASON_LABELS: Readonly<Record<RemediationRemainingReason, string>> = {
  no_fix: 'No fixed version yet',
  beyond_upgrade_level: 'Fix needs a bigger upgrade than allowed',
  go_module_major: 'Fix is a new Go module major version',
  compiled_binary: 'Compiled into a binary',
  no_source: 'No kept source to patch',
  no_patcher: 'Not patchable automatically',
  patch_broke_plugin: 'The patch broke the plugin',
  patch_out_of_scope: 'The patch changed more than the package',
  new_findings: 'The patch introduced new findings',
  still_present: 'Still reported after the patch',
  build_failed: 'The build failed',
  third_party_listing: 'Third-party listing (fix requested from the publisher)',
  waived: 'Covered by a waiver or VEX',
  cancelled: 'Cancelled',
};

/** Why a fix is held for approval even under `mode = apply`. */
export const REMEDIATION_PROPOSE_REASONS = [
  /** The org's pluginRemediation.mode is `propose`. */
  'org_mode',
  /** A library crosses a major version (major upgrades are propose-only). */
  'major_upgrade',
  /** The plugin declares no smokeTest. */
  'no_smoke_test',
  /** The patch was drafted by the ask agent. */
  'ask_agent_patch',
] as const;
export type RemediationProposeReason = typeof REMEDIATION_PROPOSE_REASONS[number];

/** A finding the remediation cleared. */
export interface RemediationClearedFinding {
  id: string;
  purl: string;
  packageName: string;
  packageType: GrypePackageType;
  fromVersion: string;
  /** The library version now installed; null when a rebuild removed the package. */
  toVersion: string | null;
  method: RemediationFixMethod;
}

/** A finding left for the owner, with why. */
export interface RemediationRemainingFinding {
  id: string;
  severity: 'critical' | 'high';
  purl: string;
  packageName: string;
  packageType: GrypePackageType;
  packageVersion: string;
  fixedIn: string[];
  kev?: boolean;
  reason: RemediationRemainingReason;
  /** For `beyond_upgrade_level`: the level the fix would need. */
  requiredLevel?: LibraryUpgradeRequirement;
  /** Short operator-facing detail (a build error CODE, the failing check). Never log text, source or secrets. */
  detail?: string;
}

// =============================================================================
// Upgrade levels
// =============================================================================

export const LIBRARY_UPGRADE_LEVELS = ['patch', 'minor', 'major'] as const;
export type LibraryUpgradeLevel = typeof LIBRARY_UPGRADE_LEVELS[number];
/** What a move needs: a level, or `owner` when no level allows it (a Go /vN module path). */
export type LibraryUpgradeRequirement = LibraryUpgradeLevel | 'owner';
export const DEFAULT_LIBRARY_UPGRADE_LEVEL: LibraryUpgradeLevel = 'minor';

const LEVEL_RANK: Record<LibraryUpgradeLevel, number> = { patch: 0, minor: 1, major: 2 };

export function isLibraryUpgradeLevel(value: unknown): value is LibraryUpgradeLevel {
  return typeof value === 'string' && (LIBRARY_UPGRADE_LEVELS as readonly string[]).includes(value);
}

/** The strictest of the given levels (absent ones ignored); `fallback` when none is given. */
export function strictestUpgradeLevel(
  levels: ReadonlyArray<LibraryUpgradeLevel | null | undefined>,
  fallback: LibraryUpgradeLevel = DEFAULT_LIBRARY_UPGRADE_LEVEL,
): LibraryUpgradeLevel {
  const given = levels.filter(isLibraryUpgradeLevel);
  if (given.length === 0) return fallback;
  return given.reduce((a, b) => (LEVEL_RANK[b] < LEVEL_RANK[a] ? b : a));
}

/**
 * The level that applies to one library of one plugin: the strictest of the
 * org level, the org's per-package-type level and the plugin's own level.
 */
export function effectiveLibraryUpgradeLevel(
  settings: Pick<PluginRemediationSettings, 'libraryUpgradeLevel' | 'libraryUpgradeLevelByType' | 'libraryUpgradeLevelByPlugin'>,
  packageType: GrypePackageType,
  pluginName: string,
): LibraryUpgradeLevel {
  return strictestUpgradeLevel([
    settings.libraryUpgradeLevel,
    settings.libraryUpgradeLevelByType[packageType],
    settings.libraryUpgradeLevelByPlugin[pluginName],
  ], settings.libraryUpgradeLevel);
}

// -- package version parsing / ordering ---------------------------------------

const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9';

/** dpkg's character order: `~` before everything (even the end), letters before other punctuation. */
function charOrder(c: string | undefined): number {
  if (c === undefined || c === '' || isDigit(c)) return 0;
  if (c === '~') return -1;
  if (/[A-Za-z]/.test(c)) return c.charCodeAt(0);
  return c.charCodeAt(0) + 256;
}

/** dpkg `verrevcmp`: alternating non-digit / digit runs. */
function verrevcmp(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    while ((i < a.length && !isDigit(a[i])) || (j < b.length && !isDigit(b[j]))) {
      const ac = charOrder(a[i]);
      const bc = charOrder(b[j]);
      if (ac !== bc) return ac - bc;
      i++; j++;
    }
    while (a[i] === '0') i++;
    while (b[j] === '0') j++;
    let firstDiff = 0;
    while (isDigit(a[i]) && isDigit(b[j])) {
      if (!firstDiff) firstDiff = a.charCodeAt(i) - b.charCodeAt(j);
      i++; j++;
    }
    if (isDigit(a[i])) return 1;
    if (isDigit(b[j])) return -1;
    if (firstDiff) return firstDiff;
  }
  return 0;
}

interface OsVersion { epoch: number; upstream: string; revision: string }

/** `[epoch:]upstream[-revision]` (deb / rpm `-release`; apk `-rN`). */
function parseOsVersion(v: string, type: GrypePackageType): OsVersion {
  let rest = v.trim();
  let epoch = 0;
  const e = /^(\d+):(.*)$/.exec(rest);
  if (e) { epoch = Number(e[1]); rest = e[2]!; }
  if (type === 'apk') {
    const r = /^(.*)-(r\d+)$/.exec(rest);
    return r ? { epoch, upstream: r[1]!, revision: r[2]! } : { epoch, upstream: rest, revision: '' };
  }
  const dash = rest.lastIndexOf('-');
  return dash > 0 ? { epoch, upstream: rest.slice(0, dash), revision: rest.slice(dash + 1) } : { epoch, upstream: rest, revision: '' };
}

/** Drop a leading `v` / `go` before a digit (`v1.2.3`, `go1.26.4`). */
const stripPrefix = (v: string): string => v.trim().replace(/^(?:v|go)(?=\d)/i, '');

/**
 * Order two versions of the same package: negative when `a` is lower.
 * OS packages compare epoch, then upstream, then revision (dpkg order); others
 * use SemVer precedence when both parse, else the dpkg order of the strings.
 */
export function comparePackageVersions(a: string, b: string, packageType: GrypePackageType): number {
  if (GRYPE_PACKAGE_TYPE_CATALOG[packageType].osPackage) {
    const x = parseOsVersion(a, packageType);
    const y = parseOsVersion(b, packageType);
    if (x.epoch !== y.epoch) return x.epoch - y.epoch;
    return verrevcmp(x.upstream, y.upstream) || verrevcmp(x.revision, y.revision);
  }
  const sa = stripPrefix(a);
  const sb = stripPrefix(b);
  const pa = parseSemver(sa);
  const pb = parseSemver(sb);
  if (pa && pb) {
    for (const k of ['major', 'minor', 'patch'] as const) if (pa[k] !== pb[k]) return pa[k] - pb[k];
    if (pa.prerelease.length === 0 || pb.prerelease.length === 0) return pb.prerelease.length - pa.prerelease.length;
    return verrevcmp(pa.prerelease.join('.'), pb.prerelease.join('.'));
  }
  return verrevcmp(sa, sb);
}

/** The first three numeric parts (missing = 0), or null when the version does not start with a number. */
function numericParts(v: string): [number, number, number] | null {
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(stripPrefix(v));
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

/**
 * The upgrade level moving a library from `installed` to `candidate` needs:
 *
 *  - OS packages (deb, apk, rpm): the level applies to the UPSTREAM version; a
 *    distro revision of the same upstream (`1.1.1n-0+deb11u5` → `…u6`) is a
 *    patch, and an epoch change is a major.
 *  - 0.x: a minor bump counts as major (semver: 0.x minors may break).
 *  - Go modules: a new major of v2 or above is a different module path (`/vN`),
 *    so it is always the owner's change (`owner`), whatever the level.
 *  - Non-semver versions (dates, four-part numbers): the first three numeric
 *    parts; a version that can't be parsed counts as a major upgrade.
 *  - A candidate that is not above `installed` moves nothing: `patch`.
 */
export function libraryUpgradeRequirement(installed: string, candidate: string, packageType: GrypePackageType): LibraryUpgradeRequirement {
  if (comparePackageVersions(candidate, installed, packageType) <= 0) return 'patch';
  let from = installed;
  let to = candidate;
  if (GRYPE_PACKAGE_TYPE_CATALOG[packageType].osPackage) {
    const x = parseOsVersion(installed, packageType);
    const y = parseOsVersion(candidate, packageType);
    if (x.epoch !== y.epoch) return 'major';
    if (verrevcmp(x.upstream, y.upstream) === 0) return 'patch';
    from = x.upstream;
    to = y.upstream;
  }
  const a = numericParts(from);
  const b = numericParts(to);
  if (!a || !b) return 'major';
  if (a[0] !== b[0]) return packageType === 'go-module' && b[0] >= 2 ? 'owner' : 'major';
  if (a[1] !== b[1]) return a[0] === 0 ? 'major' : 'minor';
  return 'patch';
}

/** Whether `level` allows moving a library from `installed` to `candidate`. */
export function libraryUpgradeAllowed(installed: string, candidate: string, level: LibraryUpgradeLevel, packageType: GrypePackageType): boolean {
  const need = libraryUpgradeRequirement(installed, candidate, packageType);
  return need !== 'owner' && LEVEL_RANK[need] <= LEVEL_RANK[level];
}

// -- choosing the fix version ---------------------------------------------------

/** One package (purl) and the single version that clears all of its fixable findings. */
export interface PackageFixChoice {
  purl: string;
  packageName: string;
  packageType: GrypePackageType;
  installedVersion: string;
  /** The highest of the lowest fixed versions across its CVEs; null when none of them has a fix. */
  fixVersion: string | null;
  /** Findings `fixVersion` clears (sorted). */
  findingIds: string[];
  /** Findings with no fixed version (sorted). */
  noFixIds: string[];
  kev: boolean;
  locations: PluginScanFindingLocation[];
}

const groupKey = (f: Pick<PluginScanFinding, 'purl' | 'packageType' | 'packageName' | 'packageVersion'>): string =>
  f.purl || `${f.packageType}:${f.packageName}@${f.packageVersion}`;

/**
 * Group findings by package (purl) and pick, per package, the highest of the
 * lowest fixed versions across its CVEs — one upgrade that clears all of them.
 * Waived / VEX-covered findings must be filtered out by the caller. Sorted by purl.
 */
export function chooseFixVersion(findings: readonly PluginScanFinding[]): PackageFixChoice[] {
  const groups = new Map<string, PluginScanFinding[]>();
  for (const f of findings) {
    const k = groupKey(f);
    const list = groups.get(k);
    if (list) list.push(f); else groups.set(k, [f]);
  }
  const out: PackageFixChoice[] = [];
  for (const [purl, list] of groups) {
    const first = list[0]!;
    const type = first.packageType;
    const cmp = (x: string, y: string) => comparePackageVersions(x, y, type);
    let fixVersion: string | null = null;
    const findingIds: string[] = [];
    const noFixIds: string[] = [];
    for (const f of list) {
      const fixes = f.fixedIn.filter((v) => typeof v === 'string' && v.trim() !== '');
      if (fixes.length === 0) { noFixIds.push(f.id); continue; }
      findingIds.push(f.id);
      const lowest = fixes.reduce((a, b) => (cmp(b, a) < 0 ? b : a));
      if (fixVersion === null || cmp(lowest, fixVersion) > 0) fixVersion = lowest;
    }
    const seen = new Set<string>();
    const locations: PluginScanFindingLocation[] = [];
    for (const f of list) {
      for (const l of f.locations ?? []) {
        const key = `${l.path}\u0000${l.layerID}`;
        if (!seen.has(key)) { seen.add(key); locations.push({ path: l.path, layerID: l.layerID }); }
      }
    }
    out.push({
      purl,
      packageName: first.packageName,
      packageType: type,
      installedVersion: first.packageVersion,
      fixVersion,
      findingIds: [...new Set(findingIds)].sort(),
      noFixIds: [...new Set(noFixIds)].sort(),
      kev: list.some((f) => f.kev === true),
      locations,
    });
  }
  return out.sort((a, b) => (a.purl < b.purl ? -1 : a.purl > b.purl ? 1 : 0));
}

/**
 * The canonical text of a targeted findings set, for `findings_hash`
 * (sha256 of this, see `remediationFindingsHash` in the root barrel). It
 * includes each finding's fixed versions, so a vulnerability-DB update that
 * adds a fix changes the hash and lets a failed set be retried.
 */
export function remediationFindingsKey(findings: ReadonlyArray<Pick<PluginScanFinding, 'id' | 'purl' | 'packageVersion' | 'fixedIn'>>): string {
  const lines = new Set(findings.map((f) => `${f.id}|${f.purl}|${f.packageVersion}|${[...f.fixedIn].sort().join(',')}`));
  return [...lines].sort().join('\n');
}

// -- plugin version numbering ---------------------------------------------------

/** How the plugin version moves: patch and minor library upgrades → next patch; a major library upgrade → next minor. */
export type RemediationVersionBump = 'patch' | 'minor';

export function remediationVersionBump(choices: ReadonlyArray<{ requirement: LibraryUpgradeRequirement }>): RemediationVersionBump {
  return choices.some((c) => c.requirement === 'major') ? 'minor' : 'patch';
}

/**
 * The next FREE version after `fromVersion` (its prerelease/build ignored):
 * `patch` → the smallest `M.m.(p+k)` not taken (1.4.3, or 1.4.4 when 1.4.3 is
 * taken); `minor` → the smallest `M.(m+k).0` not taken. Never crosses the
 * major. `taken` should include soft-deleted versions (the name/version is
 * still reserved by their rows). Null when `fromVersion` is not semver.
 */
export function nextRemediationVersion(fromVersion: string, taken: Iterable<string>, bump: RemediationVersionBump): string | null {
  const p = parseSemver(stripPrefix(fromVersion));
  if (!p) return null;
  const used = new Set([...taken].map((v) => v.trim()));
  for (let k = 1; k < 10_000; k++) {
    const v = bump === 'patch' ? `${p.major}.${p.minor}.${p.patch + k}` : `${p.major}.${p.minor + k}.0`;
    if (!used.has(v)) return v;
  }
  return null;
}

// =============================================================================
// Modes and settings
// =============================================================================

/** pluginRemediation.mode — building and publishing fixes. */
export const PLUGIN_REMEDIATION_MODES = ['off', 'propose', 'apply'] as const;
export type PluginRemediationMode = typeof PLUGIN_REMEDIATION_MODES[number];

/** pluginRemediation.rollout on a ROOT org. */
export const PLUGIN_REMEDIATION_ROLLOUTS = ['off', 'propose', 'apply'] as const;
export type PluginRemediationRollout = typeof PLUGIN_REMEDIATION_ROLLOUTS[number];

/** pluginRemediation.rollout on a TEAM (sub-organization); `inherit` = the root org's. */
export const TEAM_REMEDIATION_ROLLOUTS = ['inherit', 'off', 'propose', 'apply'] as const;
export type TeamRemediationRollout = typeof TEAM_REMEDIATION_ROLLOUTS[number];

/** pipelines.remediation_upgrades — a pipeline's election. */
export const PIPELINE_REMEDIATION_ELECTIONS = ['inherit', 'off', 'propose', 'apply'] as const;
export type PipelineRemediationElection = typeof PIPELINE_REMEDIATION_ELECTIONS[number];

export const DEFAULT_PLUGIN_REMEDIATION_MODE: PluginRemediationMode = 'propose';
export const DEFAULT_ROOT_REMEDIATION_ROLLOUT: PluginRemediationRollout = 'propose';
export const DEFAULT_TEAM_REMEDIATION_ROLLOUT: TeamRemediationRollout = 'inherit';
export const DEFAULT_PIPELINE_REMEDIATION_ELECTION: PipelineRemediationElection = 'inherit';

const isOneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);
export const isPluginRemediationMode = (v: unknown): v is PluginRemediationMode => isOneOf(PLUGIN_REMEDIATION_MODES, v);
export const isTeamRemediationRollout = (v: unknown): v is TeamRemediationRollout => isOneOf(TEAM_REMEDIATION_ROLLOUTS, v);
export const isPipelineRemediationElection = (v: unknown): v is PipelineRemediationElection => isOneOf(PIPELINE_REMEDIATION_ELECTIONS, v);

/**
 * An org's pluginRemediation settings, as every service reads them
 * (`plugin_remediation_settings`, one row per org; absent = the defaults).
 */
export interface PluginRemediationSettings {
  mode: PluginRemediationMode;
  libraryUpgradeLevel: LibraryUpgradeLevel;
  /** Per package type; the strictest of this, the org level and the plugin's own level applies. */
  libraryUpgradeLevelByType: Partial<Record<GrypePackageType, LibraryUpgradeLevel>>;
  /** Per plugin NAME (set from the plugin's settings with plugins:write); absent = "Follow organization". */
  libraryUpgradeLevelByPlugin: Record<string, LibraryUpgradeLevel>;
  /** Root org: off | propose | apply (never inherit). Team: inherit (default) | off | propose | apply. */
  rollout: TeamRemediationRollout;
  /** Root org only: whether a pipeline may elect `apply` when its org default is propose or off. */
  allowPipelineApply: boolean;
}

export const DEFAULT_PLUGIN_REMEDIATION_SETTINGS: Readonly<PluginRemediationSettings> = {
  mode: DEFAULT_PLUGIN_REMEDIATION_MODE,
  libraryUpgradeLevel: DEFAULT_LIBRARY_UPGRADE_LEVEL,
  libraryUpgradeLevelByType: {},
  libraryUpgradeLevelByPlugin: {},
  rollout: DEFAULT_ROOT_REMEDIATION_ROLLOUT,
  allowPipelineApply: true,
};

/** The stored row's fields (drizzle camelCase); every field optional, `rollout` NULL = the default for the org kind. */
export interface PluginRemediationSettingsRowLike {
  mode?: unknown;
  libraryUpgradeLevel?: unknown;
  libraryUpgradeLevelByType?: unknown;
  libraryUpgradeLevelByPlugin?: unknown;
  rollout?: unknown;
  allowPipelineApply?: unknown;
}

function levelMap<K extends string>(raw: unknown, keyOk: (k: string) => k is K): Partial<Record<K, LibraryUpgradeLevel>> {
  const out: Partial<Record<K, LibraryUpgradeLevel>> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (keyOk(k) && isLibraryUpgradeLevel(v)) out[k] = v;
  return out;
}

/**
 * The effective settings of one org from its row (null = no row). Tolerant: an
 * unknown stored value falls back to its default. A root org's `inherit` (or
 * NULL) rollout reads as `propose`; a team's NULL reads as `inherit`.
 */
export function normalizePluginRemediationSettings(row: PluginRemediationSettingsRowLike | null | undefined, opts: { isTeam: boolean }): PluginRemediationSettings {
  const r = row ?? {};
  let rollout: TeamRemediationRollout = isTeamRemediationRollout(r.rollout) ? r.rollout : (opts.isTeam ? DEFAULT_TEAM_REMEDIATION_ROLLOUT : DEFAULT_ROOT_REMEDIATION_ROLLOUT);
  if (!opts.isTeam && rollout === 'inherit') rollout = DEFAULT_ROOT_REMEDIATION_ROLLOUT;
  return {
    mode: isPluginRemediationMode(r.mode) ? r.mode : DEFAULT_PLUGIN_REMEDIATION_MODE,
    libraryUpgradeLevel: isLibraryUpgradeLevel(r.libraryUpgradeLevel) ? r.libraryUpgradeLevel : DEFAULT_LIBRARY_UPGRADE_LEVEL,
    libraryUpgradeLevelByType: levelMap(r.libraryUpgradeLevelByType, (k): k is GrypePackageType => isGrypePackageType(k)),
    libraryUpgradeLevelByPlugin: levelMap(r.libraryUpgradeLevelByPlugin, (k): k is string => k.length > 0 && k.length <= 255) as Record<string, LibraryUpgradeLevel>,
    rollout,
    allowPipelineApply: typeof r.allowPipelineApply === 'boolean' ? r.allowPipelineApply : true,
  };
}

/**
 * Whether a fix is published automatically (`apply`) or held for a
 * plugins:write approval with step-up (`propose`), and why it is held.
 * `off` builds nothing.
 */
export function remediationPublishMode(
  orgMode: PluginRemediationMode,
  facts: { majorUpgrade: boolean; hasSmokeTest: boolean; askAgentPatch: boolean },
): { mode: PluginRemediationMode; proposeReasons: RemediationProposeReason[] } {
  if (orgMode === 'off') return { mode: 'off', proposeReasons: [] };
  const reasons: RemediationProposeReason[] = [];
  if (orgMode === 'propose') reasons.push('org_mode');
  if (facts.majorUpgrade) reasons.push('major_upgrade');
  if (!facts.hasSmokeTest) reasons.push('no_smoke_test');
  if (facts.askAgentPatch) reasons.push('ask_agent_patch');
  return { mode: reasons.length === 0 ? 'apply' : 'propose', proposeReasons: reasons };
}

/** Where a pipeline's effective rollout mode came from. */
export type RemediationRolloutSource = 'pipeline' | 'team' | 'root';

export interface ResolvedRemediationRollout {
  mode: PluginRemediationRollout;
  source: RemediationRolloutSource;
  /** The org default the pipeline inherits (team's own, else the root's). */
  orgDefault: PluginRemediationRollout;
  /** The pipeline elected `apply` but its root org disallows it under this default: resolved to `propose`. */
  applyRefused: boolean;
}

/**
 * A pipeline's effective Stage 3 mode. The most specific setting wins:
 * pipeline, then its own org when that is a team, then the root org. `off` on
 * the pipeline always wins (opting out is always allowed). A pipeline `apply`
 * is honoured only when the org default is `apply` or the root allows pipeline
 * apply; otherwise it resolves to `propose` (`applyRefused`). Re-run before
 * every wave AND just before moving each pipeline.
 */
export function resolveRemediationRollout(input: {
  pipeline: PipelineRemediationElection;
  /** The pipeline's org setting when that org is a TEAM; null/undefined for a root org's pipeline. */
  team?: TeamRemediationRollout | null;
  root: PluginRemediationRollout;
  allowPipelineApply: boolean;
}): ResolvedRemediationRollout {
  const teamOwn = input.team && input.team !== 'inherit' ? input.team : null;
  const orgDefault: PluginRemediationRollout = teamOwn ?? input.root;
  const orgSource: RemediationRolloutSource = teamOwn ? 'team' : 'root';
  switch (input.pipeline) {
    case 'off':
    case 'propose':
      return { mode: input.pipeline, source: 'pipeline', orgDefault, applyRefused: false };
    case 'apply':
      return pipelineElectionAllowed('apply', orgDefault, input.allowPipelineApply)
        ? { mode: 'apply', source: 'pipeline', orgDefault, applyRefused: false }
        : { mode: 'propose', source: 'pipeline', orgDefault, applyRefused: true };
    default:
      return { mode: orgDefault, source: orgSource, orgDefault, applyRefused: false };
  }
}

/** Whether a pipeline may store `election` (the pipeline update route's check; 403 PIPELINE_REMEDIATION_APPLY_NOT_ALLOWED otherwise). */
export function pipelineElectionAllowed(election: PipelineRemediationElection, orgDefault: PluginRemediationRollout, allowPipelineApply: boolean): boolean {
  return election !== 'apply' || orgDefault === 'apply' || allowPipelineApply;
}

// =============================================================================
// Rollout (Stage 3)
// =============================================================================

export const REMEDIATION_ROLLOUT_STATUSES = ['pending', 'canary', 'batches', 'done', 'paused', 'cancelled'] as const;
export type RemediationRolloutStatus = typeof REMEDIATION_ROLLOUT_STATUSES[number];

export const REMEDIATION_ROLLOUT_PAUSE_REASONS = ['canary_failed', 'rollbacks', 'rollback_target_deleted'] as const;
export type RemediationRolloutPauseReason = typeof REMEDIATION_ROLLOUT_PAUSE_REASONS[number];

/** Per-pipeline state of a rollout (`pipeline_remediation_upgrades.state`). */
export const PIPELINE_REMEDIATION_UPGRADE_STATES = [
  /** propose: an upgrade proposal is open on the pipeline page. */
  'proposed',
  /** Approval-gated install (plugin_installs:manage): a change request instead of a move. */
  'change_requested',
  /** apply: waiting for its wave. */
  'queued',
  /** Moved to the fix version (and redeployed). */
  'moved',
  /** The move failed (validation, compliance, concurrent edit). */
  'failed',
  /** Moved back after a failed run on a step using the new version. */
  'rolled_back',
  /** A rollback was needed but the previous version is no longer live (or is KEV-flagged without an acceptance): paused, owners told. */
  'rollback_blocked',
  /** The pipeline elected off. */
  'skipped_opt_out',
  /** The org's runner was unhealthy; retried in a later wave. */
  'skipped_runner',
  /** The owner dismissed the proposal. */
  'dismissed',
  /** A newer fix (or the owner's own version) replaced this one. */
  'superseded',
] as const;
export type PipelineRemediationUpgradeState = typeof PIPELINE_REMEDIATION_UPGRADE_STATES[number];

export interface RemediationRolloutWave {
  index: number;
  kind: 'canary' | 'batch';
  pipelineIds: string[];
  startedAt: string;
  finishedAt: string | null;
  outcome: 'running' | 'succeeded' | 'failed';
}

/** `plugin_remediations.rollout`, written by the plugin service from the pipeline service's reports. */
export interface RemediationRolloutSummary {
  status: RemediationRolloutStatus;
  toVersion: string;
  waves: RemediationRolloutWave[];
  counts: {
    eligible: number;
    proposed: number;
    changeRequested: number;
    moved: number;
    failed: number;
    rolledBack: number;
    skippedOptOut: number;
    skippedRunner: number;
  };
  pausedReason?: RemediationRolloutPauseReason;
  updatedAt: string;
}

/** Up to this many pipelines in the canary wave, preferring ones that ran successfully in the last {@link REMEDIATION_CANARY_RECENT_DAYS} days. */
export const REMEDIATION_CANARY_SIZE = 5;
export const REMEDIATION_CANARY_RECENT_DAYS = 7;
/** Batch size after the canary (the apply route's limit). */
export const REMEDIATION_BATCH_SIZE = 50;
/** A failed run on a step using the new version within this window rolls the pipeline back. */
export const REMEDIATION_ROLLBACK_WINDOW_MS = 24 * 3_600_000;
/** Rollbacks in one rollout that pause it and mark the remediation needs_review. */
export const REMEDIATION_MAX_ROLLBACKS = 2;

// =============================================================================
// Queue job, priority, env, metrics, storage, limits
// =============================================================================

/** The BullMQ job name, on the org's plugin build tier queue. */
export const PLUGIN_REMEDIATION_JOB_NAME = 'plugin-remediation';

/** The job payload. Everything else is read from the `plugin_remediations` row. */
export interface PluginRemediationJobData {
  kind: 'plugin-remediation';
  remediationId: string;
  orgId: string;
  pluginId: string;
  pluginName: string;
  fromVersion: string;
}

/** Job id = idempotency key: one job per remediation row. */
export function pluginRemediationJobId(remediationId: string): string {
  return `remediation-${remediationId}`;
}

export interface RemediationPriorityInput {
  kev: boolean;
  /** Highest EPSS (0–1) among the targeted findings; 0 when unknown. */
  maxEpss: number;
  /** Pipelines using the version. */
  pipelineCount: number;
}

/** KEV first, then EPSS, then the number of pipelines using the version. Negative when `a` runs first. */
export function compareRemediationPriority(a: RemediationPriorityInput, b: RemediationPriorityInput): number {
  if (a.kev !== b.kev) return a.kev ? -1 : 1;
  if (a.maxEpss !== b.maxEpss) return b.maxEpss - a.maxEpss;
  return b.pipelineCount - a.pipelineCount;
}

/**
 * The BullMQ `priority` of a remediation job (lower runs first; always >= 1,
 * so un-prioritised user builds run before every remediation).
 */
export function remediationQueuePriority(p: RemediationPriorityInput): number {
  const epss = Math.min(1, Math.max(0, Number.isFinite(p.maxEpss) ? p.maxEpss : 0));
  const pipelines = Math.min(999, Math.max(0, Math.floor(p.pipelineCount)));
  return 1 + (p.kev ? 0 : 1_000_000) + Math.round((1 - epss) * 1000) * 1000 + (999 - pipelines);
}

/** The severities remediation may target (PLUGIN_REMEDIATION_SEVERITIES). */
export const REMEDIATION_SEVERITIES = ['critical', 'high'] as const;
export type RemediationSeverity = typeof REMEDIATION_SEVERITIES[number];
export const DEFAULT_REMEDIATION_SEVERITIES: readonly RemediationSeverity[] = ['critical', 'high'];

/**
 * PLUGIN_REMEDIATION_SEVERITIES: a comma list of `critical` / `high`
 * (case-insensitive, whitespace and duplicates ignored), in catalog order.
 * Unset or blank → the default (both). Any unknown entry, or a list with no
 * valid entry, → the default plus ONE `warn` call naming the value.
 */
export function parseRemediationSeverities(
  raw: string | undefined | null,
  warn: (message: string) => void = (m) => console.warn(m),
): RemediationSeverity[] {
  if (raw === undefined || raw === null || raw.trim() === '') return [...DEFAULT_REMEDIATION_SEVERITIES];
  const parts = raw.split(',').map((p) => p.trim().toLowerCase()).filter((p) => p !== '');
  const valid = parts.every((p) => (REMEDIATION_SEVERITIES as readonly string[]).includes(p));
  if (!valid || parts.length === 0) {
    warn(`PLUGIN_REMEDIATION_SEVERITIES=${JSON.stringify(raw)} is not a comma list of critical, high; using critical,high`);
    return [...DEFAULT_REMEDIATION_SEVERITIES];
  }
  return REMEDIATION_SEVERITIES.filter((s) => parts.includes(s));
}

/** PLUGIN_REMEDIATION_ENABLED: on unless the value is exactly `false` (trimmed, case-insensitive). */
export function parseRemediationEnabled(raw: string | undefined | null): boolean {
  return (raw ?? '').trim().toLowerCase() !== 'false';
}

/**
 * Whether remediation targets a finding: it has a fixed version and its
 * severity is in `severities` — or it is KEV-listed, which is always targeted
 * (a KEV finding with no fix still goes to the owner request with `no_fix`).
 */
export function isRemediationTarget(
  f: Pick<PluginScanFinding, 'severity' | 'fixedIn' | 'kev'>,
  severities: readonly RemediationSeverity[],
): boolean {
  if (f.kev === true) return true;
  return f.fixedIn.length > 0 && severities.includes(f.severity);
}

/**
 * The plugin service's config object (api/plugin/src/config.ts) carries these
 * as `remediation.enabled` and `remediation.severities`.
 */
export interface PluginRemediationConfig {
  enabled: boolean;
  severities: RemediationSeverity[];
}

/** Env names and defaults (read with literal `envInt` / `envBool` / `envStr` calls in the services). */
export const PLUGIN_REMEDIATION_ENV = {
  /** Only the literal `false` disables: no jobs queued or run, nothing published or rolled out. */
  enabled: { name: 'PLUGIN_REMEDIATION_ENABLED', default: true },
  /** Comma list of critical, high; KEV-listed findings are always targeted. */
  severities: { name: 'PLUGIN_REMEDIATION_SEVERITIES', default: 'critical,high' },
  concurrency: { name: 'PLUGIN_REMEDIATION_CONCURRENCY', default: 2 },
  baseConcurrency: { name: 'PLUGIN_REMEDIATION_BASE_CONCURRENCY', default: 4 },
  maxPerOrgPerDay: { name: 'PLUGIN_REMEDIATION_MAX_PER_ORG_PER_DAY', default: 20 },
  sourcesBucket: { name: 'PLUGIN_SOURCES_BUCKET', default: 'plugin-sources' },
} as const;

/** Metric names (labels: stage ∈ stages, outcome ∈ outcomes, type ∈ package types). */
export const PLUGIN_REMEDIATION_METRICS = {
  /** {stage, outcome} — one per remediation reaching a stage end. */
  remediations: 'plugin_remediations_total',
  /** {type} — findings cleared, by package type. */
  findingsCleared: 'plugin_remediation_findings_cleared_total',
  /** {kind} (object | prefix | image) — a purge delete that failed and landed in plugin_source_orphans. */
  sourceDeleteFailures: 'plugin_source_delete_failures_total',
} as const;

/**
 * RustFS keys in the `plugin-sources` bucket ({@link PLUGIN_REMEDIATION_ENV}.sourcesBucket):
 *   <orgId>/<pluginId>/<version>/<sha256>.zip                                    a version's kept build context
 *   <orgId>/<pluginId>/<version>/remediations/<remediationId>/patched-<sha256>.zip   a remediation's patched context (copied to the fix version's own source key on publish)
 *   <orgId>/<pluginId>/<version>/remediations/<remediationId>/remediation.diff       the patch diff (plugin_remediations.patch_key)
 *   <orgId>/<pluginId>/<version>/remediations/<remediationId>/export.diff            Official only: the patch re-rooted at deploy/plugins/<name>/ for maintainers
 *   listings/<listingId>/<version>/<sha256>.zip                                  a listed version's own copy (outlives the publisher org's row)
 * Purging a version deletes its `<orgId>/<pluginId>/<version>/` prefix; the org purge deletes `<orgId>/`.
 */
export function pluginSourceVersionPrefix(orgId: string, pluginId: string, version: string): string {
  return `${orgId.toLowerCase()}/${pluginId.toLowerCase()}/${version}/`;
}
export function pluginSourceKey(orgId: string, pluginId: string, version: string, sha256: string): string {
  return `${pluginSourceVersionPrefix(orgId, pluginId, version)}${sha256.toLowerCase()}.zip`;
}
export function pluginSourceOrgPrefix(orgId: string): string {
  return `${orgId.toLowerCase()}/`;
}
export function remediationArtifactPrefix(orgId: string, pluginId: string, version: string, remediationId: string): string {
  return `${pluginSourceVersionPrefix(orgId, pluginId, version)}remediations/${remediationId.toLowerCase()}/`;
}
export function remediationPatchedSourceKey(orgId: string, pluginId: string, version: string, remediationId: string, sha256: string): string {
  return `${remediationArtifactPrefix(orgId, pluginId, version, remediationId)}patched-${sha256.toLowerCase()}.zip`;
}
export function remediationDiffKey(orgId: string, pluginId: string, version: string, remediationId: string): string {
  return `${remediationArtifactPrefix(orgId, pluginId, version, remediationId)}remediation.diff`;
}
export function remediationExportKey(orgId: string, pluginId: string, version: string, remediationId: string): string {
  return `${remediationArtifactPrefix(orgId, pluginId, version, remediationId)}export.diff`;
}
export function listingSourceKey(listingId: string, version: string, sha256: string): string {
  return `listings/${listingId.toLowerCase()}/${version}/${sha256.toLowerCase()}.zip`;
}

/** `plugins.source_kind` / `plugin_listing_versions.source_kind`. */
export const PLUGIN_SOURCE_KINDS = ['zip', 'none'] as const;
export type PluginSourceKind = typeof PLUGIN_SOURCE_KINDS[number];

/** `plugin_source_orphans.kind`. */
export const PLUGIN_SOURCE_ORPHAN_KINDS = ['object', 'prefix', 'image'] as const;
export type PluginSourceOrphanKind = typeof PLUGIN_SOURCE_ORPHAN_KINDS[number];

/** By-name delete, restore and purge share one bucket: 10 per org per hour. */
export const PLUGIN_BY_NAME_RATE_LIMIT = { name: 'plugin-by-name-destructive', max: 10, windowMs: 3_600_000 } as const;
/** How long a by-name delete waits for running builds / remediations of the name before cancelling them. */
export const PLUGIN_DELETE_INFLIGHT_WAIT_MS = 600_000;

// =============================================================================
// Wire shapes (plugin routes ⇄ frontend)
// =============================================================================

/** One remediation as `GET /plugins/remediations[/:id]` answers it. */
export interface PluginRemediationDto {
  id: string;
  pluginId: string;
  pluginName: string;
  fromVersion: string;
  stage: PluginRemediationStage;
  outcome: PluginRemediationOutcome | null;
  toVersion: string | null;
  toPluginId: string | null;
  versionBump: RemediationVersionBump | null;
  upgradeLevel: LibraryUpgradeLevel | null;
  publishMode: 'propose' | 'apply' | null;
  proposeReasons: RemediationProposeReason[];
  fixMethods: RemediationFixMethod[];
  targetedCount: number;
  cleared: RemediationClearedFinding[];
  remaining: RemediationRemainingFinding[];
  /** A patch diff is stored (fetch it from GET /plugins/remediations/:id/patch). */
  hasPatch: boolean;
  /** Official only: an export for deploy/plugins/** is stored (GET /plugins/remediations/:id/export, system org). */
  hasExport: boolean;
  rollout: RemediationRolloutSummary | null;
  /** Pipelines this remediation's rollout moved back (at most 1000; kept beside the rollout summary). */
  rolledBackPipelineIds: string[];
  /** A short error CODE (never raw log text). */
  error: string | null;
  attempt: number;
  retryOf: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  finishedAt: string | null;
}

export const PLUGIN_DELETE_SKIP_REASONS = ['in_use', 'frozen', 'listed'] as const;
export type PluginDeleteSkipReason = typeof PLUGIN_DELETE_SKIP_REASONS[number];

export interface PluginDeleteSkip {
  id: string;
  version: string;
  reason: PluginDeleteSkipReason;
  /** For in_use: the pipelines using it (at most 50). */
  pipelines?: Array<{ id: string; name: string | null }>;
}

/** `GET /plugins/by-name/:name/delete-preview` (and what DELETE would do). */
export interface PluginDeletePreview {
  name: string;
  /** The name comes from the root org (a team sees it but has nothing to delete). */
  inheritedFromRoot: boolean;
  /** The name is listed; the dialog offers an "unmaintained" / yank request. */
  listing: { id: string; publisher: string } | null;
  deletable: Array<{ id: string; version: string; sourceBytes: number | null }>;
  skipped: PluginDeleteSkip[];
  /** Queued / running builds and remediations of the name the delete would cancel. */
  inFlight: { builds: number; remediations: number };
}

/** `DELETE /plugins/by-name/:name`. */
export interface PluginDeleteAllResult {
  batchId: string;
  deleted: Array<{ id: string; version: string }>;
  skipped: PluginDeleteSkip[];
}

/** `POST /plugins/by-name/:name/restore` and `/purge` (`?batchId=` required). */
export interface PluginBatchActionResult {
  batchId: string;
  done: Array<{ id: string; version: string }>;
  skipped: Array<{ id: string; version: string; reason: string }>;
}
