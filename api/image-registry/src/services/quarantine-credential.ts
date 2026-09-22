// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The registry-only credential an anonymous submission's build runs with
 *.
 *
 * The quarantine buildkitd executes untrusted code, and a build sees whatever
 * credential its session carries. So the plugin service never hands it a
 * platform token: it asks this service to mint one of these instead — a JWT
 * signed with the registry token key under a DISTINCT audience, naming ONE
 * submission. The token endpoint (auth-resolver) turns it into an identity that
 * may push/pull `quarantine/<thatSubmissionId>` and pull the base-image
 * namespaces, and nothing else; no platform service accepts it (its audience is
 * not theirs, and the registry refuses it as a bearer token for the same
 * reason — it carries no `access` claim for the registry's own audience).
 */

import { createPublicKey, randomUUID } from 'crypto';

import jwt from 'jsonwebtoken';

/** The signing config, loaded on first use (the route module that mints must not need it at import). */
async function signing() {
  return (await import('../config/index.js')).config.tokenSigning;
}

/** The audience that marks a quarantine build credential (never the registry's own `service`). */
export const QUARANTINE_CREDENTIAL_AUDIENCE = 'pb-quarantine-build';
/** Basic-auth username the plugin service writes with the credential (informational). */
export const QUARANTINE_CREDENTIAL_USERNAME = '_quarantine';
/** Longest credential lifetime (a build + scan + smoke test window, with slack). */
export const QUARANTINE_CREDENTIAL_MAX_TTL_SECONDS = 3 * 3600;
/** One lowercase path component — the submission id `quarantine/<id>` is keyed by. */
const SUBMISSION_ID_RE = /^[a-z0-9][a-z0-9-]{0,127}$/;

interface QuarantineClaims {
  sub: string;
  submissionId: string;
}

/** Whether `id` can name a quarantine repository. */
export function isQuarantineSubmissionId(id: string): boolean {
  return SUBMISSION_ID_RE.test(id);
}

/** Mint a credential for `quarantine/<submissionId>`, valid for `ttlSeconds` (clamped to [60, max]). */
export async function mintQuarantineCredential(submissionId: string, ttlSeconds: number): Promise<{ username: string; password: string; expiresAt: string }> {
  if (!isQuarantineSubmissionId(submissionId)) throw new Error('Invalid submission id');
  const config = { tokenSigning: await signing() };
  const ttl = Math.min(QUARANTINE_CREDENTIAL_MAX_TTL_SECONDS, Math.max(60, Math.floor(Number.isFinite(ttlSeconds) ? ttlSeconds : 0)));
  const now = Math.floor(Date.now() / 1000);
  const password = jwt.sign(
    { sub: `quarantine:${submissionId}`, submissionId, jti: randomUUID() } satisfies QuarantineClaims & { jti: string },
    config.tokenSigning.privateKeyPem,
    { algorithm: 'RS256', audience: QUARANTINE_CREDENTIAL_AUDIENCE, issuer: config.tokenSigning.issuer, expiresIn: ttl },
  );
  return { username: QUARANTINE_CREDENTIAL_USERNAME, password, expiresAt: new Date((now + ttl) * 1000).toISOString() };
}

/** Every certificate in the (possibly two-cert, mid-rotation) signing bundle. */
function verificationKeys(certificatePem: string): string[] {
  const blocks = certificatePem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  const keys: string[] = [];
  for (const pem of blocks) {
    try {
      keys.push(createPublicKey(pem).export({ format: 'pem', type: 'spki' }).toString());
    } catch {
      // an unreadable certificate verifies nothing
    }
  }
  return keys;
}

/**
 * The submission a presented password is a quarantine credential for, or null
 * when it is not one (wrong audience, expired, forged, malformed). Local and
 * cheap — the resolver tries it before any network path.
 */
export async function verifyQuarantineCredential(password: string): Promise<string | null> {
  // A JWT has exactly two dots; anything else is some other kind of credential.
  if (password.split('.').length !== 3) return null;
  const { certificatePem, issuer } = await signing();
  for (const key of verificationKeys(certificatePem)) {
    try {
      const claims = jwt.verify(password, key, {
        algorithms: ['RS256'], audience: QUARANTINE_CREDENTIAL_AUDIENCE, issuer,
      }) as Partial<QuarantineClaims>;
      const id = claims.submissionId;
      if (typeof id === 'string' && isQuarantineSubmissionId(id) && claims.sub === `quarantine:${id}`) return id;
      return null;
    } catch {
      // try the next certificate in the bundle
    }
  }
  return null;
}
