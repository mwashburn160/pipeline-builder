// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { sendError, sendSuccess } from '@pipeline-builder/api-core';
import type { Request } from 'express';
import { audit } from '../helpers/audit.js';
import { withController } from '../helpers/controller-helper.js';
import { incCounter } from '../observability/metrics.js';
import { apiKeyService } from '../services/index.js';

/**
 * POST /auth/token/exchange
 * Body: `{ key: 'pb_pat_…' }` → `{ accessToken, expiresIn, keyId }`.
 *
 * The one place an opaque access key becomes a verifiable credential. Platform
 * is the only service with the key collection, so every other service trades the
 * key here (once per token lifetime, cached in-process — see api-core's
 * `api-key-exchange.ts`) and then verifies the returned JWT like any other.
 *
 * PRE-AUTH by construction: the key IS the credential, exactly as the password
 * is on `/auth/login`. It is rate-limited twice over (per presented key and per
 * client IP, see routes/auth.ts) and every outcome is audited.
 *
 * The refusal reason is recorded in the audit event but NEVER returned: a caller
 * must not be able to tell "no such key" from "revoked key" from "the org went
 * away".
 */
export const exchangeToken = withController('Exchange access key', async (req, res) => {
  const key = typeof req.body?.key === 'string' ? req.body.key.trim() : '';
  if (!key) return sendError(res, 400, 'key is required', 'INVALID_ACCESS_KEY');

  // `req.ip` (Express `trust proxy`-aware) is the address a service-account
  // key's IP allowlist is checked against: the presenting client for a direct
  // call, or the calling service's address when a peer service exchanges on a
  // client's behalf — see docs/authentication.md for what that means in
  // practice.
  const result = await apiKeyService.exchange(key, req.ip);

  if (!result.ok) {
    incCounter('platform_api_key_exchange_failed_total', { reason: result.reason });
    // Actor is unknown by definition (the key didn't resolve), so this row is
    // attributed to `anonymous` with the client details `audit()` always
    // captures — that IP/UA pair is what an operator pivots on when a scanner
    // starts spraying keys.
    audit(req, 'user.key.exchange.failed', {
      targetType: 'access-key',
      outcome: 'failure',
      details: { reason: result.reason },
    });
    return sendError(res, 401, 'Invalid or revoked access key', 'ACCESS_KEY_INVALID');
  }

  incCounter('platform_api_key_exchange_total', { result: 'success', principal: result.principalType });
  // Attribute the success row to the key's OWNER (the request itself carries no
  // identity until this moment), and record which key was used so "what did key
  // X do" is answerable from the audit log alone. For a service-account key the
  // ACTOR is the account — its id, its name and its `@service-account.invalid`
  // sentinel address — never the person who happened to create it.
  req.user = {
    sub: result.userId,
    email: result.userEmail,
    organizationId: result.organizationId,
  } as typeof req.user;
  audit(req, 'user.key.exchange', {
    targetType: 'access-key',
    targetId: result.keyId,
    details: {
      name: result.keyName,
      principalType: result.principalType,
      ...(result.serviceAccountName ? { serviceAccount: result.serviceAccountName } : {}),
      ...(result.scope ? { scope: result.scope } : {}),
    },
  });

  sendSuccess(res, 200, {
    accessToken: result.accessToken,
    expiresIn: result.expiresIn,
    keyId: result.keyId,
  });
});

/**
 * Attribute a rotation row to the ACCOUNT (the request carries no identity until
 * the key resolves), mirroring what the exchange controller does above.
 */
function attributeToAccount(
  req: Request,
  account: { serviceAccountId: string; serviceAccountName: string; organizationId: string },
): void {
  req.user = {
    sub: account.serviceAccountId,
    email: `${account.serviceAccountName}@service-account.invalid`,
    organizationId: account.organizationId,
  } as typeof req.user;
}

/**
 * POST /auth/key/rotate
 * Body: `{ key: 'pb_sa_…', name?, expiresIn? }` → `{ key, keyId, expiresAt, previousKeyId }`.
 *
 * Self-rotation for unattended machines (#N2). The presented key authorizes the
 * mint of a SIBLING key on the same account — same scope, same IP allowlist, by
 * default the same lifetime — and is deliberately left LIVE: the caller stores
 * the replacement first and only then retires the old one through
 * `/auth/key/revoke`. That ordering is what makes a failure at any step leave a
 * working credential behind.
 *
 * PRE-AUTH by construction (the key is the credential) and rate-limited exactly
 * like the exchange. Only `pb_sa_` keys may rotate: a person's key is managed in
 * the UI behind step-up, and self-rotation would be a step-up bypass.
 */
export const rotateKey = withController('Rotate access key', async (req, res) => {
  const key = typeof req.body?.key === 'string' ? req.body.key.trim() : '';
  if (!key) return sendError(res, 400, 'key is required', 'INVALID_ACCESS_KEY');

  const name = typeof req.body?.name === 'string' && req.body.name.trim() ? req.body.name.trim().slice(0, 100) : undefined;
  let expiresInSeconds: number | undefined;
  if (req.body?.expiresIn !== undefined) {
    expiresInSeconds = parseInt(req.body.expiresIn, 10);
    if (!Number.isFinite(expiresInSeconds)) {
      return sendError(res, 400, 'expiresIn must be a positive integer (seconds)', 'INVALID_EXPIRES_IN');
    }
  }

  const result = await apiKeyService.rotateServiceAccountKey(
    key, { ...(name ? { name } : {}), ...(expiresInSeconds !== undefined ? { expiresInSeconds } : {}) }, req.ip,
  );

  if (!result.ok) {
    incCounter('platform_api_key_rotate_failed_total', { reason: result.reason });
    audit(req, 'org.service-account.key.rotate.failed', {
      targetType: 'access-key',
      outcome: 'failure',
      details: { reason: result.reason },
    });
    // `expiry_invalid` is the caller's mistake, not a credential problem — say
    // so. Every other refusal answers the same 401 as the exchange, so the
    // endpoint can't be used to tell a revoked key from an unknown one.
    if (result.reason === 'expiry_invalid') {
      return sendError(res, 400, 'expiresIn must be between 60 seconds and 365 days', 'INVALID_EXPIRES_IN');
    }
    return sendError(res, 401, 'Invalid or revoked access key', 'ACCESS_KEY_INVALID');
  }

  incCounter('platform_api_key_rotate_total', { result: 'success' });
  attributeToAccount(req, result);
  audit(req, 'org.service-account.key.rotate', {
    targetType: 'service-account',
    targetId: result.serviceAccountId,
    affectedOrgId: result.organizationId,
    details: {
      keyId: result.view.id,
      previousKeyId: result.previousKeyId,
      name: result.view.name,
      expiresAt: result.view.expiresAt,
      scope: result.view.scope,
      // Siblings retired to stay under the active-key cap — normally none; a
      // non-empty list means an earlier rotation never revoked its predecessor.
      prunedKeyIds: result.prunedKeyIds,
    },
  });

  sendSuccess(res, 201, {
    key: result.key,
    keyId: result.view.id,
    previousKeyId: result.previousKeyId,
    expiresAt: result.view.expiresAt,
    scope: result.view.scope,
    prunedKeyIds: result.prunedKeyIds,
  }, 'Key rotated');
});

/**
 * POST /auth/key/revoke
 * Body: `{ key: 'pb_sa_…', keyId }` → `{ revoked: true, alreadyRevoked }`.
 *
 * The second half of a rotation: retire a SIBLING key using the live key that
 * replaced it. Revoking the PRESENTED key is refused (`self_revoke` → 400), so
 * a rotator can never destroy the credential it is holding. Revoking a key that
 * is already gone is idempotent success — the desired end state holds either way,
 * and a retrying rotator must not see a spurious failure.
 */
export const revokeKey = withController('Revoke sibling access key', async (req, res) => {
  const key = typeof req.body?.key === 'string' ? req.body.key.trim() : '';
  const keyId = typeof req.body?.keyId === 'string' ? req.body.keyId.trim() : '';
  if (!key) return sendError(res, 400, 'key is required', 'INVALID_ACCESS_KEY');
  if (!keyId) return sendError(res, 400, 'keyId is required', 'INVALID_KEY_ID');

  const result = await apiKeyService.revokeSiblingKey(key, keyId, req.ip);

  if (!result.ok) {
    incCounter('platform_api_key_rotate_failed_total', { reason: result.reason });
    audit(req, 'org.service-account.key.rotate.failed', {
      targetType: 'access-key',
      targetId: keyId,
      outcome: 'failure',
      details: { reason: result.reason, operation: 'revoke' },
    });
    if (result.reason === 'self_revoke') {
      return sendError(
        res, 400,
        'A key cannot revoke itself here — rotate first, then revoke the old key with the new one',
        'SELF_REVOKE_REFUSED',
      );
    }
    return sendError(res, 401, 'Invalid or revoked access key', 'ACCESS_KEY_INVALID');
  }

  incCounter('platform_api_key_rotate_total', { result: 'revoked' });
  attributeToAccount(req, result);
  audit(req, 'org.service-account.key.revoke', {
    targetType: 'service-account',
    targetId: result.serviceAccountId,
    affectedOrgId: result.organizationId,
    details: { keyId: result.revokedKeyId, alreadyRevoked: result.alreadyRevoked, via: 'self-rotation' },
  });

  sendSuccess(res, 200, { revoked: true, alreadyRevoked: result.alreadyRevoked }, 'Key revoked');
});
