// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Sysadmin admin-home dashboard summary endpoint.
 *
 *   GET /api/admin/summary
 *
 * Returns the fleet-wide stats the admin console needs in one round trip:
 * org count, sysadmin count, per-org KMS adoption count, IdP coverage,
 * and the current secret-encryption mode (single-master vs per-org KMS).
 *
 * Numbers are sourced directly from Mongo `countDocuments` queries with
 * indexed filters — cheap enough to call on every page load. The
 * observability scraper publishes these same counts as Prometheus gauges
 * for the long-running dashboards; this endpoint is the on-demand view
 * for the in-product admin home.
 */

import { sendSuccess } from '@pipeline-builder/api-core';
import { requireSystemAdmin, withController } from '../helpers/controller-helper';
import { Organization, User } from '../models';
import OrgIdpConfig from '../models/org-idp-config';

/** GET /api/admin/summary — fleet stats for the sysadmin dashboard. */
export const getAdminSummary = withController('Get admin summary', async (req, res) => {
  if (!requireSystemAdmin(req, res)) return;

  // Run all counts in parallel. Each is cheap (collection-level count
  // with a small filter); total round-trip is dominated by network.
  const [orgCount, sysadminCount, perOrgKmsCount, idpConfiguredCount, totalUsers] = await Promise.all([
    Organization.countDocuments({}),
    User.countDocuments({ isSuperAdmin: true }),
    Organization.countDocuments({ 'kmsConfig.keyId': { $exists: true, $ne: null } }),
    OrgIdpConfig.countDocuments({ enabled: true }),
    User.countDocuments({}),
  ]);

  sendSuccess(res, 200, {
    orgs: {
      total: orgCount,
      // KMS adoption — what fraction of orgs are wrapped under their own
      // CMK rather than the shared SECRET_ENCRYPTION_KEY master.
      perOrgKms: perOrgKmsCount,
      // SSO adoption — useful for "is SSO live across the fleet" answers.
      ssoEnabled: idpConfiguredCount,
    },
    users: {
      total: totalUsers,
      sysadmins: sysadminCount,
    },
    encryption: {
      // The PerOrgKmsKeyProvider opt-in is process-level (env). Mirror it
      // here so the dashboard can label "per-org KMS active in this
      // deploy" vs "shared-master only".
      perOrgKmsEnabled: (process.env.SECRET_ENCRYPTION_PER_ORG_KMS || '').toLowerCase() === 'true',
    },
    rls: {
      // Operators rolling out RLS strict mode want to see the current
      // mode at a glance from the dashboard. Reads the same env the
      // tenancy module reads.
      contextMode: (process.env.RLS_CONTEXT_MODE || 'warn').toLowerCase(),
    },
  });
});
