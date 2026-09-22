// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure W2 helpers: the install action a catalog entry offers, the rekeyed
 * plugin-usage key, the consumption-policy form's draft logic, and the
 * pipeline-editor picker's grouping / shadowing / selection.
 */
import { describe, it, expect } from '@jest/globals';
import {
  addBlockedListing, applyPluginPick, diffPolicy, entryFromInstall, groupCatalogEntries, installActionState,
  listingUsage, parseListingRef, pluginUsageKey, policyWarnings, removeBlockedListing, resolvableEntries,
  shadowedListing, shadowingMessage, toggleTier,
} from '../src/lib/plugin-installs';
import type { Plugin } from '../src/types';
import { POLICY, catalogEntry, installView, officialEntry } from './helpers/pluginInstallFixtures';

describe('installActionState', () => {
  it('offers Install, or Request install when approval is needed', () => {
    expect(installActionState(catalogEntry())).toEqual({ kind: 'install', requiresApproval: false });
    expect(installActionState(catalogEntry({ requiresApproval: true }))).toEqual({ kind: 'install', requiresApproval: true });
  });

  it('reads the install first: pending, denied, implicit, installed', () => {
    expect(installActionState(catalogEntry({ install: installView({ status: 'pending_approval' }) })).kind).toBe('pending');
    expect(installActionState(catalogEntry({ install: installView({ status: 'denied' }) })).kind).toBe('denied');
    expect(installActionState(officialEntry()).kind).toBe('implicit');
    expect(installActionState(catalogEntry({ install: installView() })).kind).toBe('installed');
  });

  it('blocked beats paused beats installable; otherwise unavailable', () => {
    const blocked = { reason: 'tier' as const, message: 'Community plugins are not allowed' };
    const pausedListing = { ...catalogEntry().listing, paused: true };
    expect(installActionState(catalogEntry({ blocked, listing: pausedListing }))).toEqual({ kind: 'blocked', blocked });
    expect(installActionState(catalogEntry({ listing: pausedListing }))).toEqual({ kind: 'paused' });
    expect(installActionState(catalogEntry({ installable: false }))).toEqual({ kind: 'unavailable' });
  });
});

describe('plugin-usage keys', () => {
  it('uses the bare name unqualified and publisher/name qualified', () => {
    expect(pluginUsageKey({ name: 'trivy' })).toBe('trivy');
    expect(pluginUsageKey({ publisher: 'acme', name: 'tf' })).toBe('acme/tf');
    expect(pluginUsageKey({ publisher: '', name: 'tf' })).toBe('tf');
  });

  it('counts an unshadowed Official listing under both keys, a shadowed one only qualified', () => {
    const counts = { trivy: 3, 'pipeline-builder/trivy': 1, 'acme/tf': 2, tf: 9 };
    const official = { publisherHandle: 'pipeline-builder', name: 'trivy' };
    expect(listingUsage(official, counts)).toBe(4);
    expect(listingUsage(official, counts, { shadowed: true })).toBe(1);
    // A non-Official listing never answers to its bare name.
    expect(listingUsage({ publisherHandle: 'acme', name: 'tf' }, counts)).toBe(2);
    expect(listingUsage({ publisherHandle: 'acme', name: 'none' }, counts)).toBe(0);
  });
});

describe('consumption-policy form', () => {
  it('toggles tiers in canonical order without duplicates', () => {
    expect(toggleTier(['verified'], 'official', true)).toEqual(['official', 'verified']);
    expect(toggleTier(['official', 'verified'], 'official', true)).toEqual(['official', 'verified']);
    expect(toggleTier(['official', 'verified'], 'verified', false)).toEqual(['official']);
  });

  it('parses publisher/name and rejects anything else', () => {
    expect(parseListingRef(' acme / terraform-plan ')).toEqual({ publisher: 'acme', name: 'terraform-plan' });
    expect(parseListingRef('acme')).toBeNull();
    expect(parseListingRef('a/b/c')).toBeNull();
    expect(parseListingRef('/x')).toBeNull();
  });

  it('adds blocked listings once and removes them', () => {
    const one = addBlockedListing([], { publisher: 'acme', name: 'tf' });
    expect(addBlockedListing(one, { publisher: 'acme', name: 'tf' })).toBe(one);
    expect(removeBlockedListing(one, { publisher: 'acme', name: 'tf' })).toEqual([]);
  });

  it('diffs only the changed fields (sets compare order-insensitively)', () => {
    expect(diffPolicy(POLICY, { ...POLICY, allowedTiers: ['verified', 'official'] })).toEqual({});
    expect(diffPolicy(POLICY, {
      ...POLICY,
      allowedTiers: ['official'],
      blockOnAdvisory: 'high',
      blockedListings: [{ publisher: 'acme', name: 'tf' }],
    })).toEqual({ allowedTiers: ['official'], blockOnAdvisory: 'high', blockedListings: [{ publisher: 'acme', name: 'tf' }] });
    expect(diffPolicy(POLICY, { ...POLICY, officialInstalls: 'explicit' })).toEqual({ officialInstalls: 'explicit' });
  });

  it('warns about consequential settings', () => {
    expect(policyWarnings(POLICY)).toEqual([]);
    const w = policyWarnings({
      ...POLICY,
      allowedTiers: ['verified'],
      secretsAllowedTiers: ['official', 'verified'],
      officialInstalls: 'explicit',
      blockOnAdvisory: 'never',
    });
    expect(w.join('\n')).toMatch(/Official plugins are not allowed/);
    expect(w.join('\n')).toMatch(/Secrets for Official have no effect/);
    expect(w.join('\n')).toMatch(/installed deliberately/);
    expect(w.join('\n')).toMatch(/advisory will keep resolving/);
  });
});

describe('pipeline editor picker', () => {
  const blockedEntry = officialEntry('checkov', { blocked: { reason: 'blocked_listing', message: 'Blocked' } });
  const notInstalled = catalogEntry({ listing: { ...catalogEntry().listing, id: 'l2', name: 'ansible' } });
  const installed = catalogEntry({
    install: installView(),
    resolved: { ...officialEntry().resolved!, version: '1.2.0', primaryOutputDirectory: 'plan' },
  });

  it('keeps only resolvable, unblocked entries', () => {
    expect(resolvableEntries([officialEntry(), blockedEntry, notInstalled, installed]).map((e) => e.listing.name))
      .toEqual(['trivy', 'terraform-plan']);
  });

  it('groups Official first, then installed listings, filtered by query', () => {
    const groups = groupCatalogEntries([installed, officialEntry('zap'), officialEntry('trivy')], '');
    expect(groups.map((g) => [g.label, g.entries.map((e) => e.listing.name)])).toEqual([
      ['Official', ['trivy', 'zap']],
      ['Installed from the catalog', ['terraform-plan']],
    ]);
    expect(groupCatalogEntries([installed, officialEntry()], 'acme').map((g) => g.label)).toEqual(['Installed from the catalog']);
    expect(groupCatalogEntries([installed], 'nothing')).toEqual([]);
  });

  it('flags only unqualified shadowed names', () => {
    const shadowing = [{ name: 'trivy', listing: { publisherHandle: 'pipeline-builder', name: 'trivy' } }];
    expect(shadowedListing({ name: 'trivy' }, shadowing)).toEqual({ publisherHandle: 'pipeline-builder', name: 'trivy' });
    expect(shadowedListing({ publisher: 'pipeline-builder', name: 'trivy' }, shadowing)).toBeNull();
    expect(shadowedListing({ name: 'other' }, shadowing)).toBeNull();
    expect(shadowingMessage('trivy')).toBe('Shadows the Official listing pipeline-builder/trivy: pipelines that reference `trivy` use this plugin.');
  });

  it('applies a listing pick as { publisher, name } and a plugin pick as a pinned row', () => {
    const target: { publisher?: string; name: string; alias?: string; filter?: Record<string, unknown> } = {
      name: 'old', alias: 'a', filter: { id: 'x' },
    };
    applyPluginPick(target, { kind: 'listing', entry: installed });
    expect(target).toEqual({ publisher: 'acme', name: 'terraform-plan', alias: undefined });

    applyPluginPick(target, { kind: 'listing', entry: officialEntry() });
    expect(target).toEqual({ name: 'trivy', alias: undefined });

    const plugin = { id: 'p1', orgId: 'org-1', name: 'mine', version: '1.0.0', visibility: 'org', isDefault: true, isActive: true } as Plugin;
    applyPluginPick({ ...target, publisher: 'acme' }, { kind: 'plugin', plugin });
    const t2: typeof target = { publisher: 'acme', name: 'x' };
    applyPluginPick(t2, { kind: 'plugin', plugin });
    expect(t2).toEqual({
      name: 'mine', alias: undefined,
      filter: { id: 'p1', orgId: 'org-1', version: '1.0.0', visibility: 'org', isDefault: true, isActive: true },
    });
  });
});

describe('entryFromInstall', () => {
  it('builds the reference Official → { name }, others → { publisher, name }', () => {
    expect(entryFromInstall(installView()).reference).toEqual({ publisher: 'acme', name: 'terraform-plan' });
    const official = entryFromInstall(installView({ publisherHandle: 'pipeline-builder', name: 'trivy' }));
    expect(official.reference).toEqual({ name: 'trivy' });
    expect(official.installable).toBe(false);
    expect(installActionState(official).kind).toBe('installed');
  });
});
