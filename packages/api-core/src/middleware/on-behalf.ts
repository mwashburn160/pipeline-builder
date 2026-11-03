// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * ON-BEHALF calls: a service forwarding the end user's own bearer token to a
 * peer, as part of a request that was ALREADY metered where it arrived.
 *
 * The ask agent acts strictly as the calling user — its tools forward the
 * user's token so the peer's tenancy, permission and compliance gates apply as
 * if the user had called them — and pipeline's confirm-placeholder-plugins does
 * the same against the plugin service. Each of those hops is a USER request to
 * the peer, so the peer's `apiCalls` meter billed it: one agent turn was 10-20
 * apiCalls on top of the turn itself (which is metered, and AI-reserved).
 *
 * The marker that waives that second charge has to be something the USER CANNOT
 * PRODUCE, or any member could stop paying for API calls by setting a header.
 * So it is a SIGNED SERVICE TOKEN (the calling service's own ES256 key, the same
 * key material `requireAuth` trusts for service principals), carried in
 * {@link ON_BEHALF_HEADER} beside the user's untouched `Authorization`:
 *
 *  - `type: 'on_behalf'` — never `access`, so the marker is useless as a bearer
 *    token anywhere (`requireAuth` and `verifyServicePrincipal` both demand
 *    `type: 'access'`);
 *  - `obo` + `organizationId` — BOUND to the user and org it vouches for, and
 *    honoured only when both equal the request's verified `req.user`;
 *  - the signer must be on {@link ON_BEHALF_CALLERS} — a service that forwards
 *    user tokens by design — and not on the service-token denylist;
 *  - 120 s TTL, minted per outbound call.
 *
 * What a valid marker changes is narrow: the apiCalls/automationCalls METER and
 * CHECK skip the request (`callQuotaExemption`). Tenancy, permissions, audit and
 * every reservation-gated quota (aiCalls, pipelines, plugins) apply exactly as
 * before — an on-behalf `/generate` still reserves its own aiCalls slot.
 */

import { randomUUID } from 'crypto';
import type { Request } from 'express';
import { issuerAudienceOptions } from './jwt-verify.js';
import { isServiceTokenDenied, serviceNameOf } from './service-tokens.js';
import { currentAuditContext } from '../services/audit-context.js';
import { isServiceKid, signServiceJwt, verifyServiceJwt } from '../services/service-keys.js';
import { decodeJwtHeader } from '../utils/jwk.js';
import { createLogger } from '../utils/logger.js';
import { emitCounter } from '../utils/metric-emitter.js';

const logger = createLogger('on-behalf');

/** The header carrying the signed on-behalf marker (lower-case, as Node reads it). */
export const ON_BEHALF_HEADER = 'x-pb-on-behalf';

/**
 * Services whose on-behalf marker is honoured: the ones that forward a user's
 * token as a matter of design. A marker signed by any other service — valid
 * signature or not — is ignored, so a compromised peer that never forwards user
 * tokens cannot start waiving its tenants' meters.
 */
export const ON_BEHALF_CALLERS: readonly string[] = ['ask', 'pipeline'];

/** Marker lifetime. Minted per outbound call, so it only has to outlive one hop. */
const ON_BEHALF_TTL_SECONDS = 120;

/** The `type` claim that makes the marker unusable as an access token. */
const ON_BEHALF_TOKEN_TYPE = 'on_behalf';

/** Who a marker vouches for. Defaults to the ambient request's verified principal. */
export interface OnBehalfSubject {
  /** The user (`sub`) whose token rides the same request. */
  sub: string;
  /** Their active org. */
  organizationId: string;
}

/**
 * Headers to add beside a forwarded user `Authorization` so the peer does not
 * bill the hop a second time. Mint per call (the marker expires in 120 s).
 *
 * The subject defaults to the ambient audit context's VERIFIED principal (the
 * inbound request this call serves). Returns `{}` — the hop is billed normally,
 * the safe direction — when there is no user principal to vouch for, or when
 * this process cannot sign (no service key).
 */
export function onBehalfHeaders(subject?: OnBehalfSubject): Record<string, string> {
  const principal = subject ?? ambientSubject();
  if (!principal) return {};
  try {
    const token = signServiceJwt(
      {
        type: ON_BEHALF_TOKEN_TYPE,
        principalType: 'service',
        obo: principal.sub,
        organizationId: principal.organizationId,
        jti: randomUUID(),
      },
      { serviceName: process.env.SERVICE_NAME || 'api', expiresInSeconds: ON_BEHALF_TTL_SECONDS, ...issuerAudienceOptions() },
    );
    return { [ON_BEHALF_HEADER]: token };
  } catch (err) {
    logger.debug('On-behalf marker not minted; the peer will meter the hop', { error: String(err) });
    return {};
  }
}

function ambientSubject(): OnBehalfSubject | undefined {
  const user = currentAuditContext()?.principal?.();
  if (!user || user.principalType === 'service' || !user.sub || !user.organizationId) return undefined;
  return { sub: user.sub, organizationId: user.organizationId };
}

/** Memo per request: the meter (on `finish`) and the check (in requireAuth) both ask. */
const verdicts = new WeakMap<Request, string | null>();

/**
 * The internal service that vouched for this request with a VALID on-behalf
 * marker, else `undefined`. Requires the request to be authenticated (`req.user`
 * set by requireAuth) — the marker is only meaningful against a verified user.
 *
 * Every rejection of a PRESENT header is counted on
 * `quota_on_behalf_rejected_total{reason}`: a forged header from a user lands
 * there as `invalid` (no service key signs it), and the request is billed.
 */
export function onBehalfCaller(req: Request): string | undefined {
  const memo = verdicts.get(req);
  if (memo !== undefined) return memo ?? undefined;
  const verdict = verifyMarker(req);
  verdicts.set(req, verdict);
  return verdict ?? undefined;
}

function verifyMarker(req: Request): string | null {
  const raw = req.headers?.[ON_BEHALF_HEADER];
  const token = Array.isArray(raw) ? raw[0] : raw;
  if (!token) return null;
  const reject = (reason: string): null => {
    emitCounter('quota_on_behalf_rejected_total', { reason });
    return null;
  };
  const user = req.user;
  if (!user?.sub || !user.organizationId) return reject('unauthenticated');
  try {
    const header = decodeJwtHeader(token);
    if (!header?.kid || !isServiceKid(header.kid)) return reject('invalid');
    const claims = verifyServiceJwt<{ type?: string; principalType?: string; sub?: string; obo?: string; organizationId?: string }>(
      token, { kid: header.kid, ...issuerAudienceOptions() },
    );
    if (claims.type !== ON_BEHALF_TOKEN_TYPE || claims.principalType !== 'service') return reject('invalid');
    const caller = serviceNameOf(claims);
    if (!caller || isServiceTokenDenied(claims)) return reject('denied');
    if (!ON_BEHALF_CALLERS.includes(caller)) return reject('caller');
    if (claims.obo !== user.sub) return reject('subject');
    if (String(claims.organizationId ?? '').toLowerCase() !== user.organizationId.toLowerCase()) return reject('org');
    return caller;
  } catch {
    return reject('invalid');
  }
}
