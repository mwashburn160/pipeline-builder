// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The pure rules of the publish-request queue (plugin ecosystem §3.0–§3.4):
 * version bumps, contract deltas, submit gates, who decides, two-person
 * approval, and auto-approval rule evaluation / widening.
 */

import { describe, it, expect, afterEach } from '@jest/globals';

import { pluginRow } from './helpers/ecosystem-harness.js';
import {
  contractDiff, decisionNeedsStepUp, evaluateAutoRule, isLinkField, isTextOnly, latestVersion, needsTwoPerson,
  requiredDecisionPermission, sameValue, specSnapshot, versionBump, versionGates, vulnDelta, vulnGateMaxCritical, widensRule,
  type AutoApprovalContext,
} from '../src/services/ecosystem/policy.js';

describe('versionBump / latestVersion', () => {
  it.each([
    [null, '1.0.0', 'major'],
    ['1.0.0', '1.0.1', 'patch'],
    ['1.0.0', '1.1.0', 'minor'],
    ['1.2.0', '2.0.0', 'major'],
    ['1.0.0', '1.0.0', 'same'],
    ['1.2.0', '1.1.9', 'downgrade'],
    ['1.0.0', '1.1.0-rc.1', 'prerelease'],
    ['1.0.0', 'not-semver', 'invalid'],
    ['garbage', '1.0.0', 'invalid'],
  ])('%s -> %s is %s', (prev, next, bump) => {
    expect(versionBump(prev as string | null, next)).toBe(bump);
  });

  it('picks the highest stable version, falling back to prereleases', () => {
    expect(latestVersion(['1.0.0', '1.2.0', '2.0.0-rc.1'])).toBe('1.2.0');
    expect(latestVersion(['2.0.0-rc.1', '2.0.0-rc.2'])).toBe('2.0.0-rc.2');
    expect(latestVersion([])).toBeNull();
  });
});

describe('contractDiff / vulnDelta', () => {
  it('reports added/removed secrets, egress, required inputs, env keys, commands and a root regression', () => {
    const prev = specSnapshot(pluginRow({ secrets: [{ name: 'A', required: true }], networkEgress: ['a.com'], env: { X: '1', Y: '1' }, runAsRoot: false }));
    const cur = specSnapshot(pluginRow({
      secrets: [{ name: 'B', required: true }],
      networkEgress: ['a.com', 'b.com'],
      requiredMetadata: ['m'],
      requiredVars: ['v'],
      env: { X: '2', Z: '1' },
      commands: ['lint --all'],
      installCommands: ['apk add x'],
      runAsRoot: true,
    }));
    const d = contractDiff(prev, cur);
    expect(d.secrets).toEqual({ added: ['B'], removed: ['A'] });
    expect(d.egress).toEqual({ added: ['b.com'], removed: [] });
    expect(d.requiredMetadata.added).toEqual(['m']);
    expect(d.requiredVars.added).toEqual(['v']);
    expect(d.env).toEqual({ added: ['Z'], removed: ['Y'], changed: ['X'] });
    expect(d.commands.changed).toBe(true);
    expect(d.installCommands.changed).toBe(true);
    expect(d.runAsRoot).toEqual({ previous: false, current: true, regression: true });
    expect(d.pluginType).toEqual({ previous: 'CodeBuildStep', current: 'CodeBuildStep' });
  });

  it('treats a first listing as everything added, with no regression for a non-root image', () => {
    const d = contractDiff(null, specSnapshot(pluginRow({ runAsRoot: null, networkEgress: ['x.io'] })));
    expect(d.egress.added).toEqual(['x.io']);
    expect(d.runAsRoot.regression).toBe(false);
    expect(d.computeType.previous).toBeNull();
  });

  it('counts only NEW criticals/highs', () => {
    expect(vulnDelta({ critical: 1, high: 3 }, { critical: 1, high: 5 })).toEqual({ newCritical: 0, newHigh: 2 });
    expect(vulnDelta(null, { critical: 2, high: null })).toEqual({ newCritical: 2, newHigh: 0 });
  });
});

describe('versionGates', () => {
  afterEach(() => { delete process.env.ECOSYSTEM_VULN_GATE_MAX_CRITICAL; });

  it('passes a public, licensed, documented, signed, scanned, clean version', () => {
    expect(versionGates(pluginRow() as any).every((g) => g.ok)).toBe(true);
  });

  it('fails each missing piece with its own gate', () => {
    const gates = versionGates(pluginRow({ visibility: 'org', license: null, readmeHtml: null, imageDigest: null, scannedAt: null }) as any);
    const failing = gates.filter((g) => !g.ok).map((g) => g.id);
    expect(failing).toEqual(['visibility', 'license', 'readme', 'signed', 'scanned', 'vuln']);
  });

  it('refuses criticals above the configured gate, and skips image gates for image-less plugins', () => {
    expect(versionGates(pluginRow({ vulnCritical: 2 }) as any).find((g) => g.id === 'vuln')!.ok).toBe(false);
    process.env.ECOSYSTEM_VULN_GATE_MAX_CRITICAL = '5';
    expect(vulnGateMaxCritical()).toBe(5);
    expect(versionGates(pluginRow({ vulnCritical: 2 }) as any).find((g) => g.id === 'vuln')!.ok).toBe(true);
    process.env.ECOSYSTEM_VULN_GATE_MAX_CRITICAL = 'nope';
    expect(vulnGateMaxCritical()).toBe(0);
    expect(versionGates(pluginRow({ buildType: 'metadata_only', imageDigest: null }) as any).map((g) => g.id)).toEqual(['visibility', 'license', 'readme']);
  });
});

describe('decision rules', () => {
  it('routes publisher-level kinds to publishers:verify and the rest to plugins:moderate', () => {
    expect(requiredDecisionPermission('verify')).toBe('publishers:verify');
    expect(requiredDecisionPermission('transfer')).toBe('publishers:verify');
    expect(requiredDecisionPermission('new_version')).toBe('plugins:moderate');
  });

  it('asks for step-up on the sensitive kinds only', () => {
    expect(decisionNeedsStepUp('yank')).toBe(true);
    expect(decisionNeedsStepUp('moderation')).toBe(true);
    expect(decisionNeedsStepUp('new_version')).toBe(false);
  });

  it('requires two people for every Official request, Verified applications and moderation actions', () => {
    expect(needsTwoPerson('new_version', 'official')).toBe(true);
    expect(needsTwoPerson('listing_update', 'official')).toBe(true);
    expect(needsTwoPerson('verify', 'community')).toBe(true);
    expect(needsTwoPerson('moderation', 'verified')).toBe(true);
    expect(needsTwoPerson('new_listing', 'community')).toBe(false);
  });

  it('classifies text-only updates and links', () => {
    expect(isTextOnly(['summary', 'keywords'])).toBe(true);
    expect(isTextOnly(['summary', 'homepageUrl'])).toBe(false);
    expect(isTextOnly(['icon'])).toBe(false);
    expect(isLinkField('sourceUrl')).toBe(true);
    expect(isLinkField('summary')).toBe(false);
  });

  it('compares catalog values order-insensitively and treats empty as null', () => {
    expect(sameValue(['b', 'a'], ['a', 'b'])).toBe(true);
    expect(sameValue('', null)).toBe(true);
    expect(sameValue(undefined, null)).toBe(true);
    expect(sameValue('x', 'y')).toBe(false);
  });
});

describe('evaluateAutoRule (§3.0.3)', () => {
  const official = {
    requestKinds: ['new_version', 'listing_update'],
    publisherTiers: ['official' as const],
    bumps: ['patch' as const, 'minor' as const],
    submitterServiceAccount: 'official-catalog-loader',
    textOnlyListingUpdates: true,
    maxPerListingPerDay: 1,
    maxPerDay: 50,
    instanceFlag: 'OFFICIAL_AUTO_APPROVAL_ENABLED',
  };
  const clean = contractDiff(specSnapshot(pluginRow() as any), specSnapshot(pluginRow() as any));
  const ctx = (over: Partial<AutoApprovalContext> = {}): AutoApprovalContext => ({
    kind: 'new_version',
    publisherTier: 'official',
    submitterServiceAccount: 'official-catalog-loader',
    bump: 'minor',
    breaking: false,
    diff: clean,
    vuln: { newCritical: 0, newHigh: 0 },
    signed: true,
    scanned: true,
    listingLive: true,
    approvedToday: 0,
    approvedTodayForListing: 0,
    flagOn: true,
    ...over,
  });

  it('approves a gate-green minor update of an existing Official listing from the loader', () => {
    expect(evaluateAutoRule(official, ctx())).toEqual({ eligible: true, reasons: [] });
  });

  it.each([
    ['the flag is off', { flagOn: false }],
    ['a person submitted it', { submitterServiceAccount: null }],
    ['it is a major', { bump: 'major' as const }],
    ['it is breaking', { breaking: true }],
    ['the listing is new', { listingLive: false }],
    ['it is unsigned', { signed: false }],
    ['it is unscanned', { scanned: false }],
    ['a new critical', { vuln: { newCritical: 1, newHigh: 0 } }],
    ['a new high', { vuln: { newCritical: 0, newHigh: 1 } }],
    ['the listing cap is hit', { approvedTodayForListing: 1 }],
    ['the daily cap is hit', { approvedToday: 50 }],
    ['a tenant publisher', { publisherTier: 'community' as const }],
    ['a new_listing', { kind: 'new_listing' }],
  ])('declines when %s', (_why, over) => {
    const verdict = evaluateAutoRule(official, ctx(over));
    expect(verdict.eligible).toBe(false);
    expect(verdict.reasons.length).toBeGreaterThan(0);
  });

  it('declines contract regressions: new secrets, egress, required inputs, root', () => {
    const risky = contractDiff(specSnapshot(pluginRow() as any), specSnapshot(pluginRow({
      secrets: [{ name: 'TOKEN', required: true }], networkEgress: ['evil.io'], requiredMetadata: ['m'], requiredVars: ['v'], runAsRoot: true,
    }) as any));
    const verdict = evaluateAutoRule(official, ctx({ diff: risky }));
    expect(verdict.reasons).toEqual(expect.arrayContaining([
      'new secrets: TOKEN', 'new egress hosts: evil.io', 'new required metadata: m', 'new required vars: v', 'the image now runs as root',
    ]));
  });

  it('lets a security-lane fix past the caps', () => {
    expect(evaluateAutoRule(official, ctx({ approvedToday: 99, approvedTodayForListing: 9, securityLane: true })).eligible).toBe(true);
  });

  it('approves text-only listing updates and refuses link/icon ones', () => {
    expect(evaluateAutoRule(official, ctx({ kind: 'listing_update', changedFields: ['summary'] })).eligible).toBe(true);
    expect(evaluateAutoRule(official, ctx({ kind: 'listing_update', changedFields: ['homepageUrl'] })).eligible).toBe(false);
  });

  it('handles a rule with no conditions at all', () => {
    expect(evaluateAutoRule({}, ctx()).eligible).toBe(false);
  });
});

describe('widensRule (§3.0.1: enabling or widening needs a second approver)', () => {
  const base = { requestKinds: ['new_version'], publisherTiers: ['verified' as const], bumps: ['patch' as const], submitterServiceAccount: 'x', textOnlyListingUpdates: true, maxPerDay: 10, maxPerListingPerDay: 1, instanceFlag: 'F' };
  it.each([
    ['more kinds', { requestKinds: ['new_version', 'listing_update'] }],
    ['more tiers', { publisherTiers: ['verified' as const, 'community' as const] }],
    ['more bumps', { bumps: ['patch' as const, 'minor' as const] }],
    ['a dropped submitter pin', { submitterServiceAccount: undefined }],
    ['a dropped text-only restriction', { textOnlyListingUpdates: false }],
    ['a dropped instance flag', { instanceFlag: undefined }],
    ['a higher daily cap', { maxPerDay: 20 }],
    ['a removed listing cap', { maxPerListingPerDay: undefined }],
  ])('%s widens', (_why, over) => {
    expect(widensRule(base, { ...base, ...over })).toBe(true);
  });

  it('a pure narrowing does not', () => {
    expect(widensRule(base, { ...base, maxPerDay: 5 })).toBe(false);
    expect(widensRule({ requestKinds: ['new_version'] }, { requestKinds: ['new_version'] })).toBe(false);
  });
});
