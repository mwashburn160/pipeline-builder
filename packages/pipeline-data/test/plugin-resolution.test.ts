// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The listing resolver: the
 * consumption-policy merge and validation, advisory ranges, install ranges,
 * version choice, the install mode for an org, whole-reference resolution over
 * an in-memory data source, the org's catalog standing, and the drizzle data
 * source's queries.
 */

import { describe, it, expect } from '@jest/globals';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { CrudTx } from '../src/api/crud-service.js';

import {
  advisoriesCovering,
  advisoryRangeCovers,
  advisoryRangeProblem,
  blockingAdvisories,
} from '../src/api/plugin-advisories.js';
import {
  applyPolicyUpdate,
  DEFAULT_CONSUMPTION_POLICY,
  effectiveConsumptionPolicy,
  mergeConsumptionPolicies,
  policyOf,
  type ConsumptionPolicy,
} from '../src/api/plugin-consumption-policy.js';
import {
  blockRefusal,
  drizzleListingSource,
  implicitInstallRange,
  installAdmits,
  installModeFor,
  listedPluginRecord,
  listedVersionWarnings,
  listingBlock,
  modeAdmits,
  orgListingStates,
  resolvableListings,
  resolveListingReference,
  scopeOrgIds,
  selectListingVersion,
  type ListingDataSource,
} from '../src/api/plugin-resolution.js';
import type {
  PluginAdvisory, PluginInstall, PluginInstallPolicy, PluginListing, PluginListingVersion, Publisher,
} from '../src/database/drizzle-schema.js';

const T0 = new Date('2026-09-01T00:00:00Z');

function publisher(over: Partial<Publisher> = {}): Publisher {
  return {
    id: 'pub-official',
    ownerOrgId: 'system',
    handle: 'pipeline-builder',
    displayName: 'Pipeline Builder',
    description: null,
    homepageUrl: null,
    tier: 'official',
    verifiedAt: T0,
    verifiedGraceUntil: null,
    termsVersion: null,
    termsAcceptedAt: null,
    suspendedAt: null,
    suspendReason: null,
    successRate30d: null,
    healthScore: null,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

function listing(over: Partial<PluginListing> = {}): PluginListing {
  return {
    id: 'l-trivy',
    publisherId: 'pub-official',
    name: 'trivy',
    category: 'security',
    summary: 'Scan',
    description: 'Scans images',
    readmeHtml: null,
    license: 'MIT',
    homepageUrl: null,
    sourceUrl: null,
    icon: null,
    uploadedIcon: null,
    keywords: [],
    state: 'listed',
    pausedAt: null,
    featured: false,
    latestVersion: '1.2.0',
    searchVector: null,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

function version(v: string, over: Partial<PluginListingVersion> = {}): PluginListingVersion {
  return {
    id: `lv-${v}`,
    listingId: 'l-trivy',
    sourcePluginId: null,
    version: v,
    imageDigest: `sha256:${'a'.repeat(64)}`,
    imageRepository: 'public/pipeline-builder/trivy',
    specSnapshot: { commands: ['trivy'], secrets: [] },
    breaking: false,
    pausedAt: null,
    yankedAt: null,
    yankReason: null,
    deprecatedAt: null,
    deprecationMessage: null,
    changelog: `v${v}`,
    vulnCritical: 0,
    vulnHigh: 0,
    vulnCriticalFixable: 0,
    vulnHighFixable: 0,
    scannedAt: T0,
    scanFlaggedAt: null,
    scanFlag: null,
    baseImageCreatedAt: null,
    imageCollectedAt: null,
    publishedAt: T0,
    publishedBy: 'system',
    ...over,
  };
}

function install(over: Partial<PluginInstall> = {}): PluginInstall {
  return {
    id: 'i-1',
    orgId: 'org-a',
    listingId: 'l-trivy',
    versionPolicy: 'minor',
    pinnedVersion: '1.0.0',
    resolvedVersion: null,
    status: 'active',
    installedBy: 'u-1',
    approvedBy: null,
    decidedAt: null,
    pendingChange: null,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

function advisory(over: Partial<PluginAdvisory> = {}): PluginAdvisory {
  return {
    id: 'adv-1',
    listingId: 'l-trivy',
    publisherId: 'pub-official',
    affectedRange: '<1.2.0',
    fixedVersion: '1.2.0',
    severity: 'critical',
    summary: 'RCE',
    detailsMd: null,
    detailsHtml: null,
    cveIds: [],
    state: 'published',
    source: 'publisher',
    createdBy: 'u',
    publishedBy: 'm',
    publishedAt: T0,
    withdrawnAt: null,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

const policy = (over: Partial<ConsumptionPolicy> = {}): ConsumptionPolicy => ({ ...policyOf(null), ...over });

describe('consumption policy', () => {
  it('defaults every field', () => {
    expect(policyOf(null)).toEqual({
      allowedTiers: ['official', 'verified'],
      requireApprovalTiers: ['community', 'unverified'],
      secretsAllowedTiers: ['official', 'verified'],
      blockOnAdvisory: 'critical',
      officialInstalls: 'implicit',
      blockedListings: [],
    });
    expect(policyOf(undefined)).toEqual(DEFAULT_CONSUMPTION_POLICY);
  });

  it('normalizes tier order and de-duplicates blocked listings', () => {
    const p = policyOf({ allowedTiers: ['verified', 'official'], blockedListings: [{ publisher: 'b', name: 'x' }, { publisher: 'a', name: 'y' }, { publisher: 'b', name: 'x' }] });
    expect(p.allowedTiers).toEqual(['official', 'verified']);
    expect(p.blockedListings).toEqual([{ publisher: 'a', name: 'y' }, { publisher: 'b', name: 'x' }]);
  });

  it('merges a team policy under its root as the stricter of each field', () => {
    const root = policy({ allowedTiers: ['official', 'verified', 'community'], blockOnAdvisory: 'critical', blockedListings: [{ publisher: 'a', name: 'x' }] });
    const team = policy({ allowedTiers: ['official', 'community'], requireApprovalTiers: ['verified'], secretsAllowedTiers: ['official'], blockOnAdvisory: 'high', officialInstalls: 'explicit', blockedListings: [{ publisher: 'b', name: 'y' }] });
    expect(mergeConsumptionPolicies(root, team)).toEqual({
      allowedTiers: ['official', 'community'],
      requireApprovalTiers: ['verified', 'community', 'unverified'],
      secretsAllowedTiers: ['official'],
      blockOnAdvisory: 'high',
      officialInstalls: 'explicit',
      blockedListings: [{ publisher: 'a', name: 'x' }, { publisher: 'b', name: 'y' }],
    });
    // A team can never loosen the root's advisory block.
    expect(mergeConsumptionPolicies(policy({ blockOnAdvisory: 'high' }), policy({ blockOnAdvisory: 'never' })).blockOnAdvisory).toBe('high');
  });

  it('computes the effective policy for a root org and a team', () => {
    const rows = [
      { orgId: 'root', allowedTiers: ['official'] as never },
      { orgId: 'team', allowedTiers: ['official', 'verified'] as never, officialInstalls: 'explicit' as const },
    ];
    expect(effectiveConsumptionPolicy(rows, 'root').allowedTiers).toEqual(['official']);
    expect(effectiveConsumptionPolicy(rows, 'root', 'root').allowedTiers).toEqual(['official']);
    const team = effectiveConsumptionPolicy(rows, 'team', 'root');
    expect(team.allowedTiers).toEqual(['official']);
    expect(team.officialInstalls).toBe('explicit');
    // A team without its own row inherits the root's policy as is.
    expect(effectiveConsumptionPolicy(rows, 'other-team', 'root').allowedTiers).toEqual(['official']);
  });

  it('validates a policy update', () => {
    const base = policyOf(null);
    expect(applyPolicyUpdate(base, null)).toBe('body must be an object');
    expect(applyPolicyUpdate(base, [])).toBe('body must be an object');
    expect(applyPolicyUpdate(base, { allowedTiers: 'official' })).toMatch(/array of tiers/);
    expect(applyPolicyUpdate(base, { secretsAllowedTiers: ['gold'] })).toMatch(/unknown tiers: gold/);
    expect(applyPolicyUpdate(base, { blockOnAdvisory: 'medium' })).toMatch(/critical, high or never/);
    expect(applyPolicyUpdate(base, { officialInstalls: 'sometimes' })).toMatch(/implicit or explicit/);
    expect(applyPolicyUpdate(base, { blockedListings: 'acme/x' })).toMatch(/must be an array/);
    expect(applyPolicyUpdate(base, { blockedListings: Array.from({ length: 501 }, () => 'a/b') })).toMatch(/at most 500/);
    expect(applyPolicyUpdate(base, { blockedListings: ['acme'] })).toMatch(/publisher, name/);
    expect(applyPolicyUpdate(base, { blockedListings: ['a/b/c'] })).toMatch(/publisher, name/);
    expect(applyPolicyUpdate(base, { blockedListings: [{ publisher: 'Acme', name: 'x' }] })).toMatch(/publisher, name/);
    expect(applyPolicyUpdate(base, { blockedListings: [7] })).toMatch(/publisher, name/);
    const next = applyPolicyUpdate(base, {
      allowedTiers: ['community', 'official'],
      blockOnAdvisory: 'never',
      officialInstalls: 'explicit',
      blockedListings: ['acme/lint', { publisher: 'pipeline-builder', name: 'trivy' }],
    });
    expect(next).toEqual({
      ...base,
      allowedTiers: ['official', 'community'],
      blockOnAdvisory: 'never',
      officialInstalls: 'explicit',
      blockedListings: [{ publisher: 'acme', name: 'lint' }, { publisher: 'pipeline-builder', name: 'trivy' }],
    });
  });
});

describe('listingBlock', () => {
  it('refuses suspended publishers and suspended / transferred listings', () => {
    const suspended = listingBlock(policy(), publisher({ suspendedAt: T0 }), listing());
    expect(suspended?.reason).toBe('suspended');
    expect(blockRefusal(suspended!)).toMatchObject({ code: 'PLUGIN_UNAVAILABLE', reason: 'suspended' });
    expect(listingBlock(policy(), publisher(), listing({ state: 'transferred' }))?.message).toMatch(/transferred/);
    expect(listingBlock(policy(), publisher(), listing({ state: 'suspended' }))?.reason).toBe('suspended');
  });

  it('refuses blocked listings and disallowed tiers, including Official', () => {
    const blocked = listingBlock(policy({ blockedListings: [{ publisher: 'pipeline-builder', name: 'trivy' }] }), publisher(), listing());
    expect(blocked?.reason).toBe('blocked_listing');
    expect(blockRefusal(blocked!)).toMatchObject({ code: 'PLUGIN_BLOCKED_BY_POLICY', reason: 'blocked_listing' });
    expect(listingBlock(policy({ allowedTiers: ['verified'] }), publisher(), listing())?.reason).toBe('tier');
    expect(listingBlock(policy(), publisher({ tier: 'community' }), listing())?.reason).toBe('tier');
    expect(listingBlock(policy(), publisher(), listing())).toBeNull();
  });
});

describe('advisories', () => {
  it.each([
    ['<1.2.0', '1.1.9', true], ['<1.2.0', '1.2.0', false],
    ['>=1.0.0 <1.2.0', '1.0.0', true], ['>=1.0.0 <1.2.0', '0.9.0', false],
    ['>1.0.0 <=1.1.0', '1.1.0', true], ['>1.0.0 <=1.1.0', '1.0.0', false],
    ['=1.0.0', '1.0.0', true], ['v1.0.0', '1.0.0', true],
    ['1.0.0 - 1.1.0', '1.0.5', true], ['1.0.0 - 1.1.0', '1.2.0', false],
    ['^1.0.0', '1.9.0', true], ['~1.0.0', '1.1.0', false], ['1.x', '1.4.0', true],
    ['<1.0.0 || >=2.0.0 <2.1.0', '2.0.3', true], ['<1.0.0 || >=2.0.0 <2.1.0', '1.5.0', false],
    ['*', '9.9.9', true], ['', '1.0.0', false], ['garbage here', '1.0.0', false],
  ])('%s covers %s → %s', (range, v, expected) => {
    expect(advisoryRangeCovers(range, v)).toBe(expected);
  });

  it.each([
    ['<1.2.0', null], ['>=1.0.0 <1.2.3', null], ['^1.2 || 2.0.0', null], ['1.0.0 - 1.1.0', null], ['*', null], ['1.x', null],
  ])('accepts the range %s', (range, problem) => {
    expect(advisoryRangeProblem(range)).toBe(problem);
  });

  it.each([
    ['', /empty/], ['   ', /empty/], ['<1.0.0 ||', /empty "\|\|"/], ['garbage here', /"garbage" is not a version/],
    ['latest', /"latest"/], ['1.0 - x', /hyphen range/], ['x'.repeat(256), /255/],
  ])('refuses the range %j', (range, problem) => {
    expect(advisoryRangeProblem(range)).toMatch(problem);
  });

  it('never covers a malformed version', () => {
    expect(advisoryRangeCovers('*', 'not-a-version')).toBe(false);
  });

  it('blocks per the policy severity and only published advisories', () => {
    const advs = [advisory(), advisory({ id: 'adv-2', severity: 'high' }), advisory({ id: 'adv-3', state: 'draft' })];
    expect(blockingAdvisories(advs, '1.1.0', { blockOnAdvisory: 'critical' }).map((a) => a.id)).toEqual(['adv-1']);
    expect(blockingAdvisories(advs, '1.1.0', { blockOnAdvisory: 'high' }).map((a) => a.id)).toEqual(['adv-1', 'adv-2']);
    expect(blockingAdvisories(advs, '1.1.0', { blockOnAdvisory: 'never' })).toEqual([]);
    expect(blockingAdvisories(advs, '1.2.0', { blockOnAdvisory: 'high' })).toEqual([]);
  });

  it('lists every published advisory covering a version, most severe first', () => {
    const advs = [
      advisory({ id: 'low', severity: 'low' }), advisory({ id: 'crit' }), advisory({ id: 'draft', state: 'draft' }),
      advisory({ id: 'withdrawn', state: 'withdrawn' }), advisory({ id: 'other-range', affectedRange: '>=2.0.0' }),
    ];
    expect(advisoriesCovering(advs, '1.1.0').map((a) => a.id)).toEqual(['crit', 'low']);
    expect(advisoriesCovering(advs, '2.0.0').map((a) => a.id)).toEqual(['other-range']);
  });

  it('warns on a covering advisory the policy does not block, and on deprecation', () => {
    const { warnings, secretsWithheld } = listedVersionWarnings({
      publisher: publisher(),
      listing: listing(),
      version: version('1.1.0', { deprecatedAt: T0, deprecationMessage: 'use 1.2' }),
      advisories: [advisory({ severity: 'high', summary: 'Token leak' })],
      policy: policy(),
    });
    expect(secretsWithheld).toBe(false);
    expect(warnings.map((w) => w.code)).toEqual(['PLUGIN_DEPRECATED', 'PLUGIN_ADVISORY']);
    expect(warnings[1]!.message).toBe('pipeline-builder/trivy@1.1.0 is affected by a high security advisory: Token leak Fixed in 1.2.0.');
  });
});

describe('install ranges', () => {
  const vs = ['1.0.0', '1.0.1', '1.1.0', '2.0.0', '2.1.0'].map((v) => version(v, { breaking: v === '2.0.0' }));

  it('pinned, patch, minor', () => {
    expect(installAdmits({ versionPolicy: 'pinned', pinnedVersion: '1.0.0' }, '1.0.0', vs)).toBe(true);
    expect(installAdmits({ versionPolicy: 'pinned', pinnedVersion: '1.0.0' }, '1.0.1', vs)).toBe(false);
    expect(installAdmits({ versionPolicy: 'patch', pinnedVersion: '1.0.0' }, '1.0.1', vs)).toBe(true);
    expect(installAdmits({ versionPolicy: 'patch', pinnedVersion: '1.0.0' }, '1.1.0', vs)).toBe(false);
    expect(installAdmits({ versionPolicy: 'minor', pinnedVersion: '1.0.0' }, '1.1.0', vs)).toBe(true);
    expect(installAdmits({ versionPolicy: 'minor', pinnedVersion: '1.0.0' }, '2.0.0', vs)).toBe(false);
    expect(installAdmits({ versionPolicy: 'minor', pinnedVersion: null }, '1.0.0', vs)).toBe(false);
    expect(installAdmits({ versionPolicy: 'patch', pinnedVersion: null }, '1.0.0', vs)).toBe(false);
    expect(installAdmits({ versionPolicy: 'bogus' as never, pinnedVersion: '1.0.0' }, '1.0.0', vs)).toBe(false);
  });

  it('latest never crosses a breaking version and never goes backwards', () => {
    expect(installAdmits({ versionPolicy: 'latest', pinnedVersion: '1.0.0' }, '1.1.0', vs)).toBe(true);
    expect(installAdmits({ versionPolicy: 'latest', pinnedVersion: '1.0.0' }, '2.0.0', vs)).toBe(false);
    expect(installAdmits({ versionPolicy: 'latest', pinnedVersion: '2.0.0' }, '2.1.0', vs)).toBe(true);
    expect(installAdmits({ versionPolicy: 'latest', pinnedVersion: '1.1.0' }, '1.0.0', vs)).toBe(false);
    expect(installAdmits({ versionPolicy: 'latest', pinnedVersion: null }, '2.1.0', vs)).toBe(true);
    expect(installAdmits({ versionPolicy: 'latest', pinnedVersion: null }, '2.2.0-rc.1', vs)).toBe(false);
  });

  it('implicit installs stay on the lowest live major', () => {
    expect(implicitInstallRange(vs)).toBe('1.x');
    expect(implicitInstallRange(vs.map((v) => (v.version.startsWith('1.') ? { ...v, yankedAt: T0 } : v)))).toBe('2.x');
    expect(implicitInstallRange([version('1.0.0-rc.1')])).toBeNull();
    expect(modeAdmits({ kind: 'implicit' }, '1.1.0', vs)).toBe(true);
    expect(modeAdmits({ kind: 'implicit' }, '2.0.0', vs)).toBe(false);
    expect(modeAdmits({ kind: 'implicit' }, '1.0.0', [])).toBe(false);
    expect(modeAdmits({ kind: 'explicit', install: install({ versionPolicy: 'pinned', pinnedVersion: '2.1.0' }), inherited: false }, '2.1.0', vs)).toBe(true);
  });
});

describe('selectListingVersion', () => {
  const vs = [
    version('1.0.0'), version('1.1.0'), version('1.2.0', { pausedAt: T0 }), version('1.3.0', { yankedAt: T0, yankReason: 'bad build' }),
    version('2.0.0', { breaking: true }),
  ];
  const implicit = { kind: 'implicit' } as const;
  const base = { ref: 'pipeline-builder/trivy', versions: vs, advisories: [], policy: policy() };
  const pick = (r: ReturnType<typeof selectListingVersion>) => ('version' in r ? r.version.version : r.refusal);

  it('implicit: highest live, unpaused version of the lowest major', () => {
    expect(pick(selectListingVersion({ ...base, mode: implicit }))).toBe('1.1.0');
  });

  it('an explicit range on the reference replaces the implicit range', () => {
    expect(pick(selectListingVersion({ ...base, mode: implicit, requested: '^2.0.0' }))).toBe('2.0.0');
  });

  it('keeps a paused version the install already resolved to', () => {
    const mode = { kind: 'explicit', install: install({ resolvedVersion: '1.2.0' }), inherited: false } as const;
    expect(pick(selectListingVersion({ ...base, mode }))).toBe('1.2.0');
  });

  it('an exact pin resolves a paused version but refuses a yanked one', () => {
    expect(pick(selectListingVersion({ ...base, mode: implicit, requested: '1.2.0' }))).toBe('1.2.0');
    expect(pick(selectListingVersion({ ...base, mode: implicit, requested: '1.3.0' }))).toMatchObject({ code: 'PLUGIN_UNAVAILABLE', reason: 'yanked', message: expect.stringMatching(/bad build/) });
    expect(pick(selectListingVersion({ ...base, mode: implicit, requested: '9.9.9' }))).toMatchObject({ code: 'NOT_FOUND', reason: 'version_not_found' });
  });

  it('an exact pin outside an explicit install is refused', () => {
    const mode = { kind: 'explicit', install: install({ versionPolicy: 'patch', pinnedVersion: '1.0.0' }), inherited: false } as const;
    expect(pick(selectListingVersion({ ...base, mode, requested: '2.0.0' }))).toMatchObject({ code: 'PLUGIN_NOT_INSTALLED', reason: 'version_outside_install' });
    expect(pick(selectListingVersion({ ...base, mode, requested: '^2.0.0' }))).toMatchObject({ code: 'PLUGIN_NOT_INSTALLED', reason: 'version_outside_install' });
    expect(pick(selectListingVersion({ ...base, mode, requested: '^3.0.0' }))).toMatchObject({ code: 'NOT_FOUND', reason: 'no_matching_version' });
  });

  it('skips advisory-blocked versions, and refuses when every candidate is blocked', () => {
    const advisories = [advisory({ affectedRange: '1.1.0' })];
    expect(pick(selectListingVersion({ ...base, mode: implicit, advisories }))).toBe('1.0.0');
    const all = [advisory({ affectedRange: '1.x', fixedVersion: null })];
    expect(pick(selectListingVersion({ ...base, mode: implicit, advisories: all }))).toMatchObject({
      code: 'PLUGIN_BLOCKED_BY_POLICY', reason: 'advisory', details: { version: '1.1.0', advisories: ['adv-1'] },
    });
    const pinned = pick(selectListingVersion({ ...base, mode: implicit, requested: '1.1.0', advisories }));
    expect(pinned).toMatchObject({ reason: 'advisory', details: { fixedVersions: ['1.2.0'] }, message: expect.stringMatching(/Fixed in 1.2.0/) });
    // `never` turns the block off.
    expect(pick(selectListingVersion({ ...base, mode: implicit, advisories: all, policy: policy({ blockOnAdvisory: 'never' }) }))).toBe('1.1.0');
  });

  describe('rescan-flagged versions', () => {
    const flag = { critical: 2, high: 1, maxCritical: 0, findings: [{ id: 'CVE-2026-1', severity: 'critical' as const, packageName: 'openssl', packageVersion: '3.0.1', fixedIn: ['3.0.2'] }] };
    const flagged = [version('1.0.0'), version('1.1.0', { scanFlaggedAt: T0, scanFlag: flag })];
    const b = { ...base, versions: flagged, mode: implicit };

    it('resolve normally (with a warning elsewhere) when block mode is off', () => {
      expect(pick(selectListingVersion({ ...b, blockFlagged: false }))).toBe('1.1.0');
      expect(pick(selectListingVersion({ ...b, blockFlagged: false, requested: '1.1.0' }))).toBe('1.1.0');
    });

    it('block mode: a range / the default falls back to the newest unflagged satisfying version', () => {
      expect(pick(selectListingVersion({ ...b, blockFlagged: true }))).toBe('1.0.0');
      expect(pick(selectListingVersion({ ...b, blockFlagged: true, requested: '^1.0.0' }))).toBe('1.0.0');
    });

    it('block mode: an exact pin to a flagged version is refused 409 PLUGIN_VERSION_VULN_BLOCKED naming the fix', () => {
      expect(pick(selectListingVersion({ ...b, blockFlagged: true, requested: '1.1.0' }))).toMatchObject({
        code: 'PLUGIN_VERSION_VULN_BLOCKED',
        reason: 'vuln_flagged',
        message: expect.stringMatching(/CVE-2026-1 \(openssl@3\.0\.1 → 3\.0\.2\)/),
        details: { version: '1.1.0', critical: 2, fixedVersions: ['3.0.2'] },
      });
    });

    it('block mode: when every candidate is flagged the refusal is the vuln block', () => {
      expect(pick(selectListingVersion({ ...b, blockFlagged: true, requested: '~1.1.0' }))).toMatchObject({ code: 'PLUGIN_VERSION_VULN_BLOCKED' });
    });

    it('reads PLUGIN_BLOCK_ON_NEW_CRITICAL by default', () => {
      process.env.PLUGIN_BLOCK_ON_NEW_CRITICAL = 'true';
      try {
        expect(pick(selectListingVersion(b))).toBe('1.0.0');
      } finally {
        delete process.env.PLUGIN_BLOCK_ON_NEW_CRITICAL;
      }
      expect(pick(selectListingVersion(b))).toBe('1.1.0');
    });

    it('a flagged resolved version carries a VULN_FLAGGED warning', () => {
      const { warnings } = listedVersionWarnings({
        publisher: publisher(), listing: listing(), version: flagged[1]!, advisories: [], policy: policy(),
      });
      expect(warnings).toEqual([expect.objectContaining({
        code: 'VULN_FLAGGED',
        plugin: 'pipeline-builder/trivy',
        version: '1.1.0',
        critical: 2,
        high: 1,
        message: 'pipeline-builder/trivy@1.1.0 has 2 fixable Critical findings — rebuild or upgrade',
      })]);
    });
  });

  it('refuses when nothing is live', () => {
    expect(pick(selectListingVersion({ ...base, versions: [], mode: implicit }))).toMatchObject({ code: 'NOT_FOUND', message: expect.not.stringMatching(/matches/) });
    expect(pick(selectListingVersion({ ...base, versions: [], mode: implicit, requested: '^1.0.0' }))).toMatchObject({ message: expect.stringMatching(/matches \^1.0.0/) });
  });
});

describe('installModeFor', () => {
  const scope = { orgId: 'org-a' };
  const team = { orgId: 'team-a', rootOrgId: 'org-a' };

  it('an active own install wins, then the root org\'s for a team', () => {
    expect(installModeFor(publisher(), listing(), [install()], policy(), scope)).toMatchObject({ kind: 'explicit', inherited: false });
    expect(installModeFor(publisher(), listing(), [install()], policy(), team)).toMatchObject({ kind: 'explicit', inherited: true });
    const own = install({ id: 'i-team', orgId: 'team-a', pinnedVersion: '1.1.0' });
    expect(installModeFor(publisher(), listing(), [install(), own], policy(), team)).toMatchObject({ kind: 'explicit', install: { id: 'i-team' } });
  });

  it('Official listings resolve implicitly unless the policy is explicit', () => {
    expect(installModeFor(publisher(), listing(), [], policy(), scope)).toEqual({ kind: 'implicit' });
    expect(installModeFor(publisher(), listing(), [], policy({ officialInstalls: 'explicit' }), scope)).toMatchObject({ code: 'PLUGIN_NOT_INSTALLED', reason: 'official_explicit' });
    // A pending explicit request doesn't take the implicit install away.
    expect(installModeFor(publisher(), listing(), [install({ status: 'pending_approval' })], policy(), scope)).toEqual({ kind: 'implicit' });
    expect(installModeFor(publisher(), listing(), [install({ status: 'pending_approval' })], policy({ officialInstalls: 'explicit' }), scope))
      .toMatchObject({ reason: 'pending_approval' });
  });

  it('other publishers need an explicit active install', () => {
    const acme = publisher({ id: 'pub-acme', handle: 'acme', tier: 'verified' });
    expect(installModeFor(acme, listing(), [], policy(), scope)).toMatchObject({ reason: 'not_installed' });
    expect(installModeFor(acme, listing(), [install({ status: 'pending_approval' })], policy(), scope)).toMatchObject({ reason: 'pending_approval' });
    expect(installModeFor(acme, listing(), [install({ status: 'denied' })], policy(), scope)).toMatchObject({ reason: 'denied' });
    // Another listing's install doesn't count.
    expect(installModeFor(acme, listing(), [install({ listingId: 'l-other' })], policy(), scope)).toMatchObject({ reason: 'not_installed' });
  });

  it('scopeOrgIds lowercases and de-duplicates', () => {
    expect(scopeOrgIds({ orgId: 'ORG-A' })).toEqual(['org-a']);
    expect(scopeOrgIds({ orgId: 'team', rootOrgId: 'Root' })).toEqual(['team', 'root']);
    expect(scopeOrgIds({ orgId: 'org', rootOrgId: 'ORG' })).toEqual(['org']);
  });
});

/** An in-memory {@link ListingDataSource}. */
function memorySource(data: {
  publishers?: Publisher[];
  listings?: PluginListing[];
  versions?: PluginListingVersion[];
  advisories?: PluginAdvisory[];
  installs?: PluginInstall[];
  policies?: PluginInstallPolicy[];
}): ListingDataSource {
  const d = { publishers: [], listings: [], versions: [], advisories: [], installs: [], policies: [], ...data };
  return {
    publisherByHandle: async (h) => d.publishers.find((p) => p.handle === h) ?? null,
    publishersByIds: async (ids) => d.publishers.filter((p) => ids.includes(p.id)),
    listingByName: async (pid, name) => d.listings.find((l) => l.publisherId === pid && l.name === name) ?? null,
    liveListings: async (f = {}) => d.listings.filter((l) => ['listed', 'unmaintained'].includes(l.state)
      && (!f.ids || f.ids.includes(l.id)) && (!f.names || f.names.includes(l.name))),
    versionsForListings: async (ids) => d.versions.filter((v) => ids.includes(v.listingId)),
    advisoriesForListings: async (ids) => d.advisories.filter((a) => ids.includes(a.listingId) && a.state === 'published'),
    installsForOrgs: async (orgIds) => d.installs.filter((i) => orgIds.includes(i.orgId)),
    policiesForOrgs: async (orgIds) => d.policies.filter((p) => orgIds.includes(p.orgId)),
  };
}

function policyRow(over: Partial<PluginInstallPolicy>): PluginInstallPolicy {
  return { ...policyOf(null), orgId: 'org-a', updatedBy: null, updatedAt: T0, ...over } as PluginInstallPolicy;
}

describe('resolveListingReference', () => {
  const acme = publisher({ id: 'pub-acme', handle: 'acme', tier: 'community', ownerOrgId: 'org-acme' });
  const lint = listing({ id: 'l-lint', publisherId: 'pub-acme', name: 'lint', state: 'unmaintained' });
  const source = memorySource({
    publishers: [publisher(), acme],
    listings: [listing(), lint],
    versions: [
      version('1.0.0'), version('1.1.0', { deprecatedAt: T0, deprecationMessage: 'use 1.2' }),
      version('1.0.0', { id: 'lint-1', listingId: 'l-lint', imageRepository: 'public/acme/lint', specSnapshot: { secrets: [{ name: 'TOKEN', required: true }] } }),
    ],
    installs: [install({ listingId: 'l-lint', orgId: 'org-a' })],
    policies: [policyRow({ allowedTiers: ['official', 'verified', 'community'] })],
  });

  it('returns null when the publisher or listing does not exist', async () => {
    expect(await resolveListingReference(source, { publisher: 'nobody', name: 'x' }, { orgId: 'org-a' })).toBeNull();
    expect(await resolveListingReference(source, { name: 'nothing' }, { orgId: 'org-a' })).toBeNull();
  });

  it('resolves an unqualified name to the Official listing through the implicit install', async () => {
    const res = await resolveListingReference(source, { name: 'trivy' }, { orgId: 'org-a' });
    expect(res).toMatchObject({ ok: true, mode: { kind: 'implicit' }, version: { version: '1.1.0' }, secretsWithheld: false });
    expect(res && res.ok && res.warnings.map((w) => w.code)).toEqual(['PLUGIN_DEPRECATED']);
  });

  it('resolves a qualified reference through the explicit install, withholding secrets from a lower tier', async () => {
    const res = await resolveListingReference(source, { publisher: 'acme', name: 'lint' }, { orgId: 'org-a' });
    expect(res).toMatchObject({ ok: true, mode: { kind: 'explicit' }, version: { id: 'lint-1' }, secretsWithheld: true });
    expect(res && res.ok && res.warnings.map((w) => w.code)).toEqual(['LISTING_UNMAINTAINED', 'PLUGIN_SECRETS_WITHHELD']);
    const record = listedPluginRecord(res as never);
    expect(record).toMatchObject({ id: 'lint-1', publisher: 'acme', publisherTier: 'community', imageRepository: 'public/acme/lint', secrets: [], install: 'explicit', source: 'listing' });
  });

  it('refuses a tier the policy disallows, and an org without an install', async () => {
    expect(await resolveListingReference(source, { publisher: 'acme', name: 'lint' }, { orgId: 'org-b' }))
      .toMatchObject({ ok: false, refusal: { code: 'PLUGIN_BLOCKED_BY_POLICY', reason: 'tier' } });
    const open = memorySource({ publishers: [acme], listings: [lint], policies: [policyRow({ orgId: 'org-b', allowedTiers: ['community'] })] });
    expect(await resolveListingReference(open, { publisher: 'acme', name: 'lint' }, { orgId: 'org-b' }))
      .toMatchObject({ ok: false, refusal: { reason: 'not_installed' } });
  });

  it('warns at lookup on a published advisory the org does not block, and refuses on one it does', async () => {
    const advised = memorySource({
      publishers: [publisher()],
      listings: [listing()],
      versions: [version('1.0.0'), version('1.1.0')],
      advisories: [advisory({ severity: 'high', affectedRange: '1.1.0', fixedVersion: null })],
      policies: [policyRow({ blockOnAdvisory: 'critical' }), policyRow({ orgId: 'org-strict', blockOnAdvisory: 'high' })],
    });
    const warned = await resolveListingReference(advised, { name: 'trivy', version: '1.1.0' }, { orgId: 'org-a' });
    expect(warned).toMatchObject({ ok: true, version: { version: '1.1.0' } });
    expect(warned && warned.ok && warned.warnings).toEqual([
      { code: 'PLUGIN_ADVISORY', message: 'pipeline-builder/trivy@1.1.0 is affected by a high security advisory: RCE' },
    ]);
    expect(await resolveListingReference(advised, { name: 'trivy', version: '1.1.0' }, { orgId: 'org-strict' }))
      .toMatchObject({ ok: false, refusal: { code: 'PLUGIN_BLOCKED_BY_POLICY', reason: 'advisory' } });
    // An unversioned reference under the blocking policy skips the advised version.
    expect(await resolveListingReference(advised, { name: 'trivy' }, { orgId: 'org-strict' }))
      .toMatchObject({ ok: true, version: { version: '1.0.0' }, warnings: [] });
  });

  it('refuses when no version resolves', async () => {
    expect(await resolveListingReference(source, { name: 'trivy', version: '7.0.0' }, { orgId: 'org-a' }))
      .toMatchObject({ ok: false, refusal: { code: 'NOT_FOUND' } });
  });

  it('builds the run record from the frozen spec with fallbacks from the listing', async () => {
    const res = await resolveListingReference(source, { name: 'trivy', version: '1.0.0' }, { orgId: 'org-a' });
    const record = listedPluginRecord(res as never);
    expect(record).toMatchObject({
      name: 'trivy',
      version: '1.0.0',
      commands: ['trivy'],
      buildType: 'build_image',
      pluginType: 'CodeBuildStep',
      computeType: 'SMALL',
      category: 'security',
      description: 'Scans images',
      license: 'MIT',
      lifecycle: 'production',
      env: {},
      keywords: [],
      install: 'implicit',
    });
    const metadataOnly = listedPluginRecord({ ...(res as object), version: version('1.0.0', { imageDigest: null, specSnapshot: { buildType: 'metadata_only', keywords: 'x', env: [] } }) } as never);
    expect(metadataOnly).toMatchObject({ buildType: 'metadata_only', keywords: [], env: {} });
    const deprecated = listedPluginRecord({ ...(res as object), version: version('1.0.0', { specSnapshot: undefined as never, deprecatedAt: T0 }) } as never);
    expect(deprecated).toMatchObject({ lifecycle: 'deprecated', commands: [] });
  });
});

describe('orgListingStates / resolvableListings', () => {
  const acme = publisher({ id: 'pub-acme', handle: 'acme', tier: 'verified', ownerOrgId: 'org-acme' });
  const source = memorySource({
    publishers: [publisher(), acme],
    listings: [
      listing(),
      listing({ id: 'l-lint', publisherId: 'pub-acme', name: 'lint' }),
      listing({ id: 'l-gone', publisherId: 'pub-nobody', name: 'orphan' }),
      listing({ id: 'l-susp', publisherId: 'pub-acme', name: 'old', state: 'suspended' }),
    ],
    versions: [version('1.0.0'), version('1.0.0', { id: 'lint-1', listingId: 'l-lint' })],
    installs: [install({ listingId: 'l-lint', orgId: 'org-a', status: 'pending_approval' })],
  });

  it('reports every live listing with the org\'s standing', async () => {
    const states = await orgListingStates(source, { orgId: 'org-a' });
    expect(states.map((s) => s.listing.name)).toEqual(['trivy', 'lint']);
    expect(states[0]).toMatchObject({ mode: { kind: 'implicit' }, block: null, resolved: { version: '1.0.0' }, refusal: null, ownInstall: null });
    expect(states[1]).toMatchObject({ mode: { reason: 'pending_approval' }, resolved: null, ownInstall: { status: 'pending_approval' } });
    expect(await orgListingStates(source, { orgId: 'org-a' }, { ids: [] })).toEqual([]);
  });

  it('resolvableListings keeps only what resolves', async () => {
    expect((await resolvableListings(source, { orgId: 'org-a' })).map((s) => s.listing.name)).toEqual(['trivy']);
    expect((await resolvableListings(source, { orgId: 'org-a' }, { names: ['lint'] }))).toEqual([]);
  });

  it('records why nothing resolves for a listing the org does reach', async () => {
    const src = memorySource({
      publishers: [publisher()],
      listings: [listing()],
      versions: [version('1.0.0')],
      advisories: [advisory({ affectedRange: '*' })],
    });
    const [state] = await orgListingStates(src, { orgId: 'org-a' });
    expect(state).toMatchObject({ resolved: null, refusal: { reason: 'advisory' }, advisories: [{ id: 'adv-1' }] });
  });

  it('a blocked listing never resolves', async () => {
    const blocked = memorySource({
      publishers: [publisher()],
      listings: [listing()],
      versions: [version('1.0.0')],
      policies: [policyRow({ blockedListings: [{ publisher: 'pipeline-builder', name: 'trivy' }] })],
    });
    const [state] = await orgListingStates(blocked, { orgId: 'org-a' });
    expect(state).toMatchObject({ block: { reason: 'blocked_listing' }, resolved: null });
  });
});

describe('drizzleListingSource', () => {
  const dialect = new PgDialect();
  function stubTx(rows: unknown[] = []) {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const tx = {
      select: () => ({
        from: (table: unknown) => ({
          where: async (cond: SQL) => {
            const q = dialect.sqlToQuery(cond);
            queries.push({ sql: `${(table as { [k: symbol]: string })[Symbol.for('drizzle:Name')]} WHERE ${q.sql}`, params: q.params });
            return rows;
          },
        }),
      }),
    };
    return { tx, queries };
  }

  it('reads each table with bound parameters', async () => {
    const { tx, queries } = stubTx([{ id: 'x' }]);
    const src = drizzleListingSource(tx as unknown as CrudTx);
    expect(await src.publisherByHandle('acme')).toEqual({ id: 'x' });
    expect(await src.listingByName('p', 'lint')).toEqual({ id: 'x' });
    await src.publishersByIds(['p']);
    await src.liveListings();
    await src.liveListings({ ids: ['l'], names: ['lint'] });
    await src.versionsForListings(['l']);
    await src.advisoriesForListings(['l']);
    await src.installsForOrgs(['org-a']);
    await src.policiesForOrgs(['org-a']);
    expect(queries.map((q) => q.sql.split(' ')[0])).toEqual([
      'publishers', 'plugin_listings', 'publishers', 'plugin_listings', 'plugin_listings',
      'plugin_listing_versions', 'plugin_advisories', 'plugin_installs', 'plugin_install_policies',
    ]);
    expect(queries[0]!.params).toEqual(['acme']);
    expect(queries[4]!.params).toEqual(expect.arrayContaining(['listed', 'unmaintained', 'l', 'lint']));
    expect(queries[6]!.params).toEqual(['l', 'published']);
  });

  it('short-circuits empty id lists and returns null for missing rows', async () => {
    const { tx, queries } = stubTx([]);
    const src = drizzleListingSource(tx as unknown as CrudTx);
    expect(await src.publisherByHandle('x')).toBeNull();
    expect(await src.listingByName('p', 'x')).toBeNull();
    queries.length = 0;
    expect(await src.publishersByIds([])).toEqual([]);
    expect(await src.liveListings({ ids: [] })).toEqual([]);
    expect(await src.liveListings({ names: [] })).toEqual([]);
    expect(await src.versionsForListings([])).toEqual([]);
    expect(await src.advisoriesForListings([])).toEqual([]);
    expect(await src.installsForOrgs([])).toEqual([]);
    expect(await src.policiesForOrgs([])).toEqual([]);
    expect(queries).toEqual([]);
  });
});
