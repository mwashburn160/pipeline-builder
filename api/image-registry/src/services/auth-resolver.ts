// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger } from '@pipeline-builder/api-core';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { config } from '../config/index.js';

const logger = createLogger('auth-resolver');

const ORG_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

const PlatformLoginResponseSchema = z.object({
  accessToken: z.string(),
});

/**
 * Caller identity. The `jwt` variant is produced by `resolveIdentity` from
 * incoming Basic auth (the password is verified as a platform JWT — both
 * the Bearer-as-password path and the `docker login` → /auth/login round
 * trip end up here). `management` is constructed directly in-process by
 * `registry-client` for image-registry's own outbound calls and is NOT
 * producible via any external auth path.
 */
export type Identity =
  | { type: 'jwt'; orgId: string; userId: string; isAdmin: boolean; isSuperAdmin: boolean }
  | { type: 'management' };

/**
 * Decoded shape of a platform JWT. Mirrors AccessTokenPayload as platform
 * mints it (see platform/src/types/AccessTokenPayload). We don't import
 * platform's type to avoid cross-service coupling — the fields we read are
 * the contractual ones.
 */
interface PlatformJwtPayload {
  sub: string;
  organizationId?: string;
  isAdmin?: boolean;
  isSuperAdmin?: boolean;
  type?: string;
}

/**
 * Resolve incoming `Authorization: Basic <creds>` to a caller identity by
 * trying each path in order:
 *
 *   1. **password as platform JWT** — verifies signature with platform's
 *      `JWT_SECRET`. On success, identity carries the JWT's `organizationId`
 *      + `sub` so scope authorization can grant `org-{orgId}` access.
 *      This is the path customer CodeBuild, the plugin-lookup Lambda, and
 *      `api/plugin` (during plugin uploads) all use.
 *
 *   2. **platform user** — for direct `docker login`. Posts to platform's
 *      `/auth/login` with the supplied creds; on success the returned JWT
 *      carries the same org/admin claims Path 1 looks for. Disabled when
 *      `PLATFORM_BASE_URL` is unset.
 *
 * Returns `null` if all paths fail. Caller should respond 401 in that case.
 */
export async function resolveIdentity(username: string, password: string): Promise<Identity | null> {
  // Path 1: JWT — most common (CodeBuild / Lambda via Secrets Manager,
  // and api/plugin minting service tokens for its own pushes).
  const fromJwt = verifyPlatformJwt(password);
  if (fromJwt) return fromJwt;

  // Path 2: platform user — `docker login` flow.
  if (config.platformUrl) {
    return resolvePlatformUser(username, password);
  }
  return null;
}

/**
 * Verify a platform JWT and project it onto the resolver's identity shape.
 * Returns null on any verification failure (caller falls through to other
 * paths). Logged at debug only — Path 2/3 inputs always fail Path 1.
 */
function verifyPlatformJwt(token: string): Identity | null {
  try {
    const decoded = jwt.verify(token, config.platformJwt.secret, {
      ...(config.platformJwt.issuer && { issuer: config.platformJwt.issuer }),
      ...(config.platformJwt.audience && { audience: config.platformJwt.audience }),
    }) as PlatformJwtPayload;

    if (!decoded.organizationId) {
      // JWT verified but no orgId — token without org context can't be scoped.
      logger.warn('JWT verified but missing organizationId claim', { sub: decoded.sub });
      return null;
    }
    if (!ORG_ID_PATTERN.test(decoded.organizationId)) {
      logger.warn('JWT organizationId failed format validation', { sub: decoded.sub });
      return null;
    }
    return {
      type: 'jwt',
      orgId: decoded.organizationId,
      userId: decoded.sub,
      isAdmin: !!decoded.isAdmin,
      isSuperAdmin: !!decoded.isSuperAdmin,
    };
  } catch {
    // Error contents may include the raw decode string (which is the user's
    // Basic-auth password) — never log it.
    logger.debug('Password is not a verifiable JWT', { ok: false });
    return null;
  }
}

/**
 * Forward Basic-auth creds to platform's `/auth/login`. On success, the
 * returned access token is itself a platform JWT — verify it through the
 * same Path 1 codepath so we get a single identity-projection contract.
 *
 * Returns null on auth failure (4xx) or any error reaching platform; the
 * caller responds 401. Errors are logged at warn level so operators can
 * see when platform is unreachable mid-`docker login`.
 */
async function resolvePlatformUser(identifier: string, password: string): Promise<Identity | null> {
  try {
    const response = await axios.post<unknown>(
      `${config.platformUrl.replace(/\/$/, '')}/auth/login`,
      { identifier, password },
      {
        timeout: 5000,
        // Treat any non-2xx as a failed lookup; we don't want axios to throw
        // an error whose `.message` could interpolate the request body
        // (which contains the user's password).
        validateStatus: () => true,
      },
    );
    if (response.status < 200 || response.status >= 300) return null;
    const parsed = PlatformLoginResponseSchema.safeParse(response.data);
    if (!parsed.success) {
      logger.warn('Platform login response shape mismatch', {
        event: 'platform_login_shape_mismatch',
        identifier,
      });
      return null;
    }
    return verifyPlatformJwt(parsed.data.accessToken);
  } catch {
    // Never interpolate err.message — axios error messages can include the
    // outbound request body, which contains the user's password.
    logger.warn('Platform login lookup failed', { identifier, ok: false });
    return null;
  }
}
