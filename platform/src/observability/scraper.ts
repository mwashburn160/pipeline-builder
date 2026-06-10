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
import { setGauge } from './metrics.js';
import { User, Organization, UserOrganization } from '../models/index.js';

const logger = createLogger('platform-scraper');
/** How often to scrape org/user counts for the Prom gauges. Sized for the Prom
 *  scrape budget — anything under 30s isn't useful since Prom polls every 15s. */
const INTERVAL_MS = parseInt(process.env.PLATFORM_SCRAPER_INTERVAL_MS || '60000', 10);

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

    // Per-org KMS adoption — how many orgs are wrapped under their own
    // CMK vs falling through to the shared SECRET_ENCRYPTION_KEY master.
    // Operators dashboard `secret_encryption_per_org_kms_orgs` against
    // `platform_orgs_total` to see coverage; the absolute count alone
    // tells "is this turned on at all". Compound index on (kmsConfig.keyId)
    // would help if the gauge ever lags Mongo; today's org count makes
    // the full scan acceptable.
    const perOrgKmsCount = await Organization.countDocuments({
      'kmsConfig.keyId': { $exists: true, $ne: null },
    });
    setGauge('secret_encryption_per_org_kms_orgs', {}, perOrgKmsCount);

    // Sysadmin headcount — operationally useful when reviewing the audit
    // trail of platform-admin grants. A sudden spike is a leading signal
    // worth investigating; a zero count after a fresh deploy is the
    // BOOTSTRAP_SUPERADMIN_EMAILS-needs-attention signal.
    const sysadminCount = await User.countDocuments({ isSuperAdmin: true });
    setGauge('platform_sysadmins_total', {}, sysadminCount);
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
