// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, getParam, sendError, sendSuccess } from '@pipeline-builder/api-core';
import { audit } from '../helpers/audit.js';
import { incCounter } from '../observability/metrics.js';
import { withController, canAdministerOrg, requireAuth } from '../helpers/controller-helper.js';
import {
  orgDomainService, VERIFY_RECORD_HOST, VERIFY_RECORD_VALUE,
  DOMAIN_TAKEN, DOMAIN_NOT_FOUND, DOMAIN_NOT_VERIFIED, DOMAIN_VERIFY_FAILED,
  DOMAIN_NOT_ENTITLED, DOMAIN_LIMIT, DOMAIN_PUBLIC, JOIN_NOT_ELIGIBLE, JOIN_REQUEST_NOT_FOUND, JOIN_SEAT_LIMIT,
} from '../services/org-domain-service.js';
import { validateBody, addDomainSchema, setDomainModeSchema } from '../utils/validation.js';

const logger = createLogger('org-domain-controller');

/** Shared error map for the domain/join-request admin endpoints. */
const DOMAIN_ERROR_MAP = {
  [DOMAIN_TAKEN]: { status: 409, message: 'That domain is already registered to an organization' },
  [DOMAIN_NOT_FOUND]: { status: 404, message: 'Domain not found' },
  [DOMAIN_NOT_VERIFIED]: { status: 409, message: 'Verify the domain before enabling join' },
  [DOMAIN_VERIFY_FAILED]: { status: 400, message: 'Could not find the verification DNS TXT record' },
  [DOMAIN_NOT_ENTITLED]: { status: 403, message: 'Domain-based join requires the Team or Enterprise tier' },
  [DOMAIN_LIMIT]: { status: 409, message: 'This organization has reached its domain limit' },
  [DOMAIN_PUBLIC]: { status: 400, message: 'Public email providers (e.g. gmail.com) cannot be used for domain-based join' },
  [JOIN_NOT_ELIGIBLE]: { status: 409, message: 'This domain is no longer configured for join — the request can’t be approved' },
  [JOIN_REQUEST_NOT_FOUND]: { status: 404, message: 'Join request not found' },
  [JOIN_SEAT_LIMIT]: { status: 409, message: 'Approving this request would exceed your seat limit' },
} as const;

/** The DNS TXT record the admin must publish to verify a domain. Uses the same
 *  builders the service verifies against so instructions can't drift. */
function verifyInstructions(domain: string, token: string) {
  return { host: VERIFY_RECORD_HOST(domain), type: 'TXT', value: VERIFY_RECORD_VALUE(token) };
}

/** Serialize a domain doc for the admin UI (includes the token + DNS hint until verified). */
function domainView(d: { _id: unknown; domain: string; verified: boolean; verificationToken: string; autoJoin: string }) {
  return {
    id: String(d._id),
    domain: d.domain,
    verified: d.verified,
    autoJoin: d.autoJoin,
    ...(d.verified ? {} : { verification: verifyInstructions(d.domain, d.verificationToken) }),
  };
}

/** GET /organization/:id/domains — list the org's registered domains. */
export const listOrgDomains = withController('List org domains', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const id = getParam(req.params, 'id')!;
  if (!(await canAdministerOrg(req, id))) return sendError(res, 403, 'You can only manage an organization you administer');
  const domains = await orgDomainService.listDomains(id);
  sendSuccess(res, 200, { domains: domains.map(domainView), entitled: await orgDomainService.isEntitled(id) });
});

/** POST /organization/:id/domains — register a domain (unverified). */
export const addOrgDomain = withController('Add org domain', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const id = getParam(req.params, 'id')!;
  if (!(await canAdministerOrg(req, id))) return sendError(res, 403, 'You can only manage an organization you administer');
  const body = validateBody(addDomainSchema, req.body, res);
  if (!body) return;
  const doc = await orgDomainService.addDomain(id, body.domain, req.user!.sub);
  audit(req, 'org.domain.add', { targetType: 'organization', targetId: id, affectedOrgId: id, details: { domain: doc.domain } });
  sendSuccess(res, 201, { domain: domainView(doc) });
}, DOMAIN_ERROR_MAP);

/** POST /organization/:id/domains/:domainId/verify — confirm ownership via DNS TXT. */
export const verifyOrgDomain = withController('Verify org domain', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const id = getParam(req.params, 'id')!;
  if (!(await canAdministerOrg(req, id))) return sendError(res, 403, 'You can only manage an organization you administer');
  const domainId = getParam(req.params, 'domainId')!;
  let doc;
  try {
    doc = await orgDomainService.verifyDomain(id, domainId);
  } catch (err) {
    // Audit failed verification attempts (probing / misconfig), mirroring the
    // login.failed convention — the success audit is below.
    audit(req, 'org.domain.verify', { targetType: 'organization', targetId: id, affectedOrgId: id, outcome: 'failure', details: { domainId } });
    incCounter('platform_domain_verify_total', { outcome: 'failure' });
    throw err;
  }
  audit(req, 'org.domain.verify', { targetType: 'organization', targetId: id, affectedOrgId: id, details: { domain: doc.domain } });
  incCounter('platform_domain_verify_total', { outcome: 'success' });
  sendSuccess(res, 200, { domain: domainView(doc) });
}, DOMAIN_ERROR_MAP);

/** PATCH /organization/:id/domains/:domainId — set the discovery mode. */
export const setOrgDomainMode = withController('Set org domain mode', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const id = getParam(req.params, 'id')!;
  if (!(await canAdministerOrg(req, id))) return sendError(res, 403, 'You can only manage an organization you administer');
  const domainId = getParam(req.params, 'domainId')!;
  const body = validateBody(setDomainModeSchema, req.body, res);
  if (!body) return;
  const doc = await orgDomainService.setDomainMode(id, domainId, body.autoJoin);
  audit(req, 'org.domain.mode', { targetType: 'organization', targetId: id, affectedOrgId: id, details: { domain: doc.domain, autoJoin: doc.autoJoin } });
  sendSuccess(res, 200, { domain: domainView(doc) });
}, DOMAIN_ERROR_MAP);

/** DELETE /organization/:id/domains/:domainId — remove a domain. */
export const deleteOrgDomain = withController('Delete org domain', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const id = getParam(req.params, 'id')!;
  if (!(await canAdministerOrg(req, id))) return sendError(res, 403, 'You can only manage an organization you administer');
  const domainId = getParam(req.params, 'domainId')!;
  await orgDomainService.deleteDomain(id, domainId);
  audit(req, 'org.domain.delete', { targetType: 'organization', targetId: id, affectedOrgId: id, details: { domainId } });
  sendSuccess(res, 200, { deleted: true });
}, DOMAIN_ERROR_MAP);

/** GET /organization/:id/join-requests — pending domain-join requests. */
export const listOrgJoinRequests = withController('List org join requests', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const id = getParam(req.params, 'id')!;
  if (!(await canAdministerOrg(req, id))) return sendError(res, 403, 'You can only manage an organization you administer');
  const requests = await orgDomainService.listJoinRequests(id, 'pending');
  sendSuccess(res, 200, {
    requests: requests.map((r) => ({ id: String(r._id), userId: String(r.userId), email: r.email, requestedAt: r.createdAt })),
  });
});

/** POST /organization/:id/join-requests/:reqId/:decision — approve|deny. */
export const decideOrgJoinRequest = withController('Decide org join request', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const id = getParam(req.params, 'id')!;
  if (!(await canAdministerOrg(req, id))) return sendError(res, 403, 'You can only manage an organization you administer');
  const reqId = getParam(req.params, 'reqId')!;
  const decision = getParam(req.params, 'decision');
  if (decision !== 'approve' && decision !== 'deny') return sendError(res, 400, 'decision must be approve or deny');

  const result = await orgDomainService.decideJoinRequest(id, reqId, decision, req.user!.sub);
  audit(req, decision === 'approve' ? 'org.join.approve' : 'org.join.deny', {
    targetType: 'user', targetId: result.userId, affectedOrgId: id,
  });
  logger.info(`Join request ${reqId} ${result.status} for org ${id} by ${req.user!.sub}`);
  sendSuccess(res, 200, result);
}, DOMAIN_ERROR_MAP);
