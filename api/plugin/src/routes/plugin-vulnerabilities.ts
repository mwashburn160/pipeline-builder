// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Vulnerability read routes, registered on the read router (so they carry its
 * auth / org / tenant chain, and the '/plugins' apiCalls quota mount) BEFORE its
 * `/:id` matcher:
 *
 *  - `GET /plugins/vulnerabilities/fleet` — the cross-tenant posture view
 *    (system org: `plugins:moderate` or `platform:read`);
 *  - `GET /plugins/vulnerabilities/:advisoryId` — which of the caller's visible
 *    plugin versions and pipelines one advisory hits (`plugins:read`);
 *  - `GET /plugins/:id/findings` — one version's full finding list, JSON or
 *    `?format=csv` (`plugins:read`).
 */

import {
  attachmentDisposition, ErrorCode, errorMessage, getParam, requirePermission, requireSystemOrgPermission, sendBadRequest, sendEntityNotFound, sendSuccess,
} from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import type { Router } from 'express';
import { parentOrgIdOf } from '../helpers/plugin-helpers.js';
import { fleetPosture, findingsCsv, searchAdvisory, versionFindings } from '../services/plugin-vuln-posture.js';
import { fleetRemediationPosture } from '../services/remediation/posture.js';

/** An advisory id as scanners report them (CVE, GHSA, Go vulndb, PyPA, RustSec, OSV …). */
const ADVISORY_ID_RE = /^[A-Za-z][A-Za-z0-9]{1,15}-[A-Za-z0-9._:-]{1,64}$/;

/** Mount the vulnerability read routes on `router` (see module doc). */
export function registerVulnerabilityRoutes(router: Router): void {
  // Literal path first: `:advisoryId` would otherwise match "fleet".
  router.get('/vulnerabilities/fleet', ...requireSystemOrgPermission('plugins:moderate', 'platform:read'),
    withRoute(async ({ res, ctx }) => {
      // The nightly-remediation block is optional on the wire: a failed read of
      // it leaves the vulnerability posture itself standing.
      const [posture, remediation] = await Promise.all([
        fleetPosture(),
        fleetRemediationPosture().catch((err: unknown) => {
          ctx.log('WARN', 'Fleet remediation posture unavailable; answered without it', { error: errorMessage(err) });
          return null;
        }),
      ]);
      ctx.log('COMPLETED', 'Computed fleet vulnerability posture', { orgs: posture.byOrg.length, flagged: posture.totals.flagged });
      return sendSuccess(res, 200, remediation ? { ...posture, remediation } : posture);
    }));

  router.get('/vulnerabilities/:advisoryId', requirePermission('plugins:read'), withRoute(async ({ req, res, ctx, orgId }) => {
    const advisoryId = getParam(req.params, 'advisoryId');
    if (!advisoryId || !ADVISORY_ID_RE.test(advisoryId)) {
      return sendBadRequest(res, 'advisoryId must be an advisory id such as CVE-2026-1234 or GHSA-xxxx-xxxx-xxxx', ErrorCode.VALIDATION_ERROR);
    }
    const result = await searchAdvisory(advisoryId, orgId, parentOrgIdOf(req));
    ctx.log('COMPLETED', 'Searched plugin findings for an advisory', { advisoryId, versions: result.versions.length, pipelines: result.affectedPipelines });
    return sendSuccess(res, 200, result);
  }));

  router.get('/:id/findings', requirePermission('plugins:read'), withRoute(async ({ req, res, ctx, orgId }) => {
    const id = getParam(req.params, 'id');
    if (!id) return sendBadRequest(res, 'Plugin ID is required.', ErrorCode.MISSING_REQUIRED_FIELD);
    const format = typeof req.query.format === 'string' ? req.query.format : 'json';
    if (format !== 'json' && format !== 'csv') return sendBadRequest(res, 'format must be json or csv', ErrorCode.VALIDATION_ERROR);

    const result = await versionFindings(id, orgId, parentOrgIdOf(req));
    if (!result) return sendEntityNotFound(res, 'Plugin');
    ctx.log('COMPLETED', 'Retrieved plugin findings', { id, findings: result.findings.length, format });
    if (format === 'csv') {
      const name = result.plugin.publisher ? `${result.plugin.publisher}-${result.plugin.name}` : result.plugin.name;
      res.setHeader('Content-Disposition', attachmentDisposition(`${name}-${result.plugin.version}-findings.csv`));
      res.status(200).type('text/csv; charset=utf-8').send(findingsCsv(result));
      return;
    }
    return sendSuccess(res, 200, result);
  }));
}
