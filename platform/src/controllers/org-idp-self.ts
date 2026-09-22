// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * ORG-ADMIN SELF-SERVICE for per-org IdP (SSO) configuration.
 *
 *   GET    /organization/:id/idp                  → read own-org config
 *   PUT    /organization/:id/idp                  → upsert (full body)
 *   PATCH  /organization/:id/idp                  → partial update (incl. "SSO required")
 *   DELETE /organization/:id/idp                  → remove
 *   GET    /organization/:id/idp/sp-info          → the values to register AT the IdP
 *   POST   /organization/:id/idp/metadata/import  → parse IdP metadata (XML or URL) into form fields
 *
 * The test-connection routes (`/idp/test`, `/idp/test/complete`) live in
 * controllers/sso-test.ts.
 *
 * The customer-facing counterpart to the superadmin `/admin/org-idp/*` fleet
 * surface (controllers/org-idp.ts): it lets a customer's OWN admin manage their
 * org's SSO without an operator. Layered gates:
 *   - route:   `requirePermission('org:settings')` — the org-assignable capability
 *              that already governs IdP/KMS/AI/general org settings (see the RBAC
 *              catalog note on `org:settings`), plus `requireStepUp` on the
 *              secret-bearing writes (mirrors the sysadmin routes).
 *   - controller: `requireOwnOrgSso` (helpers/sso-enforcement) — the caller may
 *              only touch THEIR OWN org or a team they manage (path `:id` ∈
 *              {active org, descendant}); AND the org must be `sso`-ENTITLED. An
 *              unentitled/out-of-scope org is 403'd. The group-mapping surface
 *              (controllers/org-idp-mappings.ts) shares that same gate.
 *
 * Everything else — validation, the write-only client-secret handling, the
 * `idpConfigs` quota reservation, the audit actions — lives in
 * `helpers/org-idp-ops.ts` and is shared verbatim with the sysadmin surface,
 * so the two cannot drift apart (e.g. in preserving the stored client secret
 * on an update).
 */

import { createLogger, getParam, safeFetch, sendSuccess, type SafeFetchResponse, errorMessage } from '@pipeline-builder/api-core';
import { audit } from '../helpers/audit.js';
import { ensureAuthenticated, withController } from '../helpers/controller-helper.js';
import { deleteOrgIdp, patchOrgIdp, readOrgIdp, upsertOrgIdp } from '../helpers/org-idp-ops.js';
import { requireOwnOrgSso } from '../helpers/sso-enforcement.js';
import { ORG_IDP_ERROR_MAP } from '../services/idp-mapping-errors.js';
import { ssoCallbackUrl } from '../services/oidc-service.js';
import {
  SAML_ERROR_MAP,
  parseIdpMetadata,
  samlAcsUrl,
  samlSloUrl,
  samlSpEntityId,
} from '../services/saml-service.js';
import { getSamlSpKeys } from '../services/saml-sp-keys.js';
import { idpMetadataImportSchema, validateBody } from '../utils/validation.js';

const logger = createLogger('org-idp-self');

/** GET /organization/:id/idp — read own-org IdP config (200 with `config: null`
 *  when none is set, mirroring the sysadmin read). */
export const getOwnOrgIdpConfig = withController('Get own-org IdP config', async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  const orgId = getParam(req.params, 'id')!;
  if (!(await requireOwnOrgSso(req, res, orgId))) return;

  await readOrgIdp(res, orgId);
});

/** PUT /organization/:id/idp — upsert own-org IdP config (full body). */
export const putOwnOrgIdpConfig = withController('Put own-org IdP config', async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  const orgId = getParam(req.params, 'id')!;
  if (!(await requireOwnOrgSso(req, res, orgId))) return;
  await upsertOrgIdp(req, res, orgId, 'self-service');
}, ORG_IDP_ERROR_MAP);

/** PATCH /organization/:id/idp — partial update of own-org IdP config. */
export const patchOwnOrgIdpConfig = withController('Patch own-org IdP config', async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  const orgId = getParam(req.params, 'id')!;
  if (!(await requireOwnOrgSso(req, res, orgId))) return;
  await patchOrgIdp(req, res, orgId, 'self-service');
}, ORG_IDP_ERROR_MAP);

/** DELETE /organization/:id/idp — remove own-org IdP config. */
export const deleteOwnOrgIdpConfig = withController('Delete own-org IdP config', async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  const orgId = getParam(req.params, 'id')!;
  if (!(await requireOwnOrgSso(req, res, orgId))) return;
  await deleteOrgIdp(req, res, orgId, 'self-service');
});

/**
 * GET /organization/:id/idp/sp-info — everything an administrator registers AT
 * their identity provider, computed from THIS deployment's configuration
 * (`OAUTH_CALLBACK_BASE_URL`) and SP keys. The UI shows these verbatim, so it
 * never has to guess them from the browser's own origin (which differs whenever
 * the dashboard is reached through another hostname than the public one).
 *
 * Available before any connection exists — you need them to create the IdP
 * application in the first place.
 */
export const getOwnOrgIdpSpInfo = withController('Get own-org SSO SP info', async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  const orgId = getParam(req.params, 'id')!;
  if (!(await requireOwnOrgSso(req, res, orgId))) return;

  const keys = await getSamlSpKeys();
  sendSuccess(res, 200, {
    sp: {
      entityId: samlSpEntityId(orgId),
      acsUrl: samlAcsUrl(orgId),
      metadataUrl: samlSpEntityId(orgId),
      sloUrl: samlSloUrl(orgId),
      oidcRedirectUri: ssoCallbackUrl(orgId),
      signingCertificate: keys.signing.certificate,
      encryptionCertificate: keys.encryption.certificate,
    },
  });
});

/** Cap on a fetched (or pasted) metadata document. Real IdP metadata is a few
 *  KB; an aggregate federation feed is not what this form is for. */
const METADATA_MAX_BYTES = 512 * 1024;
/** Wall-clock cap on the metadata fetch. */
const METADATA_FETCH_TIMEOUT_MS = 5_000;

const METADATA_ERROR_MAP = {
  ...SAML_ERROR_MAP,
  SAML_METADATA_FETCH_FAILED: { status: 502, message: 'Could not fetch the metadata URL. Check that it is a public https URL that returns the metadata document directly (no redirects), or paste the XML instead.' },
} as const;

/**
 * Fetch a metadata URL through api-core's {@link safeFetch}: https only, the
 * host resolved and the vetted IP PINNED into the socket (so a public hostname
 * cannot re-resolve to an internal address between the check and the connect),
 * redirects REFUSED (so a public URL can't bounce to an internal one), with a
 * hard timeout and a byte cap enforced while reading — a slow or endless body
 * cannot hold the request open.
 */
async function fetchMetadata(url: string): Promise<string> {
  let resp: SafeFetchResponse;
  try {
    resp = await safeFetch(url, {
      headers: { Accept: 'application/samlmetadata+xml, application/xml, text/xml' },
      timeoutMs: METADATA_FETCH_TIMEOUT_MS,
      maxResponseBytes: METADATA_MAX_BYTES,
    });
  } catch (err) {
    logger.warn('Refused or failed IdP metadata URL', { error: errorMessage(err) });
    throw new Error('SAML_METADATA_FETCH_FAILED');
  }
  if (resp.redirected || !resp.ok || resp.body.byteLength === 0) throw new Error('SAML_METADATA_FETCH_FAILED');
  return resp.text();
}

/**
 * POST /organization/:id/idp/metadata/import — parse an IdP metadata document
 * (pasted / uploaded XML, or fetched from a URL) into the SAML form's fields:
 * `{ metadata: { entityId, ssoUrl, sloUrl?, certificates, wantsSignedRequests } }`.
 *
 * Saves NOTHING: the form is pre-filled and the administrator reviews and saves
 * it through the ordinary step-up-gated write. That is also why this route
 * carries no step-up of its own.
 */
export const importOwnOrgIdpMetadata = withController('Import IdP metadata', async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  const orgId = getParam(req.params, 'id')!;
  if (!(await requireOwnOrgSso(req, res, orgId))) return;
  const body = validateBody(idpMetadataImportSchema, req.body, res);
  if (!body) return;

  const xml = 'url' in body ? await fetchMetadata(body.url) : body.xml;
  const metadata = await parseIdpMetadata(xml);

  audit(req, 'org.idp.metadata.import', {
    targetType: 'org-idp-config',
    targetId: orgId,
    affectedOrgId: orgId,
    details: {
      source: 'url' in body ? 'url' : 'xml',
      ...('url' in body ? { host: new URL(body.url).host } : {}),
      entityId: metadata.entityId,
      certificates: metadata.certificates.length,
    },
  });
  sendSuccess(res, 200, { metadata });
}, METADATA_ERROR_MAP);
