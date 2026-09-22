// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Resolving a plugin reference to an ecosystem LISTING version through the
 * org's install (docs/plugin-installing.md).
 *
 * One implementation shared by every place that answers "which listed version
 * does this org's reference run?": the plugin service's `/plugins/lookup` (what
 * synth pins), the pipeline service's contract check at pipeline create, the AI
 * generator's plugin list and the placeholder guard. The decisions are PURE
 * functions over loaded rows; the rows come through a {@link ListingDataSource}
 * so each service can load them its own way ({@link drizzleListingSource} is the
 * plain drizzle one).
 *
 * The model:
 *  - An org resolves a listing only through an INSTALL: an explicit
 *    `plugin_installs` row (its own, or — for a team — its root org's), or
 *    for the Official publisher the IMPLICIT install every org has unless its
 *    consumption policy says `officialInstalls: explicit`. An explicit
 *    install overrides the implicit one.
 *  - The org's CONSUMPTION POLICY is applied at every resolution: allowed
 *    tiers, blocked listings, advisory blocking; secrets are withheld from tiers
 *    the policy doesn't trust with them. A team's policy is merged with its root
 *    org's and can only be stricter.
 *  - Version choice: the install's range (pinned / `~` / `^` / non-breaking
 *    latest; implicit = the lowest live major), narrowed by the reference's own
 *    version spec. Yanked versions never resolve for a listing; a paused
 *    version is skipped unless the install already resolved to it or the
 *    reference pins it exactly; advisory-blocked versions are skipped.
 *  - Scan flags: a version the nightly rescan FLAGGED (fixable Criticals
 *    over `PLUGIN_VULN_MAX_CRITICAL`) resolves with a `VULN_FLAGGED` warning —
 *    or, with `PLUGIN_BLOCK_ON_NEW_CRITICAL` on, is skipped like an
 *    advisory-blocked one, and an exact pin to it is refused
 *    `PLUGIN_VERSION_VULN_BLOCKED`.
 */

import {
  asScanFlag, blockOnNewCritical, vulnBlockedMessage, vulnFlaggedWarning, type VulnFlaggedWarning,
} from '@pipeline-builder/api-core';
import { and, eq, inArray } from 'drizzle-orm';
import type { CrudTx } from './crud-service.js';
import {
  compareSemver, isVersionRange, parseSemver, parseVersionSpec, satisfiesVersionSpec,
} from './semver-range.js';
import {
  OFFICIAL_PUBLISHER_HANDLE,
  PUBLISHER_TIERS,
  schema,
  type AdvisorySeverity,
  type BlockedListingRef,
  type BlockOnAdvisory,
  type InstallVersionPolicy,
  type OfficialInstalls,
  type PluginAdvisory,
  type PluginInstall,
  type PluginInstallPolicy,
  type PluginListing,
  type PluginListingVersion,
  type Publisher,
  type PublisherTier,
} from '../database/drizzle-schema.js';

// -----------------------------------------------------------------------------
// Consumption policy
// -----------------------------------------------------------------------------

/** An org's consumption policy, as the resolver applies it. */
export interface ConsumptionPolicy {
  allowedTiers: PublisherTier[];
  requireApprovalTiers: PublisherTier[];
  secretsAllowedTiers: PublisherTier[];
  blockOnAdvisory: BlockOnAdvisory;
  officialInstalls: OfficialInstalls;
  blockedListings: BlockedListingRef[];
}

/** The defaults (and the column defaults of `plugin_install_policies`). */
export const DEFAULT_CONSUMPTION_POLICY: Readonly<ConsumptionPolicy> = Object.freeze<ConsumptionPolicy>({
  allowedTiers: ['official', 'verified'],
  requireApprovalTiers: ['community', 'unverified'],
  secretsAllowedTiers: ['official', 'verified'],
  blockOnAdvisory: 'critical',
  officialInstalls: 'implicit',
  blockedListings: [],
});

/** At most this many blocked listings per policy. */
export const MAX_BLOCKED_LISTINGS = 500;

const BLOCK_ORDER: readonly BlockOnAdvisory[] = ['never', 'critical', 'high'];

const sortTiers = (tiers: Iterable<PublisherTier>): PublisherTier[] =>
  PUBLISHER_TIERS.filter((t) => new Set(tiers).has(t));

const listingKey = (r: BlockedListingRef): string => `${r.publisher}/${r.name}`;

function uniqueListings(refs: readonly BlockedListingRef[]): BlockedListingRef[] {
  const seen = new Map<string, BlockedListingRef>();
  for (const r of refs) seen.set(listingKey(r), { publisher: r.publisher, name: r.name });
  return [...seen.values()].sort((a, b) => listingKey(a).localeCompare(listingKey(b)));
}

/** A stored policy row (or none) as a {@link ConsumptionPolicy}. */
export function policyOf(row: Partial<PluginInstallPolicy> | null | undefined): ConsumptionPolicy {
  const d = DEFAULT_CONSUMPTION_POLICY;
  return {
    allowedTiers: sortTiers(row?.allowedTiers ?? d.allowedTiers),
    requireApprovalTiers: sortTiers(row?.requireApprovalTiers ?? d.requireApprovalTiers),
    secretsAllowedTiers: sortTiers(row?.secretsAllowedTiers ?? d.secretsAllowedTiers),
    blockOnAdvisory: row?.blockOnAdvisory ?? d.blockOnAdvisory,
    officialInstalls: row?.officialInstalls ?? d.officialInstalls,
    blockedListings: uniqueListings(row?.blockedListings ?? d.blockedListings),
  };
}

/**
 * A team's policy under its root org's: each field takes the STRICTER of
 * the two, so a team can narrow what its root allows but never widen it.
 */
export function mergeConsumptionPolicies(root: ConsumptionPolicy, team: ConsumptionPolicy): ConsumptionPolicy {
  const intersect = (a: PublisherTier[], b: PublisherTier[]) => sortTiers(a.filter((t) => b.includes(t)));
  const union = (a: PublisherTier[], b: PublisherTier[]) => sortTiers([...a, ...b]);
  const stricterBlock = BLOCK_ORDER.indexOf(root.blockOnAdvisory) >= BLOCK_ORDER.indexOf(team.blockOnAdvisory)
    ? root.blockOnAdvisory : team.blockOnAdvisory;
  return {
    allowedTiers: intersect(root.allowedTiers, team.allowedTiers),
    requireApprovalTiers: union(root.requireApprovalTiers, team.requireApprovalTiers),
    secretsAllowedTiers: intersect(root.secretsAllowedTiers, team.secretsAllowedTiers),
    blockOnAdvisory: stricterBlock,
    officialInstalls: root.officialInstalls === 'explicit' || team.officialInstalls === 'explicit' ? 'explicit' : 'implicit',
    blockedListings: uniqueListings([...root.blockedListings, ...team.blockedListings]),
  };
}

/**
 * The policy an org's resolution runs under. A root org: its own row (or the
 * defaults). A team (`rootOrgId` set): its root's policy, merged with the
 * team's own row when it has one.
 */
export function effectiveConsumptionPolicy(
  rows: ReadonlyArray<Partial<PluginInstallPolicy> & { orgId?: string }>,
  orgId: string,
  rootOrgId?: string,
): ConsumptionPolicy {
  const own = rows.find((r) => r.orgId === orgId) ?? null;
  if (!rootOrgId || rootOrgId === orgId) return policyOf(own);
  const root = policyOf(rows.find((r) => r.orgId === rootOrgId) ?? null);
  return own ? mergeConsumptionPolicies(root, policyOf(own)) : root;
}

const HANDLE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

function tierList(v: unknown, field: string): PublisherTier[] | string {
  if (!Array.isArray(v)) return `${field} must be an array of tiers`;
  const bad = v.filter((t) => !(PUBLISHER_TIERS as readonly unknown[]).includes(t));
  if (bad.length) return `${field} has unknown tiers: ${bad.map(String).join(', ')}`;
  return sortTiers(v as PublisherTier[]);
}

/**
 * Validate a (partial) policy update over `base`. Returns the full new policy,
 * or an error message. `blockedListings` entries are `{ publisher, name }` or
 * `"publisher/name"`.
 */
export function applyPolicyUpdate(base: ConsumptionPolicy, input: unknown): ConsumptionPolicy | string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'body must be an object';
  const b = input as Record<string, unknown>;
  const next: ConsumptionPolicy = { ...base };
  for (const field of ['allowedTiers', 'requireApprovalTiers', 'secretsAllowedTiers'] as const) {
    if (b[field] === undefined) continue;
    const tiers = tierList(b[field], field);
    if (typeof tiers === 'string') return tiers;
    next[field] = tiers;
  }
  if (b.blockOnAdvisory !== undefined) {
    if (!BLOCK_ORDER.includes(b.blockOnAdvisory as BlockOnAdvisory)) return 'blockOnAdvisory must be critical, high or never';
    next.blockOnAdvisory = b.blockOnAdvisory as BlockOnAdvisory;
  }
  if (b.officialInstalls !== undefined) {
    if (b.officialInstalls !== 'implicit' && b.officialInstalls !== 'explicit') return 'officialInstalls must be implicit or explicit';
    next.officialInstalls = b.officialInstalls;
  }
  if (b.blockedListings !== undefined) {
    if (!Array.isArray(b.blockedListings)) return 'blockedListings must be an array';
    if (b.blockedListings.length > MAX_BLOCKED_LISTINGS) return `at most ${MAX_BLOCKED_LISTINGS} blocked listings`;
    const refs: BlockedListingRef[] = [];
    for (const raw of b.blockedListings) {
      const ref = typeof raw === 'string'
        ? (() => { const [publisher, name, extra] = raw.split('/'); return extra === undefined ? { publisher, name } : null; })()
        : raw && typeof raw === 'object' ? { publisher: (raw as BlockedListingRef).publisher, name: (raw as BlockedListingRef).name } : null;
      if (!ref || typeof ref.publisher !== 'string' || typeof ref.name !== 'string'
        || !HANDLE_RE.test(ref.publisher) || !NAME_RE.test(ref.name)) {
        return 'each blocked listing must be { publisher, name } (or "publisher/name")';
      }
      refs.push({ publisher: ref.publisher, name: ref.name });
    }
    next.blockedListings = uniqueListings(refs);
  }
  return next;
}

// -----------------------------------------------------------------------------
// Refusals and warnings
// -----------------------------------------------------------------------------

/** Why a reference can't resolve; `code` is an api-core `ErrorCode` name. */
export interface ResolutionRefusal {
  code: 'NOT_FOUND' | 'PLUGIN_NOT_INSTALLED' | 'PLUGIN_BLOCKED_BY_POLICY' | 'PLUGIN_UNAVAILABLE' | 'PLUGIN_VERSION_VULN_BLOCKED';
  reason: string;
  message: string;
  details?: Record<string, unknown>;
}

/** A non-fatal note a resolution carries (synth prints its `message`). */
export type ResolutionWarning =
  | { code: 'PLUGIN_ADVISORY' | 'PLUGIN_DEPRECATED' | 'PLUGIN_SECRETS_WITHHELD' | 'LISTING_UNMAINTAINED'; message: string }
  | VulnFlaggedWarning;

/** Why the org's policy (or the listing's state) keeps a listing out, or null. */
export interface ListingBlock {
  reason: 'tier' | 'blocked_listing' | 'suspended';
  message: string;
}

/** Whether `policy` (or the listing's own state) refuses the listing outright. */
export function listingBlock(
  policy: ConsumptionPolicy,
  publisher: Pick<Publisher, 'handle' | 'tier' | 'suspendedAt'>,
  listing: Pick<PluginListing, 'name' | 'state'>,
): ListingBlock | null {
  const ref = `${publisher.handle}/${listing.name}`;
  if (publisher.suspendedAt || listing.state === 'suspended' || listing.state === 'transferred') {
    return { reason: 'suspended', message: `${ref} is ${listing.state === 'transferred' ? 'transferred' : 'suspended'} and no longer resolves.` };
  }
  if (policy.blockedListings.some((b) => b.publisher === publisher.handle && b.name === listing.name)) {
    return { reason: 'blocked_listing', message: `Your organization's plugin policy blocks ${ref}.` };
  }
  if (!policy.allowedTiers.includes(publisher.tier)) {
    return { reason: 'tier', message: `Your organization's plugin policy doesn't allow ${publisher.tier} plugins (${ref}).` };
  }
  return null;
}

/** The refusal a {@link ListingBlock} becomes. */
export function blockRefusal(block: ListingBlock): ResolutionRefusal {
  return block.reason === 'suspended'
    ? { code: 'PLUGIN_UNAVAILABLE', reason: 'suspended', message: block.message }
    : { code: 'PLUGIN_BLOCKED_BY_POLICY', reason: block.reason, message: block.message };
}

// -----------------------------------------------------------------------------
// Advisories
// -----------------------------------------------------------------------------

/** Severities each `blockOnAdvisory` setting blocks. */
export const ADVISORY_BLOCK_SEVERITIES: Readonly<Record<BlockOnAdvisory, readonly AdvisorySeverity[]>> = {
  critical: ['critical'],
  high: ['critical', 'high'],
  never: [],
};

const COMPARATOR = /^(>=|<=|>|<|=)?\s*v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;

/** One comparator set (`>=1.0.0 <1.2.3`, `^1.2`, `1.x`, `1.0.0 - 1.2.0`) against `version`. */
function comparatorSetCovers(set: string, version: string): boolean {
  const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(set);
  if (hyphen) return compareSemver(version, hyphen[1]!) >= 0 && compareSemver(version, hyphen[2]!) <= 0;
  const parts = set.split(/\s+/).filter(Boolean);
  if (parts.length === 1 && parseVersionSpec(parts[0]!)) return satisfiesVersionSpec(version, parts[0]!);
  return parts.every((p) => {
    const m = COMPARATOR.exec(p);
    if (!m) return false;
    const c = compareSemver(version, m[2]!);
    switch (m[1] ?? '=') {
      case '>=': return c >= 0;
      case '<=': return c <= 0;
      case '>': return c > 0;
      case '<': return c < 0;
      default: return c === 0;
    }
  });
}

/**
 * Whether an advisory's `affectedRange` covers `version`: `||`-separated
 * comparator sets, each either the lookup spec forms (`^`, `~`, partial,
 * exact) or space-separated comparators (`>=1.0.0 <1.2.3`) or a hyphen range.
 * `*` covers everything; an unparseable range covers nothing.
 */
export function advisoryRangeCovers(range: string, version: string): boolean {
  if (!parseSemver(version)) return false;
  return range.split('||').map((s) => s.trim()).some((set) => set === '*' || (set !== '' && comparatorSetCovers(set, version)));
}

/**
 * Why `range` isn't a usable advisory range (the forms {@link advisoryRangeCovers}
 * understands), or null when it is. An advisory whose range parses as nothing
 * would silently cover nothing, so drafts are refused instead.
 */
export function advisoryRangeProblem(range: string): string | null {
  const trimmed = range.trim();
  if (trimmed === '') return 'the affected range is empty';
  if (trimmed.length > 255) return 'the affected range is longer than 255 characters';
  for (const set of trimmed.split('||').map((x) => x.trim())) {
    if (set === '*') continue;
    if (set === '') return 'the affected range has an empty "||" alternative';
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(set);
    if (hyphen) {
      if (!parseSemver(hyphen[1]!) || !parseSemver(hyphen[2]!)) return `"${set}" is not a valid hyphen range`;
      continue;
    }
    const parts = set.split(/\s+/).filter(Boolean);
    if (parts.length === 1 && parts[0] !== 'latest' && parseVersionSpec(parts[0]!)) continue;
    const bad = parts.find((x) => !COMPARATOR.test(x));
    if (bad !== undefined) return `"${bad}" is not a version, a ^/~ range or a comparator (>=, <=, >, <, =)`;
  }
  return null;
}

/** The PUBLISHED advisories whose range covers `version` (any severity), most severe first. */
export function advisoriesCovering<A extends Pick<PluginAdvisory, 'severity' | 'state' | 'affectedRange'>>(
  advisories: readonly A[],
  version: string,
): A[] {
  const rank: Record<AdvisorySeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  return advisories
    .filter((a) => a.state === 'published' && advisoryRangeCovers(a.affectedRange, version))
    .sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/** The PUBLISHED advisories the policy blocks `version` for. */
export function blockingAdvisories(
  advisories: readonly Pick<PluginAdvisory, 'id' | 'severity' | 'state' | 'affectedRange' | 'fixedVersion' | 'summary'>[],
  version: string,
  policy: Pick<ConsumptionPolicy, 'blockOnAdvisory'>,
): Array<Pick<PluginAdvisory, 'id' | 'severity' | 'state' | 'affectedRange' | 'fixedVersion' | 'summary'>> {
  const severities = ADVISORY_BLOCK_SEVERITIES[policy.blockOnAdvisory];
  if (severities.length === 0) return [];
  return advisories.filter((a) => a.state === 'published' && severities.includes(a.severity) && advisoryRangeCovers(a.affectedRange, version));
}

// -----------------------------------------------------------------------------
// Installs and version choice
// -----------------------------------------------------------------------------

/** How the org reaches a listing: an explicit install row, or the implicit Official one. */
export type InstallMode =
  | { kind: 'explicit'; install: PluginInstall; inherited: boolean }
  | { kind: 'implicit' };

type VersionRow = Pick<PluginListingVersion, 'version' | 'yankedAt' | 'pausedAt' | 'breaking'>;

/** The refusal an exact pin to a flagged version gets while blocking (409). */
function vulnRefusal(ref: string, v: Pick<PluginListingVersion, 'version' | 'scanFlag'>): ResolutionRefusal {
  const flag = asScanFlag(v.scanFlag) ?? { critical: 0, high: 0, maxCritical: 0, findings: [] };
  const fixed = [...new Set(flag.findings.flatMap((f) => f.fixedIn))];
  return {
    code: 'PLUGIN_VERSION_VULN_BLOCKED',
    reason: 'vuln_flagged',
    message: vulnBlockedMessage(ref, v.version, flag),
    details: { version: v.version, critical: flag.critical, high: flag.high, findings: flag.findings, ...(fixed.length ? { fixedVersions: fixed } : {}) },
  };
}

const isStable = (v: string): boolean => (parseSemver(v)?.prerelease.length ?? 1) === 0;

/**
 * The implicit Official install's range: every version of the LOWEST live
 * major (`<major>.x`) — patch and minor versions flow, a new major never does
 * (the org moves to it with an explicit install). Null when nothing is live.
 */
export function implicitInstallRange(versions: readonly VersionRow[]): string | null {
  const majors = versions
    .filter((v) => !v.yankedAt && isStable(v.version))
    .map((v) => parseSemver(v.version)!.major);
  if (majors.length === 0) return null;
  return `${Math.min(...majors)}.x`;
}

/** Whether an install's version policy admits `version` (the baseline is `pinnedVersion`). */
export function installAdmits(
  install: Pick<PluginInstall, 'versionPolicy' | 'pinnedVersion'>,
  version: string,
  versions: readonly VersionRow[],
): boolean {
  const base = install.pinnedVersion;
  switch (install.versionPolicy as InstallVersionPolicy) {
    case 'pinned':
      return version === base;
    case 'patch':
      return base !== null && satisfiesVersionSpec(version, `~${base}`);
    case 'minor':
      return base !== null && satisfiesVersionSpec(version, `^${base}`);
    case 'latest': {
      if (!isStable(version)) return false;
      if (base === null) return true;
      if (compareSemver(version, base) < 0) return false;
      // Never cross a version the publisher marked breaking.
      return !versions.some((v) => v.breaking && compareSemver(v.version, base) > 0 && compareSemver(v.version, version) <= 0);
    }
    default:
      return false;
  }
}

/** Whether `mode` admits `version` (the implicit range for an implicit install). */
export function modeAdmits(mode: InstallMode, version: string, versions: readonly VersionRow[]): boolean {
  if (mode.kind === 'explicit') return installAdmits(mode.install, version, versions);
  const range = implicitInstallRange(versions);
  return range !== null && satisfiesVersionSpec(version, range);
}

/** Input to {@link selectListingVersion}. */
export interface VersionChoiceInput<V extends PluginListingVersion = PluginListingVersion> {
  ref: string;
  versions: readonly V[];
  mode: InstallMode;
  /** The reference's own version spec (`filter.version`). */
  requested?: string;
  advisories: readonly PluginAdvisory[];
  policy: ConsumptionPolicy;
  /** Skip / refuse rescan-flagged versions (default: `PLUGIN_BLOCK_ON_NEW_CRITICAL`). */
  blockFlagged?: boolean;
}

/**
 * Pick the listed version a reference resolves to (see the module doc), or
 * the refusal that explains why none can.
 */
export function selectListingVersion<V extends PluginListingVersion>(input: VersionChoiceInput<V>): { version: V } | { refusal: ResolutionRefusal } {
  const { ref, versions, mode, requested, advisories, policy } = input;
  const blockFlagged = input.blockFlagged ?? blockOnNewCritical();
  const exact = requested !== undefined && !isVersionRange(requested) ? requested.trim() : null;

  if (exact !== null) {
    const v = versions.find((x) => x.version === exact);
    if (!v) return { refusal: { code: 'NOT_FOUND', reason: 'version_not_found', message: `${ref} has no published version ${exact}.` } };
    if (v.yankedAt) {
      return {
        refusal: {
          code: 'PLUGIN_UNAVAILABLE',
          reason: 'yanked',
          message: `${ref}@${exact} is yanked${v.yankReason ? `: ${v.yankReason}` : ''}. Move to a supported version.`,
          details: { version: exact },
        },
      };
    }
    if (mode.kind === 'explicit' && !installAdmits(mode.install, exact, versions)) {
      return {
        refusal: {
          code: 'PLUGIN_NOT_INSTALLED',
          reason: 'version_outside_install',
          message: `${ref}@${exact} is outside your install (${mode.install.versionPolicy} from ${mode.install.pinnedVersion}). Upgrade the install first.`,
          details: { version: exact, versionPolicy: mode.install.versionPolicy, pinnedVersion: mode.install.pinnedVersion },
        },
      };
    }
    const blocking = blockingAdvisories(advisories, exact, policy);
    if (blocking.length) return { refusal: advisoryRefusal(ref, exact, blocking) };
    if (blockFlagged && v.scanFlaggedAt) return { refusal: vulnRefusal(ref, v) };
    return { version: v };
  }

  const resolvedBefore = mode.kind === 'explicit' ? mode.install.resolvedVersion : null;
  // The range the INSTALL allows. For the implicit install an explicit spec on
  // the reference replaces the implicit range (it is a deliberate choice).
  const admitted = versions.filter((v) => !v.yankedAt
    && (mode.kind === 'explicit' ? installAdmits(mode.install, v.version, versions)
      : requested !== undefined || modeAdmits(mode, v.version, versions))
    && (requested === undefined || satisfiesVersionSpec(v.version, requested))
    && (!v.pausedAt || v.version === resolvedBefore));
  const allowed = admitted.filter((v) => blockingAdvisories(advisories, v.version, policy).length === 0
    && !(blockFlagged && v.scanFlaggedAt));
  // Ranges only admit prereleases they name (npm semantics), so the highest
  // admitted version is the answer.
  const best = highest(allowed.map((v) => v.version));
  if (best) return { version: allowed.find((v) => v.version === best)! };

  if (admitted.length > 0) {
    const newest = highest(admitted.map((v) => v.version))!;
    const blocking = blockingAdvisories(advisories, newest, policy);
    if (blocking.length === 0) return { refusal: vulnRefusal(ref, admitted.find((v) => v.version === newest)!) };
    return { refusal: advisoryRefusal(ref, newest, blocking) };
  }
  if (mode.kind === 'explicit' && requested !== undefined
    && versions.some((v) => !v.yankedAt && satisfiesVersionSpec(v.version, requested))) {
    return {
      refusal: {
        code: 'PLUGIN_NOT_INSTALLED',
        reason: 'version_outside_install',
        message: `No version of ${ref} matching ${requested} is inside your install (${mode.install.versionPolicy} from ${mode.install.pinnedVersion}). Upgrade the install first.`,
        details: { requested, versionPolicy: mode.install.versionPolicy, pinnedVersion: mode.install.pinnedVersion },
      },
    };
  }
  return {
    refusal: {
      code: 'NOT_FOUND',
      reason: 'no_matching_version',
      message: `No resolvable version of ${ref}${requested ? ` matches ${requested}` : ''}.`,
    },
  };
}

/** The highest of `versions` by semver (prereleases included). */
function highest(versions: readonly string[]): string | null {
  return versions.reduce<string | null>((best, v) => (best === null || compareSemver(v, best) > 0 ? v : best), null);
}

function advisoryRefusal(ref: string, version: string, blocking: ReadonlyArray<Pick<PluginAdvisory, 'id' | 'severity' | 'fixedVersion' | 'summary'>>): ResolutionRefusal {
  const fixed = blocking.map((a) => a.fixedVersion).filter((v): v is string => !!v);
  return {
    code: 'PLUGIN_BLOCKED_BY_POLICY',
    reason: 'advisory',
    message: `${ref}@${version} is blocked by your organization's advisory policy: ${blocking.map((a) => `${a.severity} — ${a.summary}`).join('; ')}.`
      + (fixed.length ? ` Fixed in ${fixed.join(', ')}.` : ''),
    details: { version, advisories: blocking.map((a) => a.id), ...(fixed.length ? { fixedVersions: fixed } : {}) },
  };
}

// -----------------------------------------------------------------------------
// The org's install state for one listing
// -----------------------------------------------------------------------------

/** The org (and, for a team, its root org) a resolution runs for. */
export interface ResolutionScope {
  orgId: string;
  /** The root org when the caller is a team. */
  rootOrgId?: string;
}

/** The org ids whose installs and policies apply, own first. */
export function scopeOrgIds(scope: ResolutionScope): string[] {
  const own = scope.orgId.toLowerCase();
  const root = scope.rootOrgId?.toLowerCase();
  return root && root !== own ? [own, root] : [own];
}

/**
 * How the org reaches `listing` — or the refusal. An ACTIVE own-org row wins,
 * then the root org's (a team inherits it); failing both, the implicit
 * Official install (unless the policy is `explicit`); otherwise the org's own
 * pending / denied row explains the refusal.
 */
export function installModeFor(
  publisher: Pick<Publisher, 'handle'>,
  listing: Pick<PluginListing, 'id' | 'name'>,
  installs: readonly PluginInstall[],
  policy: ConsumptionPolicy,
  scope: ResolutionScope,
): InstallMode | ResolutionRefusal {
  const [own, root] = scopeOrgIds(scope);
  const forListing = installs.filter((i) => i.listingId === listing.id);
  const ownRow = forListing.find((i) => i.orgId.toLowerCase() === own);
  const rootRow = root ? forListing.find((i) => i.orgId.toLowerCase() === root) : undefined;
  if (ownRow?.status === 'active') return { kind: 'explicit', install: ownRow, inherited: false };
  if (rootRow?.status === 'active') return { kind: 'explicit', install: rootRow, inherited: true };
  const ref = `${publisher.handle}/${listing.name}`;
  if (publisher.handle === OFFICIAL_PUBLISHER_HANDLE) {
    if (policy.officialInstalls === 'implicit') return { kind: 'implicit' };
    if (!ownRow) {
      return {
        code: 'PLUGIN_NOT_INSTALLED',
        reason: 'official_explicit',
        message: `Your organization installs Official plugins explicitly; install ${ref} first.`,
      };
    }
  }
  if (ownRow?.status === 'pending_approval') {
    return { code: 'PLUGIN_NOT_INSTALLED', reason: 'pending_approval', message: `The install of ${ref} is waiting for approval.` };
  }
  if (ownRow?.status === 'denied') {
    return { code: 'PLUGIN_NOT_INSTALLED', reason: 'denied', message: `The install of ${ref} was denied.` };
  }
  return { code: 'PLUGIN_NOT_INSTALLED', reason: 'not_installed', message: `${ref} is not installed in your organization.` };
}

// -----------------------------------------------------------------------------
// Data source
// -----------------------------------------------------------------------------

/** The rows the resolver reads. Implementations must run with a scope that can
 *  read the ecosystem tables and the org's (and root org's) install rows. */
export interface ListingDataSource {
  publisherByHandle(handle: string): Promise<Publisher | null>;
  publishersByIds(ids: string[]): Promise<Publisher[]>;
  listingByName(publisherId: string, name: string): Promise<PluginListing | null>;
  /** Listed / unmaintained listings (optionally only these ids or names). */
  liveListings(filter?: { ids?: string[]; names?: string[] }): Promise<PluginListing[]>;
  versionsForListings(listingIds: string[]): Promise<PluginListingVersion[]>;
  /** PUBLISHED advisories. */
  advisoriesForListings(listingIds: string[]): Promise<PluginAdvisory[]>;
  installsForOrgs(orgIds: string[]): Promise<PluginInstall[]>;
  policiesForOrgs(orgIds: string[]): Promise<PluginInstallPolicy[]>;
}

/**
 * A {@link ListingDataSource} over a drizzle transaction. The caller owns the
 * transaction's scope: it must be able to read the ecosystem tables (app-role
 * RLS) and the install rows of the org AND its root org (a team's reads of its
 * root's rows need an elevated scope, like parent-org plugin reads).
 */
export function drizzleListingSource(tx: CrudTx): ListingDataSource {
  const db = tx;
  const P = schema.publisher;
  const L = schema.pluginListing;
  const V = schema.pluginListingVersion;
  const A = schema.pluginAdvisory;
  const I = schema.pluginInstall;
  const IP = schema.pluginInstallPolicy;
  return {
    publisherByHandle: async (handle) => ((await db.select().from(P).where(eq(P.handle, handle))) as Publisher[])[0] ?? null,
    publishersByIds: async (ids) => (ids.length ? db.select().from(P).where(inArray(P.id, ids)) : []),
    listingByName: async (publisherId, name) =>
      ((await db.select().from(L).where(and(eq(L.publisherId, publisherId), eq(L.name, name)))) as PluginListing[])[0] ?? null,
    liveListings: async (filter = {}) => {
      if (filter.ids && filter.ids.length === 0) return [];
      if (filter.names && filter.names.length === 0) return [];
      return db.select().from(L).where(and(
        inArray(L.state, ['listed', 'unmaintained']),
        ...(filter.ids ? [inArray(L.id, filter.ids)] : []),
        ...(filter.names ? [inArray(L.name, filter.names)] : []),
      ));
    },
    versionsForListings: async (ids) => (ids.length ? db.select().from(V).where(inArray(V.listingId, ids)) : []),
    advisoriesForListings: async (ids) => (ids.length ? db.select().from(A).where(and(inArray(A.listingId, ids), eq(A.state, 'published'))) : []),
    installsForOrgs: async (orgIds) => (orgIds.length ? db.select().from(I).where(inArray(I.orgId, orgIds)) : []),
    policiesForOrgs: async (orgIds) => (orgIds.length ? db.select().from(IP).where(inArray(IP.orgId, orgIds)) : []),
  };
}

// -----------------------------------------------------------------------------
// Resolution
// -----------------------------------------------------------------------------

/** A plugin reference as the resolver reads it. */
export interface ListingReference {
  /** Publisher handle; absent = the Official listing (the unqualified fallback). */
  publisher?: string;
  name: string;
  /** The reference's `filter.version`. */
  version?: string;
}

/** A reference that resolved to a listed version. */
export interface ListingResolved {
  ok: true;
  publisher: Publisher;
  listing: PluginListing;
  version: PluginListingVersion;
  mode: InstallMode;
  policy: ConsumptionPolicy;
  /** The spec declares secrets the policy withholds from this tier. */
  secretsWithheld: boolean;
  warnings: ResolutionWarning[];
}

/** A reference that named a listing but can't resolve. */
export interface ListingRefused {
  ok: false;
  refusal: ResolutionRefusal;
  publisher?: Publisher;
  listing?: PluginListing;
}

/**
 * Resolve `ref` to a listed version for `scope`, or refuse. Null when the
 * listing doesn't exist at all (an unqualified reference then simply has no
 * Official fallback).
 */
export async function resolveListingReference(
  source: ListingDataSource,
  ref: ListingReference,
  scope: ResolutionScope,
): Promise<ListingResolved | ListingRefused | null> {
  const handle = ref.publisher ?? OFFICIAL_PUBLISHER_HANDLE;
  const publisher = await source.publisherByHandle(handle);
  if (!publisher) return null;
  const listing = await source.listingByName(publisher.id, ref.name);
  if (!listing) return null;

  const orgIds = scopeOrgIds(scope);
  const [policies, installs] = await Promise.all([source.policiesForOrgs(orgIds), source.installsForOrgs(orgIds)]);
  const policy = effectiveConsumptionPolicy(policies, orgIds[0]!, orgIds[1]);
  const block = listingBlock(policy, publisher, listing);
  if (block) return { ok: false, refusal: blockRefusal(block), publisher, listing };

  const mode = installModeFor(publisher, listing, installs, policy, scope);
  if ('code' in mode) return { ok: false, refusal: mode, publisher, listing };

  const [versions, advisories] = await Promise.all([
    source.versionsForListings([listing.id]),
    source.advisoriesForListings([listing.id]),
  ]);
  const ref_ = `${publisher.handle}/${listing.name}`;
  const choice = selectListingVersion({ ref: ref_, versions, mode, requested: ref.version, advisories, policy });
  if ('refusal' in choice) return { ok: false, refusal: choice.refusal, publisher, listing };

  const version = choice.version;
  const { warnings, secretsWithheld } = listedVersionWarnings({ publisher, listing, version, advisories, policy });
  return { ok: true, publisher, listing, version, mode, policy, secretsWithheld, warnings };
}

/**
 * The non-fatal notes a resolved listed version carries (lookup answers,
 * synth prints them, the installs view shows them): an unmaintained listing, a
 * deprecated version, a PUBLISHED advisory covering the version that the org's
 * `blockOnAdvisory` doesn't block (a blocking one refuses resolution instead),
 * and withheld secrets.
 */
export function listedVersionWarnings(input: {
  publisher: Pick<Publisher, 'handle' | 'tier'>;
  listing: Pick<PluginListing, 'name' | 'state'>;
  version: Pick<PluginListingVersion, 'version' | 'deprecatedAt' | 'deprecationMessage' | 'specSnapshot'>
    & Partial<Pick<PluginListingVersion, 'scanFlaggedAt' | 'scanFlag'>>;
  advisories: readonly Pick<PluginAdvisory, 'severity' | 'state' | 'affectedRange' | 'fixedVersion' | 'summary'>[];
  policy: Pick<ConsumptionPolicy, 'secretsAllowedTiers'>;
}): { warnings: ResolutionWarning[]; secretsWithheld: boolean } {
  const { publisher, listing, version, advisories, policy } = input;
  const ref = `${publisher.handle}/${listing.name}`;
  const declaresSecrets = (version.specSnapshot?.secrets ?? []).length > 0;
  const secretsWithheld = declaresSecrets && !policy.secretsAllowedTiers.includes(publisher.tier);
  const warnings: ResolutionWarning[] = [];
  if (listing.state === 'unmaintained') {
    warnings.push({ code: 'LISTING_UNMAINTAINED', message: `${ref} is unmaintained: it receives no updates. Plan a replacement.` });
  }
  if (version.deprecatedAt) {
    warnings.push({ code: 'PLUGIN_DEPRECATED', message: `${ref}@${version.version} is deprecated${version.deprecationMessage ? `: ${version.deprecationMessage}` : ''}.` });
  }
  for (const a of advisoriesCovering(advisories, version.version)) {
    warnings.push({
      code: 'PLUGIN_ADVISORY',
      message: `${ref}@${version.version} is affected by a ${a.severity} security advisory: ${a.summary}`
        + `${a.fixedVersion ? ` Fixed in ${a.fixedVersion}.` : ''}`,
    });
  }
  const flag = version.scanFlaggedAt ? asScanFlag(version.scanFlag) : null;
  if (flag) warnings.push(vulnFlaggedWarning(ref, version.version, flag));
  if (secretsWithheld) {
    warnings.push({ code: 'PLUGIN_SECRETS_WITHHELD', message: `${ref} is a ${publisher.tier} plugin; your organization's policy gives it no secrets, so its declared secrets are not injected.` });
  }
  return { warnings, secretsWithheld };
}

/**
 * The plugin record a resolved listing version runs as — the shape synth and
 * the contract check read (a `plugins` row's run fields), built from the
 * version's frozen spec snapshot. `id` is the LISTING VERSION's id (the step
 * manifest resolves it back), `imageRepository` its `public/*` copy.
 */
export function listedPluginRecord(res: ListingResolved): Record<string, unknown> {
  const { publisher, listing, version, mode } = res;
  const s = (version.specSnapshot ?? {}) as Record<string, unknown>;
  const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? v as T[] : []);
  const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
  return {
    id: version.id,
    source: 'listing',
    publisher: publisher.handle,
    publisherTier: publisher.tier,
    listingId: listing.id,
    install: mode.kind,
    name: listing.name,
    version: version.version,
    imageRepository: version.imageRepository,
    imageDigest: version.imageDigest,
    buildType: typeof s.buildType === 'string' ? s.buildType : (version.imageDigest ? 'build_image' : 'metadata_only'),
    pluginType: s.pluginType ?? 'CodeBuildStep',
    computeType: s.computeType ?? 'SMALL',
    description: s.description ?? listing.description ?? null,
    summary: s.summary ?? listing.summary ?? null,
    displayName: s.displayName ?? null,
    keywords: arr<string>(s.keywords),
    category: s.category ?? listing.category,
    metadata: obj(s.metadata),
    env: obj(s.env),
    buildArgs: {},
    installCommands: arr<string>(s.installCommands),
    commands: arr<string>(s.commands),
    timeout: s.timeout ?? null,
    failureBehavior: s.failureBehavior ?? 'fail',
    primaryOutputDirectory: s.primaryOutputDirectory ?? null,
    secrets: res.secretsWithheld ? [] : arr(s.secrets),
    requiredMetadata: arr<string>(s.requiredMetadata),
    requiredVars: arr<string>(s.requiredVars),
    metadataTypes: obj(s.metadataTypes),
    varsTypes: obj(s.varsTypes),
    networkEgress: arr<string>(s.networkEgress),
    runAsRoot: s.runAsRoot ?? null,
    license: s.license ?? listing.license ?? null,
    homepageUrl: s.homepageUrl ?? listing.homepageUrl ?? null,
    sourceUrl: s.sourceUrl ?? listing.sourceUrl ?? null,
    documentationUrl: s.documentationUrl ?? null,
    icon: s.icon ?? listing.icon ?? null,
    changelog: version.changelog,
    breaking: version.breaking,
    vulnCritical: version.vulnCritical,
    vulnHigh: version.vulnHigh,
    vulnCriticalFixable: version.vulnCriticalFixable,
    vulnHighFixable: version.vulnHighFixable,
    scannedAt: version.scannedAt,
    scanFlaggedAt: version.scanFlaggedAt,
    scanFlag: version.scanFlag,
    lifecycle: version.deprecatedAt ? 'deprecated' : 'production',
    deprecatedAt: version.deprecatedAt,
    deprecationMessage: version.deprecationMessage,
    yankedAt: null,
    yankReason: null,
    visibility: 'public',
    isDefault: true,
    isActive: true,
  };
}

// -----------------------------------------------------------------------------
// Everything an org can resolve (catalog, AI selection, placeholder guard)
// -----------------------------------------------------------------------------

/** One listing with the org's standing on it. */
export interface OrgListingState {
  publisher: Publisher;
  listing: PluginListing;
  versions: PluginListingVersion[];
  /** How the org reaches it, or why it can't (not installed, pending, …). */
  mode: InstallMode | ResolutionRefusal;
  /** A policy / state block (tier, blocked listing, suspended), or null. */
  block: ListingBlock | null;
  /** What an UNVERSIONED reference resolves to right now, or null. */
  resolved: PluginListingVersion | null;
  /** Why nothing resolves, when the org does reach the listing (e.g. an advisory block). */
  refusal: ResolutionRefusal | null;
  /** The listing's PUBLISHED advisories. */
  advisories: PluginAdvisory[];
  /** The org's own install row for it (explicit, possibly pending/denied). */
  ownInstall: PluginInstall | null;
  /** The org's effective consumption policy (the same for every listing). */
  policy: ConsumptionPolicy;
}

/** The org's policy + install rows (own and root). */
export interface OrgInstallContext {
  policy: ConsumptionPolicy;
  installs: PluginInstall[];
  scope: ResolutionScope;
}

/** Load the org's policy and install rows. */
export async function loadOrgInstallContext(source: ListingDataSource, scope: ResolutionScope): Promise<OrgInstallContext> {
  const orgIds = scopeOrgIds(scope);
  const [policies, installs] = await Promise.all([source.policiesForOrgs(orgIds), source.installsForOrgs(orgIds)]);
  return { policy: effectiveConsumptionPolicy(policies, orgIds[0]!, orgIds[1]), installs, scope };
}

/**
 * The org's standing on every live listing (or only `filter`'s). Used by the
 * in-app catalog; {@link resolvableListings} narrows it to what resolves.
 */
export async function orgListingStates(
  source: ListingDataSource,
  scope: ResolutionScope,
  filter: { ids?: string[]; names?: string[] } = {},
  ctx?: OrgInstallContext,
): Promise<OrgListingState[]> {
  const context = ctx ?? await loadOrgInstallContext(source, scope);
  const live = await source.liveListings(filter);
  if (live.length === 0) return [];
  const ids = live.map((l) => l.id);
  const [pubs, versions, advisories] = await Promise.all([
    source.publishersByIds([...new Set(live.map((l) => l.publisherId))]),
    source.versionsForListings(ids),
    source.advisoriesForListings(ids),
  ]);
  const byPublisher = new Map(pubs.map((p) => [p.id, p]));
  const own = scopeOrgIds(scope)[0]!;
  const out: OrgListingState[] = [];
  for (const listing of live) {
    const publisher = byPublisher.get(listing.publisherId);
    if (!publisher) continue;
    const vs = versions.filter((v) => v.listingId === listing.id);
    const block = listingBlock(context.policy, publisher, listing);
    const mode = installModeFor(publisher, listing, context.installs, context.policy, scope);
    const listingAdvisories = advisories.filter((a) => a.listingId === listing.id);
    let resolved: PluginListingVersion | null = null;
    let refusal: ResolutionRefusal | null = null;
    if (!block && !('code' in mode)) {
      const choice = selectListingVersion({
        ref: `${publisher.handle}/${listing.name}`, versions: vs, mode, advisories: listingAdvisories, policy: context.policy,
      });
      if ('version' in choice) resolved = choice.version;
      else refusal = choice.refusal;
    }
    const ownInstall = context.installs.find((i) => i.listingId === listing.id && i.orgId.toLowerCase() === own) ?? null;
    out.push({ publisher, listing, versions: vs, mode, block, resolved, refusal, advisories: listingAdvisories, ownInstall, policy: context.policy });
  }
  return out;
}

/** The listings an org's references resolve to now (installed or implicit, not blocked). */
export async function resolvableListings(
  source: ListingDataSource,
  scope: ResolutionScope,
  filter: { names?: string[] } = {},
): Promise<Array<OrgListingState & { resolved: PluginListingVersion }>> {
  return (await orgListingStates(source, scope, filter))
    .filter((s): s is OrgListingState & { resolved: PluginListingVersion } => s.resolved !== null);
}
