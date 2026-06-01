// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash, createPublicKey, randomUUID } from 'crypto';
import { createLogger, createQuotaService, getServiceAuthHeader } from '@pipeline-builder/api-core';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import type { Identity } from './auth-resolver';
import { computeStorageUsage } from './storage-usage';

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
 * pull,push on `org-{orgId}/*`; admins also push on any org
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

  // Admins get pull+push on any repo. Evaluated first because the
  // namespace rules below would otherwise downgrade an admin push to
  // system/* or library/* into pull-only — which breaks the bootstrap
  // base-image push and any operator-driven system seeding.
  if (identity.isAdmin) {
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
 * Compute the registry-spec `kid` (key ID) for the public-key half of our
 * signing keypair. The Distribution token-auth spec adopted libtrust's
 * format: SHA-256 over the DER-encoded SPKI of the public key, take the
 * first 240 bits, base32-encode (no padding), insert colons every 4 chars.
 *
 * Result looks like: `ABCD:EFGH:IJKL:MNOP:QRST:UVWX:YZ23:4567:ABCD:EFGH:IJKL:MNOP`
 *
 * The registry uses this to look up which trusted public key signed the
 * token. We compute it once at startup and cache it.
 */
/* eslint-disable no-bitwise -- bit-shifts are required for base32 encoding */
function computeLibtrustKid(certPem: string): string {
  const pubKey = createPublicKey(certPem).export({ format: 'der', type: 'spki' });
  const digest = createHash('sha256').update(pubKey).digest();
  const truncated = digest.subarray(0, 30); // 240 bits

  // Base32 alphabet per RFC 4648
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let buffer = 0;
  let out = '';
  for (const b of truncated) {
    buffer = (buffer << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(buffer >> (bits - 5)) & 0b11111];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += ALPHABET[(buffer << (5 - bits)) & 0b11111];
  }
  // Insert `:` every 4 chars
  return (out.match(/.{1,4}/g) ?? []).join(':');
}
/* eslint-enable no-bitwise */

const kid = computeLibtrustKid(config.tokenSigning.certificatePem);
logger.info('Initialized token service', { kid, issuer: config.tokenSigning.issuer });

/**
 * Mint a registry token for the given identity + granted access claims.
 * Signed with the configured private key + libtrust kid so the registry's
 * `rootcertbundle` verifier accepts it.
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
    header: { kid, typ: 'JWT', alg: 'RS256' },
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
    if ( granted.includes('push') &&
      identity.type === 'jwt' &&
      !identity.isAdmin &&
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
 * Compare an org's measured registry storage against its `storageBytes`
 * quota. Returns true when push should be denied. Fail-open on quota-
 * service unreachability so a transient outage doesn't lock writers out
 * of an otherwise-healthy registry.
 */
async function isStorageOverBudget(orgId: string): Promise<boolean> {
  try {
    const authHeader = getServiceAuthHeader({
      serviceName: 'image-registry',
      orgId,
      orgName: orgId,
    });
    const status = await quotaService.check(orgId, 'storageBytes', authHeader);
    const limit = status.limit;
    // Unlimited tier: -1. Quota service unreachable: fail-open sentinel
    // returns limit: -1 too. Either way, no enforcement.
    if (typeof limit !== 'number' || limit < 0) return false;

    const usage = await computeStorageUsage(`${ORG_NAMESPACE_PREFIX}${orgId}/`);
    if (usage.bytes >= limit) {
      logger.warn('PUSH_DENIED_OVER_QUOTA', {
        orgId, usageBytes: usage.bytes, limitBytes: limit,
      });
      return true;
    }
    return false;
  } catch (err) {
    logger.warn('Storage-budget check failed; fail-open', {
      orgId, error: err instanceof Error ? err.message: String(err),
    });
    return false;
  }
}
