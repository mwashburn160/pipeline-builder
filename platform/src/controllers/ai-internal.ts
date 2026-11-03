// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `/internal/ai/*` — the org half of every AI call, for the services that make one
 * (ask, pipeline, plugin, reporting). INTERNAL: their signed service tokens only
 * (`requireInternalService`), and the mesh names the same callers on the Istio targets.
 *
 *  - `GET /internal/ai/access/:orgId` — the org's AI switch and WHICH providers it holds
 *    its own key for. Names only; read on every AI request (cached briefly by the caller).
 *
 *  - `GET /internal/ai/keys/:orgId/:provider` — the DECRYPTED key, so the call can be
 *    billed to the org's own provider account instead of the platform's. The org BYOK
 *    keys were write-only until this route: encrypted on save, read by nothing.
 *
 * KEY HANDLING. The plaintext exists only in this response body: never logged (the
 * controller logs nothing about the value), never in an error, never cached here. Each
 * read is AUDITED (`org.ai-key.read`) with the calling service as actor and the provider
 * name as the only detail — so "who has been reading our key" has an answer, without
 * the trail itself holding key material. The caller caches for at most
 * `ORG_AI_KEY_TTL_MS` (default 60s), which bounds the audit volume to about one row per
 * provider per service replica per minute of use.
 *
 * TENANCY. The service token is minted FOR the org it asks about; a token scoped to a
 * different org is refused. That is not a boundary against a compromised caller (it can
 * mint any org), but it makes every read name its org consistently in the token, the
 * path and the audit row.
 */

import { getParam, isServicePrincipal, sendError, sendSuccess } from '@pipeline-builder/api-core';
import type { Request, Response } from 'express';
import { audit } from '../helpers/audit.js';
import { withController } from '../helpers/controller-helper.js';
import { organizationService } from '../services/index.js';

/** Org ids are ObjectIds, plus the system org's well-known id. */
const ORG_ID = /^(?:[a-f0-9]{24}|system)$/i;
/** The providers an org may hold a key for (organization-ai-secrets.ts). */
const PROVIDERS = new Set(['anthropic', 'openai', 'google', 'xai']);

/** The path org, normalized, when the caller's token is scoped to it; else answers and returns undefined. */
function scopedOrg(req: Request, res: Response): string | undefined {
  const orgId = (getParam(req.params, 'orgId') ?? '').toLowerCase();
  if (!ORG_ID.test(orgId)) {
    sendError(res, 400, 'orgId must be an organization id');
    return undefined;
  }
  if (!isServicePrincipal(req) || String(req.user?.organizationId ?? '').toLowerCase() !== orgId) {
    sendError(res, 403, 'The service token must be scoped to the organization it asks about');
    return undefined;
  }
  return orgId;
}

/** GET /internal/ai/access/:orgId → `{ aiEnabled, providers }`. */
export const getOrgAIAccess = withController('Org AI access', async (req, res) => {
  const orgId = scopedOrg(req, res);
  if (!orgId) return;
  const access = await organizationService.getAIAccess(orgId);
  if (!access) return sendError(res, 404, 'Organization not found');
  sendSuccess(res, 200, access);
});

/** GET /internal/ai/keys/:orgId/:provider → `{ provider, apiKey }` (audited, never logged). */
export const getOrgAIKey = withController('Org AI key', async (req, res) => {
  const orgId = scopedOrg(req, res);
  if (!orgId) return;
  const provider = getParam(req.params, 'provider') ?? '';
  if (!PROVIDERS.has(provider)) return sendError(res, 400, 'provider must be a key-based AI provider');

  const apiKey = await organizationService.readAIProviderKey(orgId, provider);
  if (!apiKey) return sendError(res, 404, 'The organization has no key for this provider');

  audit(req, 'org.ai-key.read', {
    targetType: 'organization',
    targetId: orgId,
    affectedOrgId: orgId,
    details: { provider },
  });
  sendSuccess(res, 200, { provider, apiKey });
});
