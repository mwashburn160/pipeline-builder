// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** Fixtures for the public plugin directory suites (shapes per the public API contract). */
import type { ListingCard, ListingDetail, SearchResult } from '../../src/lib/public-directory/types';

export function card(overrides: Partial<ListingCard> = {}): ListingCard {
  return {
    publisher: { handle: 'pipeline-builder', displayName: 'Pipeline Builder', tier: 'official' },
    name: 'trivy',
    summary: 'Container and filesystem vulnerability scanning',
    category: 'security',
    keywords: ['containers', 'sca'],
    latestVersion: '1.4.2',
    license: 'Apache-2.0',
    iconUrl: null,
    iconKind: 'monogram',
    iconKey: null,
    iconHex: null,
    iconBadge: null,
    rating: null,
    installCount: 0,
    updatedAt: '2026-09-20T10:00:00Z',
    state: 'listed',
    ...overrides,
  };
}

export function searchResult(items: ListingCard[], overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    items,
    facets: {
      category: { security: items.length },
      tier: { official: items.length },
      license: { 'Apache-2.0': items.length },
      computeType: { SMALL: items.length },
      needsSecrets: { true: 0, false: items.length },
    },
    total: items.length,
    nextCursor: null,
    ...overrides,
  };
}

export function detail(overrides: Partial<ListingDetail> = {}): ListingDetail {
  return {
    ...card(),
    readmeHtml: '<h2>Trivy</h2><p>Scans images.</p>',
    description: 'Runs Trivy against the built image.',
    homepageUrl: 'https://trivy.dev',
    sourceUrl: null,
    versions: [
      {
        version: '1.4.2', publishedAt: '2026-09-20T10:00:00Z', breaking: false, deprecated: false,
        deprecationMessage: null, yanked: false, changelog: 'Fixes <b>things</b>', vulnCritical: 0, vulnHigh: 1, scannedAt: '2026-09-20T11:00:00Z',
        advisoryIds: [],
      },
    ],
    configuration: {
      secrets: [], requiredMetadata: [], requiredVars: [], computeType: 'SMALL',
      primaryOutputDirectory: null, networkEgress: [], pluginType: 'CodeBuildStep',
    },
    supplyChain: {
      signed: true, digest: 'sha256:abc', imageSource: 'built', scannedAt: '2026-09-20T11:00:00Z',
      vulnCritical: 0, vulnHigh: 1, sbomUrl: '/api/public/plugins/pipeline-builder/trivy/sbom',
    },
    advisories: [],
    ratingDistribution: null,
    recentRating: null,
    activeOrgCount: null,
    ...overrides,
  };
}

/** A `fetch` Response-alike for the public API envelope. */
export function jsonResponse(status: number, data?: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ success: status < 400, data }),
  };
}

/** A minimal `res` for getServerSideProps. */
export function fakeRes() {
  const headers: Record<string, string> = {};
  return {
    statusCode: 200,
    headers,
    body: '',
    setHeader(k: string, v: string) { headers[k.toLowerCase()] = v; },
    write(chunk: string) { this.body += chunk; },
    end() { /* noop */ },
  };
}
