// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'crypto';
import { ANONYMOUS_ACTOR_ID, apiKeyPrefixOf, sendError, ErrorCode, createLogger, recordAudit, SYSTEM_ACTOR_ID, SYSTEM_ORG_ID } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';
import { config } from '../config/index.js';
import { resolveIdentity, type Identity } from '../services/auth-resolver.js';
import type { RegistryScope } from '../services/scope.js';
import { checkTokenRateLimit } from '../services/token-rate-limiter.js';
import { authorizeAndIssue, parseScope, type RequestedScope } from '../services/token-service.js';

const logger = createLogger('token-route');

/** Parse `scope` query — can be string, array, or absent. */
function collectScopes(raw: unknown): RequestedScope[] {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list
    .filter((s): s is string => typeof s === 'string')
    .map(parseScope)
    .filter((s): s is RequestedScope => s !== null);
}

/** Decode an `Authorization: Basic <b64>` header into username + password. */
function parseBasic(header: string | undefined): { username: string; password: string } | null {
  if (!header || !header.startsWith('Basic ')) return null;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf-8');
  const colon = decoded.indexOf(':');
  if (colon === -1) return null;
  return { username: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
}

/**
 * A non-reversible handle for the Basic-auth username on the trail: it may be
 * an email (the `docker login` path), so the raw value never lands there, but
 * repeated failures against one account still correlate.
 */
function usernameHash(username: string): string {
  return createHash('sha256').update(username.toLowerCase()).digest('hex').slice(0, 16);
}

/** Which kind of credential was presented — never the credential itself. */
function credentialKind(password: string): string {
  const keyPrefix = apiKeyPrefixOf(password);
  if (keyPrefix) return `api-key:${keyPrefix}`;
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(password) ? 'jwt' : 'password';
}

/** The trail's actor + org for a resolved identity. */
function identityAttribution(identity: Identity): { actorId: string; orgId: string; details: Record<string, unknown> } {
  if (identity.type === 'jwt') {
    return {
      actorId: identity.userId,
      orgId: identity.orgId,
      details: { identityType: 'jwt', ...(identity.serviceName && { serviceName: identity.serviceName }) },
    };
  }
  if (identity.type === 'quarantine') {
    return { actorId: SYSTEM_ACTOR_ID, orgId: SYSTEM_ORG_ID, details: { identityType: 'quarantine', submissionId: identity.submissionId } };
  }
  return { actorId: SYSTEM_ACTOR_ID, orgId: SYSTEM_ORG_ID, details: { identityType: identity.type } };
}

/**
 * Docker registry token endpoint per the Distribution token-auth spec.
 *
 *   GET /token?service=...&scope=...&account=...
 *   Authorization: Basic <b64(user:pass)>
 *
 * 200 OK
 *   { "token": "<JWT>", "access_token": "<JWT>", "expires_in": 300, "issued_at": "..." }
 *
 *   401 Unauthorized
 *   WWW-Authenticate: Basic realm="pipeline-image-registry"
 *
 * The `expires_in` and `issued_at` are advisory; the registry decides validity
 * by verifying the JWT itself. Both `token` and `access_token` carry the same
 * value — older Docker clients use `token`, newer ones expect `access_token`.
 */
function auditIssuedToken(identity: Identity, access: RegistryScope[], requestedScopes: number, password: string): void {
  const who = identityAttribution(identity);
  recordAudit({
    action: 'registry.token.issue',
    actorId: who.actorId,
    orgId: who.orgId,
    outcome: 'success',
    targetType: 'registry-token',
    ...(access.length === 1 && { targetId: access[0].name }),
    details: {
      ...who.details,
      credential: credentialKind(password),
      requestedScopes,
      granted: access.map((a) => ({ type: a.type, repo: a.name, actions: a.actions })),
      push: access.some((a) => a.actions.includes('push')),
      expiresInSeconds: config.tokenSigning.expiresInSeconds,
    },
  });
}

export function createTokenRoute(): Router {
  const router = Router();

  router.get('/', withRoute(async ({ req, res, ctx }) => {
    const basic = parseBasic(req.headers.authorization);
    if (!basic) {
      res.setHeader('WWW-Authenticate', 'Basic realm="pipeline-image-registry"');
      sendError(res, 401, 'Authentication required', ErrorCode.UNAUTHORIZED);
      return;
    }

    // Rate-limit per source IP AND per (source-ip, username) — never the
    // password — so neither credential stuffing (one user, many passwords) nor
    // password spraying (many users, one password) escapes the cap. `req.ip` may
    // be undefined behind a misconfigured proxy; fall back to a constant so those
    // requests still share buckets rather than each getting a fresh one.
    const sourceIp = req.ip || 'unknown';
    if (!(await checkTokenRateLimit(sourceIp, basic.username))) {
      sendError(res, 429, 'Too many token requests; slow down.', ErrorCode.RATE_LIMIT_EXCEEDED);
      return;
    }

    const identity = await resolveIdentity(basic.username, basic.password);
    if (!identity) {
      // A refused credential on the registry's front door — the brute-force /
      // stolen-key signal. No org is known, so it is recorded under the system
      // org; the username is hashed and the credential reduced to its kind.
      recordAudit({
        action: 'registry.token.issue',
        actorId: ANONYMOUS_ACTOR_ID,
        orgId: SYSTEM_ORG_ID,
        outcome: 'failure',
        targetType: 'registry-token',
        details: { reason: 'invalid-credentials', usernameHash: usernameHash(basic.username), credential: credentialKind(basic.password) },
      });
      res.setHeader('WWW-Authenticate', 'Basic realm="pipeline-image-registry"');
      sendError(res, 401, 'Invalid credentials', ErrorCode.UNAUTHORIZED);
      return;
    }

    const scopes = collectScopes(req.query.scope);

    // No scope requested → issue an empty-scope token. This is valid per
    // spec — Docker login probes /token without a scope to verify creds.
    const account =
      typeof req.query.account === 'string' ? req.query.account : basic.username;
    const { token, accessCount, access } = await authorizeAndIssue(identity, scopes, account);

    // Sanity check: a scope-less request is the docker-login probe and must
    // produce an empty access claim. Any other combination indicates a bug
    // in the authorizer — surface it as a warn for the operator dashboard.
    if (scopes.length === 0 && accessCount !== 0) {
      logger.warn('Empty-scope token request produced non-empty access claim', {
        identityType: identity.type, accessCount,
      });
    }

    const issuedAt = new Date();
    // Every token that GRANTS something is a registry access decision: which
    // repositories, which actions, for whom. The scope-less `docker login`
    // probe grants nothing and stays off the trail (it would be most of it).
    if (accessCount > 0) auditIssuedToken(identity, access ?? [], scopes.length, basic.password);
    ctx.log('COMPLETED', 'Issued registry token', {
      identityType: identity.type,
      scopeCount: scopes.length,
      accessCount,
    });

    res.status(200).json({
      token,
      access_token: token,
      // Advertise the same TTL the JWT actually carries; `expires_in` is
      // what Docker clients use to schedule the next /token fetch, so a
      // hardcoded 300 here would race the real `exp` when an operator
      // overrides REGISTRY_TOKEN_EXPIRES_IN.
      expires_in: config.tokenSigning.expiresInSeconds,
      issued_at: issuedAt.toISOString(),
    });
  }, { requireOrgId: false }));

  return router;
}
