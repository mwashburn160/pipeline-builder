// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** Fixtures for the install / catalog / policy surfaces. */
import type { CatalogEntry, ConsumptionPolicy, InstallView } from '../../src/types/plugin-installs';

export function installView(over: Partial<InstallView> = {}): InstallView {
  return {
    id: 'i1',
    listingId: 'l1',
    publisherHandle: 'acme',
    publisherDisplayName: 'Acme',
    publisherTier: 'verified',
    name: 'terraform-plan',
    summary: 'Plans Terraform',
    category: 'deploy',
    icon: null,
    state: 'listed',
    paused: false,
    versionPolicy: 'minor',
    pinnedVersion: '1.0.0',
    resolvedVersion: '1.2.0',
    latestVersion: '2.0.0',
    status: 'active',
    implicit: false,
    inherited: false,
    installedBy: 'u1',
    approvedBy: null,
    createdAt: '2026-09-01T00:00:00Z',
    decidedAt: null,
    upgrade: null,
    blocked: null,
    warnings: [],
    advisories: [],
    ...over,
  };
}

export function catalogEntry(over: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    listing: {
      id: 'l1',
      publisherHandle: 'acme',
      publisherDisplayName: 'Acme',
      publisherTier: 'verified',
      name: 'terraform-plan',
      summary: 'Plans Terraform',
      category: 'deploy',
      icon: null,
      latestVersion: '1.2.0',
      state: 'listed',
      paused: false,
      license: 'MIT',
    },
    needsApproval: false,
    install: null,
    installable: true,
    blocked: null,
    resolved: null,
    reference: { publisher: 'acme', name: 'terraform-plan' },
    shadowedBy: null,
    rating: null,
    installCount: 0,
    ...over,
  };
}

/** An Official listing, implicitly installed and resolving. */
export function officialEntry(name = 'trivy', over: Partial<CatalogEntry> = {}): CatalogEntry {
  const base = catalogEntry();
  return {
    ...base,
    listing: { ...base.listing, id: `off-${name}`, publisherHandle: 'pipeline-builder', publisherDisplayName: 'Pipeline Builder', publisherTier: 'official', name },
    install: installView({ id: null, implicit: true, publisherHandle: 'pipeline-builder', publisherTier: 'official', name, pinnedVersion: null }),
    installable: false,
    resolved: {
      version: '0.58.0', pluginType: 'CodeBuildStep', computeType: 'MEDIUM', primaryOutputDirectory: 'reports',
      description: 'Scans images', requiredMetadata: [], requiredVars: [], secrets: [],
    },
    reference: { name },
    ...over,
  };
}

export const POLICY: ConsumptionPolicy = {
  allowedTiers: ['official', 'verified'],
  requireApprovalTiers: ['community', 'unverified'],
  secretsAllowedTiers: ['official', 'verified'],
  blockOnAdvisory: 'critical',
  officialInstalls: 'implicit',
  blockedListings: [],
};
