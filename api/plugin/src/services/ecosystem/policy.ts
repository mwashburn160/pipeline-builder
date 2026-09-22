// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The pure rules of the publish-request queue (docs/plans/plugin-ecosystem.md
 * §3.0–§3.4): version bumps, contract deltas, the submit gates, who decides
 * what, two-person approval, and auto-approval rule evaluation. No I/O — the
 * request service feeds it rows and acts on the verdicts.
 */

import {
  PLUGIN_CATALOG_LINK_FIELDS,
  STEP_UP_REQUEST_KINDS,
  VERIFY_REQUEST_KINDS,
  type PluginCatalogField,
} from '@pipeline-builder/api-core';
import { compareSemver, parseSemver, type ListingVersionSpecSnapshot, type PublisherTier } from '@pipeline-builder/pipeline-data';

import type { PluginRow } from './store.js';

// -----------------------------------------------------------------------------
// Versions
// -----------------------------------------------------------------------------

export type VersionBump = 'major' | 'minor' | 'patch' | 'prerelease' | 'same' | 'downgrade' | 'invalid';

/** How `next` relates to `previous` (null previous ⇒ a first version, reported as 'major'). */
export function versionBump(previous: string | null, next: string): VersionBump {
  const n = parseSemver(next);
  if (!n) return 'invalid';
  if (previous === null) return 'major';
  const p = parseSemver(previous);
  if (!p) return 'invalid';
  const cmp = compareSemver(next, previous);
  if (cmp === 0) return 'same';
  if (cmp < 0) return 'downgrade';
  if (n.prerelease.length > 0) return 'prerelease';
  if (n.major !== p.major) return 'major';
  if (n.minor !== p.minor) return 'minor';
  return 'patch';
}

/** The highest STABLE version among `versions` (prereleases only when nothing else). */
export function latestVersion(versions: readonly string[]): string | null {
  const sorted = [...versions].sort((a, b) => compareSemver(b, a));
  return sorted.find((v) => (parseSemver(v)?.prerelease.length ?? 1) === 0) ?? sorted[0] ?? null;
}

// -----------------------------------------------------------------------------
// The frozen per-version snapshot (§3.3 / §3.6) and contract deltas (§3.0.2)
// -----------------------------------------------------------------------------

/**
 * Freeze the resolved plugin record at approval: everything an installer's
 * synth needs, so a listed version keeps working after the publisher org's own
 * row is deleted or purged. Only the keys the `public_listed_versions` view
 * projects are public.
 */
export function specSnapshot(p: PluginRow): ListingVersionSpecSnapshot {
  return {
    pluginType: p.pluginType,
    computeType: p.computeType,
    secrets: p.secrets ?? [],
    requiredMetadata: p.requiredMetadata ?? [],
    requiredVars: p.requiredVars ?? [],
    networkEgress: p.networkEgress ?? [],
    runAsRoot: p.runAsRoot ?? undefined,
    license: p.license ?? undefined,
    readmeHtml: p.readmeHtml ?? undefined,
    imageSource: p.imageSource ?? undefined,
    buildType: p.buildType,
    metadata: p.metadata ?? {},
    metadataTypes: p.metadataTypes ?? {},
    varsTypes: p.varsTypes ?? {},
    env: p.env ?? {},
    installCommands: p.installCommands ?? [],
    commands: p.commands ?? [],
    timeout: p.timeout,
    failureBehavior: p.failureBehavior,
    primaryOutputDirectory: p.primaryOutputDirectory,
    smokeTest: p.smokeTest,
    dockerfile: p.dockerfile,
    description: p.description,
    summary: p.summary,
    displayName: p.displayName,
    keywords: p.keywords ?? [],
    category: p.category,
    homepageUrl: p.homepageUrl,
    sourceUrl: p.sourceUrl,
    documentationUrl: p.documentationUrl,
    icon: p.icon,
    changelog: p.changelog,
  };
}

const strings = (v: unknown): string[] =>
  (Array.isArray(v) ? v : []).map((x) => (typeof x === 'string' ? x : (x as { name?: string })?.name)).filter((x): x is string => typeof x === 'string');

function setDelta(previous: string[], current: string[]): { added: string[]; removed: string[] } {
  const prev = new Set(previous);
  const cur = new Set(current);
  return { added: [...cur].filter((x) => !prev.has(x)).sort(), removed: [...prev].filter((x) => !cur.has(x)).sort() };
}

export interface ContractDiff {
  secrets: { added: string[]; removed: string[] };
  egress: { added: string[]; removed: string[] };
  requiredMetadata: { added: string[]; removed: string[] };
  requiredVars: { added: string[]; removed: string[] };
  env: { added: string[]; removed: string[]; changed: string[] };
  commands: { previous: string[]; current: string[]; changed: boolean };
  installCommands: { previous: string[]; current: string[]; changed: boolean };
  runAsRoot: { previous: boolean | null; current: boolean | null; regression: boolean };
  pluginType: { previous: string | null; current: string | null };
  computeType: { previous: string | null; current: string | null };
}

/**
 * What changed in the execution contract between the previous APPROVED version
 * (`previous`, a frozen snapshot; null for a first listing) and `current`. Env
 * is compared by KEY (values never leave the service).
 */
export function contractDiff(previous: ListingVersionSpecSnapshot | null, current: ListingVersionSpecSnapshot): ContractDiff {
  const prev = previous ?? {};
  const envPrev = (prev.env ?? {}) as Record<string, unknown>;
  const envCur = (current.env ?? {}) as Record<string, unknown>;
  const envDelta = setDelta(Object.keys(envPrev), Object.keys(envCur));
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
  const cmdsPrev = list(prev.commands);
  const cmdsCur = list(current.commands);
  const instPrev = list(prev.installCommands);
  const instCur = list(current.installCommands);
  const rootPrev = typeof prev.runAsRoot === 'boolean' ? prev.runAsRoot : null;
  const rootCur = typeof current.runAsRoot === 'boolean' ? current.runAsRoot : null;
  return {
    secrets: setDelta(strings(prev.secrets), strings(current.secrets)),
    egress: setDelta(strings(prev.networkEgress), strings(current.networkEgress)),
    requiredMetadata: setDelta(strings(prev.requiredMetadata), strings(current.requiredMetadata)),
    requiredVars: setDelta(strings(prev.requiredVars), strings(current.requiredVars)),
    env: {
      ...envDelta,
      changed: Object.keys(envCur).filter((k) => k in envPrev && JSON.stringify(envPrev[k]) !== JSON.stringify(envCur[k])).sort(),
    },
    commands: { previous: cmdsPrev, current: cmdsCur, changed: JSON.stringify(cmdsPrev) !== JSON.stringify(cmdsCur) },
    installCommands: { previous: instPrev, current: instCur, changed: JSON.stringify(instPrev) !== JSON.stringify(instCur) },
    // A regression is a move TO root — from non-root, or into a listing whose
    // previous version's user was known to be non-root.
    runAsRoot: { previous: rootPrev, current: rootCur, regression: rootCur === true && rootPrev !== true },
    pluginType: { previous: (prev.pluginType as string | undefined) ?? null, current: (current.pluginType as string | undefined) ?? null },
    computeType: { previous: (prev.computeType as string | undefined) ?? null, current: (current.computeType as string | undefined) ?? null },
  };
}

/** Vulnerability counts of one version (null = not scanned). */
export interface VulnCounts { critical: number | null; high: number | null }

/** New criticals/highs compared with the previous listed version (a first listing counts all). */
export function vulnDelta(previous: VulnCounts | null, current: VulnCounts): { newCritical: number; newHigh: number } {
  const d = (cur: number | null, prev: number | null | undefined) => Math.max(0, (cur ?? 0) - (prev ?? 0));
  return { newCritical: d(current.critical, previous?.critical), newHigh: d(current.high, previous?.high) };
}

// -----------------------------------------------------------------------------
// Submit gates (§3.1: public visibility, license, README, a passing vuln gate)
// -----------------------------------------------------------------------------

export interface Gate {
  id: string;
  ok: boolean;
  message: string;
}

/** Highest number of CRITICAL vulnerabilities a version may carry to be requested (the vuln gate). */
export function vulnGateMaxCritical(): number {
  const n = Number.parseInt(process.env.ECOSYSTEM_VULN_GATE_MAX_CRITICAL ?? '0', 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * The gates a plugin VERSION must pass for a new-listing / new-version request.
 * An image plugin must be signed (it has a digest — only signed images get one)
 * and scanned, with at most {@link vulnGateMaxCritical} criticals.
 */
export function versionGates(p: PluginRow): Gate[] {
  const hasImage = p.imageDigest !== null;
  const maxCritical = vulnGateMaxCritical();
  const gates: Gate[] = [
    { id: 'visibility', ok: p.visibility === 'public', message: p.visibility === 'public' ? 'Visibility is public' : 'Set the version\'s visibility to public before requesting a listing' },
    { id: 'license', ok: !!p.license, message: p.license ? `License: ${p.license}` : 'Declare an SPDX license (spec `license`, or the Dockerfile `org.opencontainers.image.licenses` label)' },
    { id: 'readme', ok: !!p.readmeHtml, message: p.readmeHtml ? 'README included' : 'Add a README.md to the plugin package' },
  ];
  if (p.buildType !== 'metadata_only' && p.pluginType !== 'ManualApprovalStep') {
    gates.push(
      { id: 'signed', ok: hasImage, message: hasImage ? 'Image signed' : 'The version has no signed image — rebuild it' },
      { id: 'scanned', ok: p.scannedAt !== null, message: p.scannedAt !== null ? 'Image scanned' : 'The image has not been scanned for vulnerabilities yet' },
      {
        id: 'vuln',
        ok: p.scannedAt !== null && (p.vulnCritical ?? 0) <= maxCritical,
        message: (p.vulnCritical ?? 0) <= maxCritical
          ? `${p.vulnCritical ?? 0} critical, ${p.vulnHigh ?? 0} high vulnerabilities`
          : `${p.vulnCritical} critical vulnerabilities (at most ${maxCritical} allowed) — fix them and upload a new version`,
      },
    );
  }
  return gates;
}

// -----------------------------------------------------------------------------
// Who decides, and how
// -----------------------------------------------------------------------------

/** The system-org permission a request's decision needs. */
export function requiredDecisionPermission(kind: string): 'plugins:moderate' | 'publishers:verify' {
  return VERIFY_REQUEST_KINDS.includes(kind) ? 'publishers:verify' : 'plugins:moderate';
}

/** Whether deciding a request of this kind needs a step-up (§5a). */
export function decisionNeedsStepUp(kind: string): boolean {
  return STEP_UP_REQUEST_KINDS.includes(kind);
}

/**
 * Two-person approval (§3.0.1): every Official request (listings, versions not
 * covered by the Official auto-approval rule, listing updates), Verified
 * applications (a tier change to Verified), the system-created moderation
 * actions (unyank, lifting a suspension, a tier change to Verified), and every
 * anonymous submission (§4: nobody vouches for the submitter).
 */
export function needsTwoPerson(kind: string, publisherTier: PublisherTier): boolean {
  if (kind === 'verify' || kind === 'moderation' || kind === 'submission') return true;
  return publisherTier === 'official';
}

// -----------------------------------------------------------------------------
// Metadata (§3.1a)
// -----------------------------------------------------------------------------

/** Descriptive fields that can change without touching links or the icon (auto-approvable "text-only"). */
export const TEXT_ONLY_FIELDS: readonly PluginCatalogField[] = [
  'displayName', 'summary', 'description', 'category', 'keywords', 'license', 'changelog', 'readme',
];

/** Whether a listing_update touches text fields only (no links, no icon). */
export function isTextOnly(fields: readonly string[]): boolean {
  return fields.every((f) => (TEXT_ONLY_FIELDS as readonly string[]).includes(f));
}

/** Whether a field is a link (a user-edited link is highlighted in review, G36). */
export function isLinkField(field: string): boolean {
  return (PLUGIN_CATALOG_LINK_FIELDS as readonly string[]).includes(field);
}

/** Order-insensitive value equality for catalog values (keyword lists compare as sets). */
export function sameValue(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): unknown => {
    if (v === undefined || v === '' ) return null;
    if (Array.isArray(v)) return [...v].map(String).sort();
    return v;
  };
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

// -----------------------------------------------------------------------------
// Auto-approval rules (§3.0.3, D5)
// -----------------------------------------------------------------------------

export interface AutoRuleConditions {
  requestKinds?: string[];
  publisherTiers?: PublisherTier[];
  bumps?: Array<'patch' | 'minor'>;
  submitterServiceAccount?: string;
  textOnlyListingUpdates?: boolean;
  maxPerListingPerDay?: number;
  maxPerDay?: number;
  instanceFlag?: string;
  seeded?: string;
}

/** Everything a rule decides on, gathered by the request service. */
export interface AutoApprovalContext {
  kind: string;
  publisherTier: PublisherTier;
  /** `service_account:<name>` for a service account, `user` for a person. */
  submitterServiceAccount: string | null;
  /** new_version only. */
  bump?: VersionBump;
  breaking?: boolean;
  diff?: ContractDiff;
  vuln?: { newCritical: number; newHigh: number };
  signed?: boolean;
  scanned?: boolean;
  /** listing_update only: the fields it changes. */
  changedFields?: string[];
  /** Whether the listing already exists and is listed / unmaintained. */
  listingLive: boolean;
  /** Auto-approvals by this rule in the last 24 h: overall and for this listing. */
  approvedToday: number;
  approvedTodayForListing: number;
  /** Whether the rule's instance flag is on. */
  flagOn: boolean;
  /** An open security advisory fix never waits on the cap. */
  securityLane?: boolean;
}

/**
 * Whether `conditions` auto-approves the request. `reasons` explains every
 * failed condition (shown in the review view), empty when eligible. The fixed
 * SAFETY checks apply to every rule regardless of its conditions: the digest is
 * pinned (always, at submit), the image is signed and scanned with no new
 * critical/high vulnerabilities, and no new secrets, egress hosts, required
 * inputs or root.
 */
export function evaluateAutoRule(conditions: AutoRuleConditions, ctx: AutoApprovalContext): { eligible: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!ctx.flagOn) reasons.push(`the instance flag ${conditions.instanceFlag ?? ''} is off`.trim());
  if (!(conditions.requestKinds ?? []).includes(ctx.kind)) reasons.push(`the rule does not cover ${ctx.kind} requests`);
  if (!(conditions.publisherTiers ?? []).includes(ctx.publisherTier)) reasons.push(`the rule does not cover ${ctx.publisherTier} publishers`);
  if (conditions.submitterServiceAccount && ctx.submitterServiceAccount !== conditions.submitterServiceAccount) {
    reasons.push(`only requests from the ${conditions.submitterServiceAccount} service account qualify`);
  }
  if (!ctx.listingLive) reasons.push('the listing must already exist and be listed');

  if (ctx.kind === 'new_version') {
    const bumps = conditions.bumps ?? [];
    if (!ctx.bump || !(bumps as string[]).includes(ctx.bump)) reasons.push(`a ${ctx.bump ?? 'unknown'} version bump is not covered (allowed: ${bumps.join(', ') || 'none'})`);
    if (ctx.breaking) reasons.push('the version is marked breaking');
    if (ctx.signed === false) reasons.push('the image is not signed');
    if (ctx.scanned === false) reasons.push('the image has not been scanned');
    if (ctx.vuln && ctx.vuln.newCritical > 0) reasons.push(`${ctx.vuln.newCritical} new critical vulnerabilities`);
    if (ctx.vuln && ctx.vuln.newHigh > 0) reasons.push(`${ctx.vuln.newHigh} new high vulnerabilities`);
    const d = ctx.diff;
    if (d) {
      if (d.secrets.added.length) reasons.push(`new secrets: ${d.secrets.added.join(', ')}`);
      if (d.egress.added.length) reasons.push(`new egress hosts: ${d.egress.added.join(', ')}`);
      if (d.requiredMetadata.added.length) reasons.push(`new required metadata: ${d.requiredMetadata.added.join(', ')}`);
      if (d.requiredVars.added.length) reasons.push(`new required vars: ${d.requiredVars.added.join(', ')}`);
      if (d.runAsRoot.regression) reasons.push('the image now runs as root');
    }
  } else if (ctx.kind === 'listing_update') {
    if (conditions.textOnlyListingUpdates && !isTextOnly(ctx.changedFields ?? [])) {
      reasons.push('the update changes a link or the icon (text-only updates qualify)');
    }
  }

  if (!ctx.securityLane) {
    if (conditions.maxPerListingPerDay !== undefined && ctx.approvedTodayForListing >= conditions.maxPerListingPerDay) {
      reasons.push(`the per-listing cap (${conditions.maxPerListingPerDay}/day) is reached`);
    }
    if (conditions.maxPerDay !== undefined && ctx.approvedToday >= conditions.maxPerDay) {
      reasons.push(`the daily cap (${conditions.maxPerDay}/day) is reached`);
    }
  }
  return { eligible: reasons.length === 0, reasons };
}

/**
 * Whether `next` widens `previous` (enabling or broadening a rule needs a
 * second approver; §3.0.1). Anything other than a pure narrowing counts: more
 * kinds, tiers or bumps; a dropped submitter pin, text-only restriction or
 * instance flag; a higher (or removed) cap.
 */
export function widensRule(previous: AutoRuleConditions, next: AutoRuleConditions): boolean {
  const superset = (a: unknown[] | undefined, b: unknown[] | undefined) => (b ?? []).some((x) => !(a ?? []).includes(x));
  if (superset(previous.requestKinds, next.requestKinds)) return true;
  if (superset(previous.publisherTiers, next.publisherTiers)) return true;
  if (superset(previous.bumps, next.bumps)) return true;
  if (previous.submitterServiceAccount && next.submitterServiceAccount !== previous.submitterServiceAccount) return true;
  if (previous.textOnlyListingUpdates && !next.textOnlyListingUpdates) return true;
  if (previous.instanceFlag && next.instanceFlag !== previous.instanceFlag) return true;
  const capWidened = (a: number | undefined, b: number | undefined) => a !== undefined && (b === undefined || b > a);
  return capWidened(previous.maxPerDay, next.maxPerDay) || capWidened(previous.maxPerListingPerDay, next.maxPerListingPerDay);
}
