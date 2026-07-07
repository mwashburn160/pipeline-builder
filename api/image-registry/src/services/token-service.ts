// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'crypto';
import { createLogger, createQuotaService, getServiceAuthHeader } from '@pipeline-builder/api-core';
import jwt from 'jsonwebtoken';
import type { Identity } from './auth-resolver.js';
import { computeStorageUsage } from './storage-usage.js';
import { config } from '../config/index.js';

const logger = createLogger('token-service');

/** A parsed scope from the registry's challenge — one resource + actions. */
export interface RequestedScope {
  type: string;
  name: string;
  actions: string[];
}

/** A scope as it appears in the issued JWT's `access` claim (per Distribution token spec). */
interface AccessClaim {
  type: string;
  name: string;
  actions: string[];
}

/**
 * Parse a `scope` query parameter from the registry's auth challenge.
 * Format: `<type>:<name>:<actions>` where actions is comma-separated.
 *
 * repository:foo:pull → { type: 'repository', name: 'foo', actions: ['pull'] }
 * repository:org/bar:pull,push → { type: 'repository', name: 'org/bar', actions: ['pull', 'push'] }
 *
 * Multiple scopes can appear in a single request (`?scope=...&scope=...`);
 * each is parsed independently.
 */
export function parseScope(raw: string): RequestedScope | null {
  // Repository names may contain `/`; split into exactly 3 parts: type,
  // everything-up-to-last-colon, last-colon-onwards. Don't naively split on `:`.
  const lastColon = raw.lastIndexOf(':');
  if (lastColon === -1) return null;
  const firstColon = raw.indexOf(':');
  if (firstColon === lastColon) return null;
  const type = raw.slice(0, firstColon);
  const name = raw.slice(firstColon + 1, lastColon);
  const actions = raw.slice(lastColon + 1).split(',').filter(Boolean);
  if (!type || !name || actions.length === 0) return null;
  return { type, name, actions };
}

/** Constants for repo namespace policy. */
export const SYSTEM_NAMESPACE_PREFIX = 'system/';
export const ORG_NAMESPACE_PREFIX = 'org-';
/**
 * The org id that OWNS the un-prefixed `system/*` namespace. System sample
 * plugins are built and pushed under this org id and land in `system/<name>`
 * rather than `org-<id>/<name>` (see api/plugin docker-build.ts `resolveImage`
 * — this MUST stay in lock-step with that mapping). A token scoped to this org
 * may push to `system/*`, exactly as a tenant org pushes to its `org-{id}/*`.
 */
export const SYSTEM_ORG_ID = 'system';
// Docker's convention for unqualified base images: `FROM ubuntu` →
// `docker.io/library/ubuntu`. Our buildkit mirror redirects those
// lookups at `registry:5000/library/<name>`, so plugin Dockerfiles
// using bare `FROM pipeline-plugin-base:24.04` end up requesting a
// `library/...` pull token. Treat library/* like system/* — any
// authenticated identity can pull, only admins can push.
export const LIBRARY_NAMESPACE_PREFIX = 'library/';

/**
 * Authorize a single requested scope for the given identity. Returns the
 * subset of actions that are granted (may be empty, in which case the spec
 * permits issuing a token with no `access` entries — the registry will
 * deny the operation).
 *
 * Policy * - **management** (internal only): anything; in-process self-issue
 * - **jwt** (org user / api/plugin service token): pull on `system/*`;
 * pull,push on `org-{orgId}/*`; pull,push on `system/*` ONLY for the system
 * org (which owns that namespace); only super-admins (platform sysadmin) push
 * on any other namespace (e.g. cross-org or `library/*`)
 */
export function authorizeScope(identity: Identity, requested: RequestedScope): string[] {
  // Internal management identity bypasses scope-type filtering — it needs
  // both `repository:*` (manifests/blobs) and `registry:catalog:*` access
  // for the underlying registry's management API.
  if (identity.type === 'management') {
    return requested.actions;
  }

  if (requested.type !== 'repository') {
    // Distribution defines `repository` and `registry` types; other types
    // are extension. External callers only get `repository` scopes.
    return [];
  }

  const orgPrefix = `${ORG_NAMESPACE_PREFIX}${identity.orgId}/`;

  // SUPER-admins (platform sysadmin, e.g. the bootstrap base-image push)
  // get pull+push on any repo. Evaluated first because the namespace rules
  // below would otherwise downgrade a cross-namespace push to system/* or
  // library/* into pull-only — which breaks the bootstrap base-image push
  // and any operator-driven system seeding. Gated on the USER-level
  // `isSuperAdmin` claim, NOT the org-level `isAdmin` (owner/admin role):
  // an org admin must not be able to push into another org's namespace or
  // overwrite system/library base images. Org admins still get pull+push on
  // their OWN `org-{orgId}/*` via the namespace rule below.
  if (identity.isSuperAdmin) {
    return requested.actions.filter((a) => ['pull', 'push'].includes(a));
  }

  // The system org OWNS the `system/*` namespace — the un-prefixed analog of
  // `org-{orgId}/*`. A token scoped to the system org may pull+push there (this
  // is how system sample plugins are built and published; see docker-build.ts).
  // Evaluated before the generic `system/*` pull-only rule below so the push
  // isn't downgraded. NOT a cross-org grant: a tenant token carries its real
  // orgId, so it never matches here and still only owns its own `org-{id}/*`.
  if (identity.orgId === SYSTEM_ORG_ID && requested.name.startsWith(SYSTEM_NAMESPACE_PREFIX)) {
    return requested.actions.filter((a) => ['pull', 'push'].includes(a));
  }

  // Anyone authenticated can pull system images
  if (requested.name.startsWith(SYSTEM_NAMESPACE_PREFIX)) {
    return requested.actions.filter((a) => a === 'pull');
  }

  // Same for library/* — base images that plugin Dockerfiles depend on
  // via bare `FROM <name>` references.
  if (requested.name.startsWith(LIBRARY_NAMESPACE_PREFIX)) {
    return requested.actions.filter((a) => a === 'pull');
  }

  // Org-prefixed repo: only the matching org can pull/push.
  if (requested.name.startsWith(orgPrefix)) {
    return requested.actions.filter((a) => ['pull', 'push'].includes(a));
  }

  return [];
}

/**
 * Build the JWT `x5c` header value from the signing certificate PEM: a JSON array of
 * base64 (standard, not base64url) DER certs, leaf first. Docker Distribution v3
 * verifies a token by chaining the JWT's `x5c` leaf cert to a cert in its
 * `rootcertbundle` (this same self-signed cert); it dropped the older libtrust `kid`
 * scheme. Each PEM CERTIFICATE block's body is already the base64 DER, so we split on
 * the blocks (a rotation bundle may hold several) and strip markers + whitespace from
 * each. Throws if the PEM carries no certificate — a bare public key or empty secret
 * fails fast at startup instead of silently shipping a malformed x5c that the registry
 * rejects on every token. Computed once at startup.
 */
function certsToX5c(pem: string): string[] {
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
  if (!blocks?.length) {
    throw new Error(
      'REGISTRY_TOKEN_CERTIFICATE must be an x509 certificate PEM (no CERTIFICATE block found) — '
        + 'registry v3 verifies the token via its x5c cert chain, not a bare public key.',
    );
  }
  return blocks.map((b) => b.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, ''));
}
const x5c = certsToX5c(config.tokenSigning.certificatePem);

logger.info('Initialized token service', { issuer: config.tokenSigning.issuer });

/**
 * Mint a registry token for the given identity + granted access claims. Signed with
 * the configured private key; the header carries the `x5c` cert chain so Docker
 * Distribution v3 verifies it against its `rootcertbundle`.
 */
export function issueRegistryToken( identity: Identity,
  access: AccessClaim[],
  account: string,
): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: config.tokenSigning.issuer,
    sub: identity.type === 'management'
      ? 'management'
      : `${identity.orgId}:${identity.userId}`,
    aud: config.tokenSigning.service,
    exp: now + config.tokenSigning.expiresInSeconds,
    nbf: now,
    iat: now,
    jti: randomUUID(),
    access,
    account,
  };

  return jwt.sign(payload, config.tokenSigning.privateKeyPem, {
    algorithm: 'RS256',
    header: { x5c, typ: 'JWT', alg: 'RS256' },
  });
}

/**
 * Lazily-constructed quota service client. Pointed at the platform-wide
 * quota service so push-gate enforcement can read each org's
 * `storageBytes` cap before issuing a token that includes `push` scope.
 * Fail-open semantics on transport errors — matches `checkQuota`
 * middleware in api-server.
 */
const quotaService = createQuotaService();

/**
 * Authorize all requested scopes and issue a registry token. The granted
 * scopes may be a subset of requested (or empty); per the Distribution
 * token spec, the caller will get the appropriate 403 when they retry the
 * registry call with a token that doesn't grant the operation.
 *
 * any granted `push` action on `org-{orgId}/*` is gated on the
 * org's `storageBytes` quota — if measured usage exceeds the limit, push
 * is stripped from that scope's actions (pull stays so existing images
 * remain reachable). Management identities bypass the gate.
 */
export async function authorizeAndIssue( identity: Identity,
  requestedScopes: RequestedScope[],
  account: string,
): Promise<{ token: string; accessCount: number }> {
  const access: AccessClaim[] = [];
  let overBudget: boolean | null = null;
  for (const scope of requestedScopes) {
    let granted = authorizeScope(identity, scope);

    // Storage budget gate. Only relevant when    // 1. We've granted `push` (no point checking on pull-only),
    // 2. The scope is an `org-X/*` repo (system images are platform-managed),
    // 3. The identity is a JWT identity (management bypasses the cap).
    // `overBudget` is computed at most once per token-issuance call.
    // NOTE: gated on `type === 'jwt'` alone — non-jwt management/service tokens
    // already bypass here. Do NOT also exempt `identity.isAdmin`: an org
    // owner/admin is a normal tenant for storage purposes and must not be able to
    // push past their org's storageBytes quota.
    if ( granted.includes('push') &&
      identity.type === 'jwt' &&
      scope.name.startsWith(`${ORG_NAMESPACE_PREFIX}${identity.orgId}/`)
    ) {
      if (overBudget === null) overBudget = await isStorageOverBudget(identity.orgId);
      if (overBudget) {
        granted = granted.filter((a) => a !== 'push');
      }
    }

    if (granted.length > 0) {
      access.push({ type: scope.type, name: scope.name, actions: granted });
    }
  }
  return {
    token: issueRegistryToken(identity, access, account),
    accessCount: access.length,
  };
}

/**
 * When true, the storage push-gate reverts to the old fail-OPEN behavior (a
 * quota-service outage or an inconclusive usage scan allows the push). Default
 * is fail-CLOSED: an unverifiable cap must not silently let over-quota orgs
 * push. Mirrors the `QUOTA_RESERVE_FAIL_OPEN` escape hatch on the reserve path.
 */
const STORAGE_FAIL_OPEN = (process.env.QUOTA_STORAGE_FAIL_OPEN || '').toLowerCase() === 'true';

/**
 * Compare an org's measured registry storage against its `storageBytes` quota.
 * Returns true when the push should be DENIED.
 *
 * Fails CLOSED (deny) when the cap cannot be verified — quota service
 * unreachable, or the usage scan was incomplete (under-counted). A genuine
 * `limit: -1` (unlimited) org is still allowed. Set `QUOTA_STORAGE_FAIL_OPEN=true`
 * to restore the permissive behavior.
 */
async function isStorageOverBudget(orgId: string): Promise<boolean> {
  try {
    const authHeader = getServiceAuthHeader({
      serviceName: 'image-registry',
      orgId,
      orgName: orgId,
      role: 'member',
    });
    const status = await quotaService.check(orgId, 'storageBytes', authHeader);

    // Quota service unreachable / non-ok → the cap is unknown. Deny by default
    // (the `failOpen` sentinel is distinct from a real unlimited reading).
    if (status.failOpen) {
      logger.warn('PUSH_GATE_QUOTA_UNREACHABLE', { orgId, failOpen: STORAGE_FAIL_OPEN });
      return !STORAGE_FAIL_OPEN;
    }

    const limit = status.limit;
    // Genuine unlimited storage (-1) → no enforcement, allow.
    if (typeof limit !== 'number' || limit < 0) return false;

    const usage = await computeStorageUsage(`${ORG_NAMESPACE_PREFIX}${orgId}/`);
    // Under-counted scan → we can't prove the org is under budget. Inconclusive
    // → deny by default rather than allow a possibly-over-cap push.
    if (usage.incomplete) {
      logger.warn('PUSH_GATE_USAGE_INCOMPLETE', { orgId, usageBytes: usage.bytes, limitBytes: limit });
      return !STORAGE_FAIL_OPEN;
    }
    if (usage.bytes >= limit) {
      logger.warn('PUSH_DENIED_OVER_QUOTA', {
        orgId, usageBytes: usage.bytes, limitBytes: limit,
      });
      return true;
    }
    return false;
  } catch (err) {
    // Unexpected failure in the gate itself → fail closed by default.
    logger.warn('Storage-budget check failed', {
      orgId, failOpen: STORAGE_FAIL_OPEN, error: err instanceof Error ? err.message: String(err),
    });
    return !STORAGE_FAIL_OPEN;
  }
}
