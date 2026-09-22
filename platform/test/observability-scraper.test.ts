// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The platform count gauges must be fresh on EVERY replica.
 *
 * Prometheus scrapes each pod separately. When the scraper sampled under a
 * leader lock, only the lock holder refreshed its gauges; every other pod kept
 * exporting a stale (or absent) value, and dashboards showed whichever series
 * Prometheus happened to return. So: every pod samples, and the catalog
 * collapses the per-pod series with `max(...)`.
 */

import { jest, describe, it, expect, afterEach } from '@jest/globals';
import { mockConfig } from './helpers/config-mock.js';

const mockSetGauge = jest.fn();
const count = (n: number) => jest.fn(async () => n);

jest.unstable_mockModule('../src/config/index.js', () => mockConfig({ observability: { scraperIntervalMs: 60_000 } }));
jest.unstable_mockModule('../src/observability/metrics.js', () => ({ setGauge: mockSetGauge }));
jest.unstable_mockModule('../src/models/index.js', () => ({
  User: { countDocuments: count(7) },
  Organization: { countDocuments: count(3) },
  UserOrganization: { countDocuments: count(9) },
}));
// A replica that never wins the lock: if the scraper still went through it,
// no gauge would ever be set here.
jest.unstable_mockModule('../src/utils/leader-lock.js', () => ({ runWithLeaderLock: jest.fn(async () => false) }));

const { startPlatformMetricsScraper, stopPlatformMetricsScraper } = await import('../src/observability/scraper.js');
const { QUERIES } = await import('../src/observability/catalog.js');

afterEach(() => stopPlatformMetricsScraper());

describe('platform metrics scraper', () => {
  it('samples on every replica — no leader lock gates the gauges', async () => {
    startPlatformMetricsScraper(60_000);
    await new Promise((r) => setImmediate(r));

    expect(mockSetGauge).toHaveBeenCalledWith('platform_users_total', {}, 7);
    expect(mockSetGauge).toHaveBeenCalledWith('platform_orgs_total', {}, 3);
    expect(mockSetGauge).toHaveBeenCalledWith('platform_memberships_active_total', {}, 9);
  });

  it.each(['platform_orgs_total', 'platform_users_total', 'platform_memberships_active_total'])(
    'catalog collapses the per-pod %s series with max()',
    (key) => {
      expect(QUERIES[key].query).toBe(`max(${key})`);
    },
  );
});
