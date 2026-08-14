// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { sendError, ErrorCode, createLogger } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';
import { config } from '../config/index.js';
import { resolveIdentity } from '../services/auth-resolver.js';
import { checkTokenRateLimit, rateLimitKey } from '../services/token-rate-limiter.js';
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
 * Docker registry token endpoint per the Distribution token-auth spec.
 *
 *   GET /token?service=...&scope=...&account=...
 *   Authorization: Basic <b64(user:pass)>
 *
 *   200 OK
 *   { "token": "<JWT>", "access_token": "<JWT>", "expires_in": 300, "issued_at": "..." }
 *
 *   401 Unauthorized
 *   WWW-Authenticate: Basic realm="pipeline-image-registry"
 *
 * The `expires_in` and `issued_at` are advisory; the registry decides validity
 * by verifying the JWT itself. Both `token` and `access_token` carry the same
 * value — older Docker clients use `token`, newer ones expect `access_token`.
 */
export function createTokenRoute(): Router {
  const router = Router();

  router.get('/', withRoute(async ({ req, res, ctx }) => {
    const basic = parseBasic(req.headers.authorization);
    if (!basic) {
      res.setHeader('WWW-Authenticate', 'Basic realm="pipeline-image-registry"');
      sendError(res, 401, 'Authentication required', ErrorCode.UNAUTHORIZED);
      return;
    }

    // Rate-limit on a COARSE (source-ip, username) key — never the password —
    // so a credential-stuffing client that varies the password shares ONE
    // bucket and the cap actually engages. `req.ip` may be undefined behind a
    // misconfigured proxy; fall back to a constant so those requests still
    // share a (username-scoped) bucket rather than each getting a fresh one.
    const sourceIp = req.ip || 'unknown';
    if (!(await checkTokenRateLimit(rateLimitKey(sourceIp, basic.username)))) {
      sendError(res, 429, 'Too many token requests; slow down.', ErrorCode.RATE_LIMIT_EXCEEDED);
      return;
    }

    const identity = await resolveIdentity(basic.username, basic.password);
    if (!identity) {
      res.setHeader('WWW-Authenticate', 'Basic realm="pipeline-image-registry"');
      sendError(res, 401, 'Invalid credentials', ErrorCode.UNAUTHORIZED);
      return;
    }

    const scopes = collectScopes(req.query.scope);

    // No scope requested → issue an empty-scope token. This is valid per
    // spec — Docker login probes /token without a scope to verify creds.
    const account =
      typeof req.query.account === 'string' ? req.query.account : basic.username;
    const { token, accessCount } = await authorizeAndIssue(identity, scopes, account);

    // Sanity check: a scope-less request is the docker-login probe and must
    // produce an empty access claim. Any other combination indicates a bug
    // in the authorizer — surface it as a warn for the operator dashboard.
    if (scopes.length === 0 && accessCount !== 0) {
      logger.warn('Empty-scope token request produced non-empty access claim', {
        identityType: identity.type, accessCount,
      });
    }

    const issuedAt = new Date();
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
