// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  createLogger, exchangeApiKey, getServiceAuthHeader, hasValidIdentityClaims, isAccessTokenRevoked,
  isOpaqueApiKey, isServiceTokenDenied, serviceNameOf, verifyBearerToken, SYSTEM_ORG_ID,
} from '@pipeline-builder/api-core';
import axios from 'axios';
import { z } from 'zod';
import { verifyQuarantineCredential } from './quarantine-credential.js';
import { config } from '../config/index.js';

const logger = createLogger('auth-resolver');

const ORG_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Platform's `/auth/login` reply. Platform answers through api-core's
 * `sendSuccess`, so the tokens sit under the standard envelope's `data` —
 * `{ success: true, statusCode, data: { accessToken, refreshToken, ... } }` —
 * never at the top level.
 */
const PlatformLoginResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({ accessToken: z.string() }),
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
  | {
    type: 'jwt';
    orgId: string;
    userId: string;
    isAdmin: boolean;
    isSuperAdmin: boolean;
    canWritePlugins: boolean;
    /** A team's direct parent org (signed `parentOrganizationId` claim) — grants PULL on its namespace. */
    parentOrgId?: string;
    /**
     * The internal service a SERVICE token names (`sub: service:<name>`, bound to
     * that service's own signing key — see api-core `serviceNameOf`). Absent for
     * every user / service-account token. Gates the `quarantine/*` namespace.
     */
    serviceName?: string;
  }
  /**
   * An anonymous submission's BUILD: the registry-only credential
   * image-registry minted for `quarantine/<submissionId>`. Never a platform
   * principal — it has no org, no user and no permissions.
   */
  | { type: 'quarantine'; submissionId: string }
  | { type: 'management' };

/**
 * Decoded shape of a platform JWT. Mirrors AccessTokenPayload as platform
 * mints it (see platform/src/types/AccessTokenPayload). We don't import
 * platform's type to avoid cross-service coupling — the fields we read are
 * the contractual ones.
 */
export interface PlatformJwtPayload {
  sub: string;
  organizationId?: string;
  /** Set when the active org is a team: its direct parent org (the org whose
   *  `public` plugins the team resolves, see api/plugin read-plugins.ts). */
  parentOrganizationId?: string;
  isAdmin?: boolean;
  isSuperAdmin?: boolean;
  /** Resolved permission ids on the access token — gates raw-namespace push. */
  permissions?: string[];
  /** Per-user version stamp; a bump on the platform revokes older tokens. */
  tokenVersion?: number;
  type?: string;
  /** `service` for an internal caller (api/plugin's builds, the deploy bootstrap push). */
  principalType?: string;
  /** Narrow capability scope on a machine credential. `registry:push` is
   *  the one this resolver honours — see `REGISTRY_PUSH_SCOPE`. */
  scope?: string;
}

/**
 * The capability scope a least-privilege machine credential carries to push
 * images. A scoped token is minted with NO permissions and NO admin flags
 * by design, so `plugins:write` can never appear on one — this is what a CI
 * push identity presents instead, and it grants exactly the same raw-image write
 * inside the owning org's namespace, and nothing else.
 */
const REGISTRY_PUSH_SCOPE = 'registry:push';

/** The only internal service whose token may push plugin images (its own builds). */
export const PLUGIN_PUSH_SERVICE = 'plugin';
/** The deploy scripts' identity (the bootstrap base-image push) — the only service token honoured as a superadmin. */
export const BOOTSTRAP_SERVICE = 'deploy-bootstrap';

/**
 * Whether a verified token may PUSH plugin images into its org's namespace:
 *
 *  - a SERVICE principal: only `plugin` (its own builds), and only with
 *    `plugins:write` (or an admin role) on the token — no other internal
 *    service writes images, whatever permissions its token claims;
 *  - an ORG SERVICE ACCOUNT: `plugins:write`, or the `registry:push` scope —
 *    the CI push identity, which platform mints only while the account's
 *    creator still holds `plugins:write` (I10);
 *  - a USER: `plugins:write` or an admin role. A `registry:push` scope on a
 *    person's key grants nothing here: that scope is the machine credential's.
 */
export function mayPushPlugins(decoded: Pick<PlatformJwtPayload, 'principalType' | 'isAdmin' | 'permissions' | 'scope'>, serviceName: string | undefined): boolean {
  const holdsWrite = !!decoded.isAdmin || (decoded.permissions?.includes('plugins:write') ?? false);
  if (decoded.principalType === 'service') return serviceName === PLUGIN_PUSH_SERVICE && holdsWrite;
  if (decoded.principalType === 'service_account') return holdsWrite || decoded.scope === REGISTRY_PUSH_SCOPE;
  return holdsWrite;
}

/**
 * Resolve incoming `Authorization: Basic <creds>` to a caller identity by
 * trying each path in order:
 *
 *   0. **password as an opaque ACCESS KEY** (`pb_pat_…`) — traded at platform
 *      for a short-lived JWT (cached in-process by api-core), then verified
 *      through Path 1. A key carries no claims and no signature, so it cannot be
 *      verified locally; this is the same exchange every service performs, which
 *      is what makes revoking the key stop `docker push` within 5 minutes.
 *
 *   1. **password as a signed token** — routed by the token's own `alg`, exactly
 *      as every `requireAuth` in the fleet does it:
 *      - a USER token is ES256 and is verified against platform's published
 *        JWKS (api-core's shared cache: 10-minute refresh, one refetch on an
 *        unknown `kid`). This is the path customer CodeBuild and the
 *        plugin-lookup Lambda use.
 *      - an INTERNAL SERVICE token is ES256 signed by the CALLING service with
 *        its own key and verified against the per-service public bundle,
 *        and must declare `principalType: 'service'`. This is the path
 *        `api/plugin` uses for its own image pushes and the one the deploy
 *        scripts use for the `deploy-bootstrap` base-image push.
 *      On success, identity carries the token's `organizationId` + `sub` so
 *      scope authorization can grant `org-{orgId}` access.
 *
 *   2. **platform user** — for direct `docker login`. Posts to platform's
 *      `/auth/login` in-cluster (`PLATFORM_SERVICE_HOST`/`_PORT`) with the
 *      supplied creds; on success the returned JWT carries the same org/admin
 *      claims Path 1 looks for.
 *
 * Returns `null` if all paths fail. Caller should respond 401 in that case.
 */
export async function resolveIdentity(username: string, password: string): Promise<Identity | null> {
  // A quarantine build credential — verified locally, and tried first: it
  // is never a platform token, so no other path could accept it anyway.
  const submissionId = await verifyQuarantineCredential(password);
  if (submissionId) return { type: 'quarantine', submissionId };

  // Path 0: opaque access key — exchange it, then fall into Path 1 on the
  // result. A key is recognised by its shape, so this never intercepts a JWT.
  if (isOpaqueApiKey(password)) {
    try {
      return await verifyPlatformJwt(await exchangeApiKey(password));
    } catch {
      // Refused or unverifiable: a key has no other path to try (it is not a
      // password), so stop here rather than posting it to /auth/login.
      logger.debug('Access-key exchange did not yield an identity', { ok: false });
      return null;
    }
  }

  // Path 1: JWT — most common (CodeBuild / Lambda via Secrets Manager,
  // and api/plugin minting service tokens for its own pushes).
  const fromJwt = await verifyPlatformJwt(password);
  if (fromJwt) return fromJwt;

  // Path 2: platform user — `docker login` flow.
  return resolvePlatformUser(username, password);
}

/**
 * Verify a platform JWT and project it onto the resolver's identity shape.
 * Returns null on any verification failure (caller falls through to other
 * paths). Logged at debug only — Path 2/3 inputs always fail Path 1.
 *
 * Verification goes through api-core's `verifyUserJwt`, so this resolver gets
 * the same guarantees as every `requireAuth` in the fleet: ES256 only, a `kid`
 * that must resolve to one of platform's published keys, and a `kid` rotation
 * picked up without restarting. Fails CLOSED — an unreachable JWKS yields
 * `null` here, which the caller answers as 401, never as a pass.
 */
async function verifyPlatformJwt(token: string): Promise<Identity | null> {
  try {
    // One entry point for both chains. It also enforces the separation that
    // makes the cutover meaningful: an ES256 token may not claim to be a
    // service, and a shared-secret token may not claim to be a person — so no
    // HS256 token can mint registry credentials for a user any more.
    const decoded = await verifyBearerToken(token) as unknown as PlatformJwtPayload;

    // Defense-in-depth: only an ACCESS token may mint registry credentials.
    // A refresh/step-up/other-typed token — or one with no `type` at all — is
    // refused: every credential the platform mints carries `type: 'access'`, so
    // there is no shape to tolerate here.
    if (decoded.type !== 'access') {
      logger.warn('Rejecting non-access platform JWT on /token mint path', { sub: decoded.sub, type: decoded.type });
      return null;
    }
    if (!decoded.organizationId) {
      // JWT verified but no orgId — token without org context can't be scoped.
      logger.warn('JWT verified but missing organizationId claim', { sub: decoded.sub });
      return null;
    }
    if (!ORG_ID_PATTERN.test(decoded.organizationId)) {
      logger.warn('JWT organizationId failed format validation', { sub: decoded.sub });
      return null;
    }
    // Every token must carry a well-formed identity (`principalType`,
    // `token_use`, and a user principal's assurance claims) — the same check
    // `requireAuth` applies. Fails closed: this resolver branches on
    // `principalType` below, so a token without one is not an identity.
    if (!hasValidIdentityClaims(decoded as Parameters<typeof hasValidIdentityClaims>[0])) {
      logger.warn('Rejecting token with malformed identity claims on /token mint path', { sub: decoded.sub });
      return null;
    }

    if (decoded.principalType === 'service') {
      // An internal service principal (api/plugin's own pushes, the deploy
      // bootstrap). There is no user session behind it to revoke — the
      // equivalent kill-switch is the service denylist, which `requireAuth`
      // honours and so must this out-of-band path.
      if (isServiceTokenDenied(decoded)) {
        logger.warn('Rejecting denylisted service token on /token mint path', { sub: decoded.sub });
        return null;
      }
    } else if (await isAccessTokenRevoked({ sub: decoded.sub, tokenVersion: decoded.tokenVersion })) {
      // Honor token revocation on the /token MINT path too. `/api/images` and
      // `/api/admin` go through `requireAuth` (which consults the revocation store),
      // but this resolver runs outside it — without this check a user whose
      // tokenVersion was bumped (permissions removed / offboarded) could still mint
      // `docker push` tokens until their JWT naturally expires. Fail-open on store
      // outage, matching requireAuth.
      logger.warn('Rejecting revoked platform JWT (tokenVersion behind current)', { sub: decoded.sub });
      return null;
    }
    // A malformed parent id is dropped rather than failing the whole identity:
    // it only ever WIDENS pull, so losing it degrades to own-namespace access.
    const parentOrgId = decoded.parentOrganizationId && ORG_ID_PATTERN.test(decoded.parentOrganizationId)
      ? decoded.parentOrganizationId
      : undefined;
    // Only a SERVICE token names a service; the verifier already bound `sub` to
    // the signing key, so this cannot be claimed by a user token.
    const serviceName = decoded.principalType === 'service' ? serviceNameOf(decoded) : undefined;
    return {
      type: 'jwt',
      orgId: decoded.organizationId,
      ...(parentOrgId ? { parentOrgId } : {}),
      ...(serviceName ? { serviceName } : {}),
      userId: decoded.sub,
      isAdmin: !!decoded.isAdmin,
      // A SERVICE token is a superadmin only as the deploy bootstrap (its
      // base-image push); no other internal service's claim is honoured.
      isSuperAdmin: !!decoded.isSuperAdmin && (decoded.principalType !== 'service' || serviceName === BOOTSTRAP_SERVICE),
      // Push to the org's own namespace (mayPushPlugins): the plugin service's
      // builds, a service account's CI push identity, a plugin-writing person.
      // Pull stays open to all members. Bounded by the namespace rules in
      // `authorizeScope`, which key off `orgId`/`isSuperAdmin`.
      canWritePlugins: mayPushPlugins(decoded, serviceName),
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
 * Returns null on auth failure (4xx), on a second-factor challenge (a password
 * alone is not a credential for such an account, and Basic auth has no way to
 * carry a code — those users push with an access key), or any error reaching
 * platform; the caller responds 401. Errors are logged at warn level so
 * operators can see when platform is unreachable mid-`docker login`.
 */
async function resolvePlatformUser(identifier: string, password: string): Promise<Identity | null> {
  try {
    const response = await axios.post<unknown>(
      `http://${config.platformService.host}:${config.platformService.port}/auth/login`,
      { identifier, password },
      {
        timeout: 5000,
        // Identify the relay as a service, so platform's per-IP login limiter
        // doesn't pool every user's attempts under this pod's IP. This service
        // rate-limits by client and username before it gets here.
        headers: { authorization: getServiceAuthHeader({ serviceName: 'image-registry', orgId: SYSTEM_ORG_ID, role: 'member' }) },
        // Treat any non-2xx as a failed lookup; we don't want axios to throw
        // an error whose `.message` could interpolate the request body
        // (which contains the user's password).
        validateStatus: () => true,
      },
    );
    if (response.status < 200 || response.status >= 300) return null;
    // An account with a second factor gets a CHALLENGE, not a session: platform
    // answers `{ mfaRequired: true, challengeId }` with no token. `docker login`
    // has nowhere to enter a code, so this is a legitimate refusal rather than a
    // protocol mismatch — named explicitly so the operator log says what to do
    // (use an access key) instead of "shape mismatch".
    if ((response.data as { data?: { mfaRequired?: boolean } })?.data?.mfaRequired === true) {
      logger.warn('Platform login needs a second factor; docker login cannot supply one — use an access key', {
        event: 'platform_login_mfa_required',
        identifier,
      });
      return null;
    }
    const parsed = PlatformLoginResponseSchema.safeParse(response.data);
    if (!parsed.success) {
      logger.warn('Platform login response shape mismatch', {
        event: 'platform_login_shape_mismatch',
        identifier,
      });
      return null;
    }
    return await verifyPlatformJwt(parsed.data.data.accessToken);
  } catch {
    // Never interpolate err.message — axios error messages can include the
    // outbound request body, which contains the user's password.
    logger.warn('Platform login lookup failed', { identifier, ok: false });
    return null;
  }
}
