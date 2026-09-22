// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * SSO "TEST CONNECTION" — a dry run of the org's IdP.
 *
 *   POST /organization/:id/idp/test           → { url, state }   (open `url` in a popup)
 *   POST /organization/:id/idp/test/complete  body { state, code?, error? }
 *        → { report }
 *
 * The admin's popup makes the REAL round trip to the IdP — the same authorize
 * request (or AuthnRequest), the same signature / issuer / audience / nonce /
 * InResponseTo / replay checks, the same domain-authority, seat and
 * platform-admin rules — and comes back with a report instead of a session:
 * success or failure, the resolved email / name / groups, which group → Role
 * mappings WOULD apply, and the reason on failure.
 *
 * DRY-RUN SAFETY — a test can never become a sign-in; the reasons are listed
 * in helpers/sso-test-flow.ts, which holds the dry-run engine.
 *
 * The outcome is audited as `sso.test` and recorded on the config
 * (`lastTest`) — which is what the "SSO required" gate reads.
 */

import crypto from 'crypto';
import { createLogger, getParam, sendError, sendSuccess } from '@pipeline-builder/api-core';
import { audit } from '../helpers/audit.js';
import { ensureAuthenticated, withController } from '../helpers/controller-helper.js';
import { getTestableLoginConfig, getTestableSamlConfig, requireOwnOrgSso } from '../helpers/sso-enforcement.js';
import { type PendingTest, isTestState, mintTestState, rememberTest, resolveTestReport, verifyTestMarker } from '../helpers/sso-test-flow.js';
import { incCounter } from '../observability/metrics.js';
import { OIDC_ERROR_MAP, buildAuthorizeUrl } from '../services/oidc-service.js';
import { orgIdpService } from '../services/org-idp-service.js';
import { SAML_ERROR_MAP, buildSamlAuthorizeUrl } from '../services/saml-service.js';
import { ssoTestCompleteSchema, validateBody } from '../utils/validation.js';

const logger = createLogger('sso-test');

// Start

/**
 * POST /organization/:id/idp/test — start a dry run. Works whether or not the
 * connection is enabled (testing BEFORE enabling is the point); the org must be
 * in scope and `sso`-entitled.
 */
export const startSsoTest = withController('Start SSO test', async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  const orgId = getParam(req.params, 'id')!;
  if (!(await requireOwnOrgSso(req, res, orgId))) return;

  const stored = await orgIdpService.findByOrg(orgId);
  if (!stored) {
    sendError(res, 404, 'Configure an identity provider before testing it', 'OIDC_NOT_CONFIGURED');
    return;
  }

  const state = await mintTestState(orgId);
  const base: PendingTest = {
    orgId,
    actorId: String(req.user!.sub),
    protocol: stored.protocol,
    testedUpdatedAt: stored.updatedAt,
  };

  let url: string;
  if (stored.protocol === 'saml') {
    url = await buildSamlAuthorizeUrl(await getTestableSamlConfig(orgId), state, { test: true });
    await rememberTest(state, base);
  } else {
    const nonce = crypto.randomBytes(16).toString('hex');
    const authorize = await buildAuthorizeUrl(await getTestableLoginConfig(orgId), state, nonce);
    url = authorize.url;
    await rememberTest(state, { ...base, nonce, ...(authorize.codeVerifier && { codeVerifier: authorize.codeVerifier }) });
  }

  audit(req, 'sso.test', {
    targetType: 'org-idp-config',
    targetId: orgId,
    affectedOrgId: orgId,
    details: { stage: 'start', protocol: stored.protocol },
  });
  sendSuccess(res, 200, { url, state });
}, { ...OIDC_ERROR_MAP, ...SAML_ERROR_MAP });

/**
 * POST /organization/:id/idp/test/complete — collect the report. Only the admin
 * who started the test can; the state is consumed on any lookup.
 */
export const completeSsoTest = withController('Complete SSO test', async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  const orgId = getParam(req.params, 'id')!;
  if (!(await requireOwnOrgSso(req, res, orgId))) return;
  const body = validateBody(ssoTestCompleteSchema, req.body, res);
  if (!body) return;

  if (!isTestState(body.state) || !(await verifyTestMarker(orgId, body.state))) {
    sendError(res, 403, 'This test has expired or was already completed. Start a new test.', 'SSO_TEST_INVALID_STATE');
    return;
  }
  const resolved = await resolveTestReport(String(req.user!.sub), orgId, body);
  if (!resolved) {
    sendError(res, 403, 'This test has expired or was already completed. Start a new test.', 'SSO_TEST_INVALID_STATE');
    return;
  }
  const { pending, report } = resolved;

  const recorded = await orgIdpService.recordTestResult(orgId, pending.testedUpdatedAt, {
    at: new Date(report.testedAt),
    ok: report.ok,
    protocol: report.protocol,
    ...(report.reason ? { reason: report.reason } : {}),
    actorId: pending.actorId,
  });

  audit(req, 'sso.test', {
    targetType: 'org-idp-config',
    targetId: orgId,
    affectedOrgId: orgId,
    outcome: report.ok ? 'success' : 'failure',
    details: {
      stage: 'complete',
      protocol: report.protocol,
      ok: report.ok,
      ...(report.reason ? { reason: report.reason } : {}),
      ...(report.identity ? { email: report.identity.email } : {}),
      recorded,
    },
  });
  incCounter('platform_sso_tests_total', { protocol: report.protocol, result: report.ok ? 'success' : (report.reason ?? 'error') });
  logger.info('SSO test completed', { orgId, protocol: report.protocol, ok: report.ok, reason: report.reason });

  sendSuccess(res, 200, { report: { ...report, recorded } });
}, { ...OIDC_ERROR_MAP, ...SAML_ERROR_MAP });
