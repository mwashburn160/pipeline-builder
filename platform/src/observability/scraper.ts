// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Periodic scraper that samples user / organization counts from Mongo
 * and publishes them as Prometheus gauges. Used by the Platform Overview
 * dashboard.
 *
 * Sampled every 60s — these counts change slowly (new signups, org
 * lifecycle), so polling more often costs Mongo round-trips for no signal.
 */

import { createLogger, errorMessage } from '@pipeline-builder/api-core';
import { User, Organization, UserOrganization } from '../models';
import { setGauge } from './metrics';

const logger = createLogger('platform-scraper');
const INTERVAL_MS = 60_000;

let timer: ReturnType<typeof setInterval> | null = null;

async function scrapeOnce(): Promise<void> {
  try {
    // Total users + orgs in the system. Mongo `countDocuments` is cheap on
    // collections with no large filter scan.
    const [userCount, orgCount] = await Promise.all([
      User.countDocuments({}),
      Organization.countDocuments({}),
    ]);
    setGauge('platform_users_total', {}, userCount);
    setGauge('platform_orgs_total', {}, orgCount);

    // Active memberships (across orgs). One user can belong to several
    // orgs — this counts membership rows, not unique users.
    const activeMembershipCount = await UserOrganization.countDocuments({ isActive: true });
    setGauge('platform_memberships_active_total', {}, activeMembershipCount);
  } catch (err) {
    logger.warn('platform metrics scrape failed', { error: errorMessage(err) });
  }
}

/**
 * Start the scraper. Idempotent — safe to call multiple times. Returns a
 * stop function; also wire SIGTERM to stop in index.ts.
 */
export function startPlatformMetricsScraper(intervalMs: number = INTERVAL_MS): () => void {
  if (timer) return stopPlatformMetricsScraper;
  timer = setInterval(() => void scrapeOnce(), intervalMs);
  void scrapeOnce(); // immediate first sample
  logger.info('Platform metrics scraper started', { intervalMs });
  return stopPlatformMetricsScraper;
}

export function stopPlatformMetricsScraper(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
