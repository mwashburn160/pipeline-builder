// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Scheduled KEY ROTATOR for the service-account credential in Secrets Manager
 * (#N2). Deployed + scheduled (once a day) by `pipeline-manager infra store-token
 * --schedule`.
 *
 * It used to re-mint a person's machine-session JWT by npm-installing the CLI at
 * runtime and shelling out to `store-token`. There is nothing left to re-mint:
 * the stored credential is an opaque `pb_sa_…` key, and platform rotates it
 * through two small pre-auth endpoints where the KEY ITSELF is the authorization
 * (an unattended machine has no password and cannot step up). So this handler is
 * three HTTP calls and a secret write, with no npm install, no CLI, no `/tmp`.
 *
 * THE ORDER IS THE WHOLE DESIGN. At no point may the secret name a credential
 * that does not work:
 *
 *   1. ROTATE — mint a sibling key on the same account. The current key stays
 *      LIVE. Fail here and the secret is untouched: the old key still works.
 *   2. STORE  — write the new key to the secret. Fail here and the secret still
 *      holds the old key, which is still live; the new key is an orphan that
 *      expires on its own (and the next run's rotate prunes it at the cap).
 *   3. REVOKE — retire the old key, authenticated with the NEW one. Fail here
 *      and BOTH keys work; the credential is healthy and the stale key expires
 *      on its own. Logged at ERROR so it is visible, but it does not fail the
 *      invocation: a retry would rotate again and churn keys for no gain.
 *
 * Revoke-then-create would invert every one of those: a failure after the revoke
 * leaves the deployment with no working credential at all.
 *
 * Env: PLATFORM_SECRET_NAME, RENEW_DAYS (default 30),
 *      PLATFORM_VERIFY_SSL ("false" to disable TLS verification — refused in
 *      production).
 */
import { SecretsManagerClient, GetSecretValueCommand, PutSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { errorMessage } from '@pipeline-builder/api-core';

/** Per-request timeout for the platform calls. */
const HTTP_TIMEOUT_MS = 10_000;

/** Access-key prefixes platform issues. A stored JWT is not one of them. */
const ACCESS_KEY_PREFIXES = ['pb_sa_', 'pb_pat_'];

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} environment variable is required`);
  return v;
}

function log(level: 'INFO' | 'WARN' | 'ERROR', msg: string, data?: Record<string, unknown>): void {
  const line = JSON.stringify({ level, msg, ...data });
  // eslint-disable-next-line no-console
  if (level === 'ERROR') console.error(line); else console.log(line);
}

/** The stored secret, as `store-token` writes it. */
interface StoredCredential {
  username?: string;
  /** The canonical credential field — an opaque `pb_sa_…` key after the cutover. */
  password?: string;
  /** The platform this credential belongs to — `store-token` always writes it. */
  platformUrl: string;
  organizationId?: string;
  serviceAccountId?: string;
  serviceAccountName?: string;
  /** Record id of the key in `password`; what step 3 retires. */
  keyId?: string;
  scope?: string | null;
  expiresIn?: number;
  expiresAt?: string;
  createdAt?: string;
  [key: string]: unknown;
}

/** POST JSON to the platform, returning the parsed body plus the status. */
async function post(
  baseUrl: string,
  route: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: { data?: Record<string, unknown>; message?: string } }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const parsed = await res.json().catch(() => ({})) as { data?: Record<string, unknown>; message?: string };
    return { status: res.status, body: parsed };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * SECURITY: these calls carry a live credential. Refuse to disable TLS
 * verification in production so a MITM can't harvest it. Production is this
 * Lambda's normal mode (the rotation stack sets NODE_ENV=production), so
 * PLATFORM_VERIFY_SSL=false is honored ONLY outside production. This inlines the
 * same `NODE_ENV==='production'` policy as utils/tls.ts#assertSslDisableAllowed
 * (the handler ships as a single self-contained index.mjs and can't import it).
 */
function applyTlsPolicy(): void {
  if (process.env.PLATFORM_VERIFY_SSL !== 'false') return;
  if (process.env.NODE_ENV === 'production') {
    log('WARN', 'Refusing PLATFORM_VERIFY_SSL=false in production (NODE_ENV=production) — TLS verification stays enabled');
    return;
  }
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

export const handler = async (): Promise<void> => {
  const secretName = required('PLATFORM_SECRET_NAME');
  const days = Number(process.env.RENEW_DAYS || '30');
  if (!Number.isFinite(days) || days < 1 || days > 365) {
    throw new Error(`RENEW_DAYS must be between 1 and 365 (got "${process.env.RENEW_DAYS}")`);
  }
  const region = process.env.AWS_REGION || 'us-east-1';

  applyTlsPolicy();

  const sm = new SecretsManagerClient({ region });
  const current = await sm.send(new GetSecretValueCommand({ SecretId: secretName }));
  if (!current.SecretString) throw new Error(`Secret "${secretName}" is empty`);
  const stored = JSON.parse(current.SecretString) as StoredCredential;

  const oldKey = stored.password;
  if (!oldKey) throw new Error(`Secret "${secretName}" missing password (service-account key)`);
  if (!ACCESS_KEY_PREFIXES.some((p) => oldKey.startsWith(p))) {
    throw new Error(
      `Secret "${secretName}" does not hold an opaque service-account key. `
      + 'Re-run "pipeline-manager infra store-token" to reissue it as a key (see docs/runbooks/access-key-cutover.md).',
    );
  }
  // The platform this credential belongs to is recorded IN the secret by
  // `store-token` — the single source of truth.
  if (!stored.platformUrl) throw new Error(`Secret "${secretName}" missing platformUrl`);
  const platformUrl = stored.platformUrl.replace(/\/+$/, '');

  // ── 1. ROTATE — mint the replacement. The old key stays live. ──────────────
  const rotate = await post(platformUrl, '/api/auth/key/rotate', {
    key: oldKey,
    name: `${stored.serviceAccountName || 'rotated'}-${new Date().toISOString().slice(0, 10)}`,
    expiresIn: days * 24 * 60 * 60,
  });
  if (rotate.status < 200 || rotate.status >= 300) {
    throw new Error(
      `Key rotation refused (${rotate.status}): ${rotate.body.message || 'unknown reason'}. `
      + 'The stored key is unchanged and still live.',
    );
  }
  const newKey = rotate.body.data?.key as string | undefined;
  const newKeyId = rotate.body.data?.keyId as string | undefined;
  if (!newKey || !newKeyId) throw new Error('Key rotation returned no replacement key — the stored key is unchanged');
  const pruned = (rotate.body.data?.prunedKeyIds as string[] | undefined) ?? [];
  if (pruned.length > 0) {
    log('WARN', 'Platform retired stale sibling keys to stay under the active-key cap', { secretName, prunedKeyIds: pruned });
  }
  log('INFO', 'Minted the replacement key', { secretName, keyId: newKeyId });

  // ── 2. STORE — the secret now names a live credential. ─────────────────────
  const next: StoredCredential = {
    ...stored,
    password: newKey,
    keyId: newKeyId,
    platformUrl,
    expiresIn: days * 24 * 60 * 60,
    ...(rotate.body.data?.expiresAt ? { expiresAt: rotate.body.data.expiresAt as string } : {}),
    createdAt: new Date().toISOString(),
  };
  await sm.send(new PutSecretValueCommand({ SecretId: secretName, SecretString: JSON.stringify(next) }));
  log('INFO', 'Stored the rotated key', { secretName, keyId: newKeyId });

  // ── 3. REVOKE — retire the predecessor, using the key that replaced it. ────
  // Best-effort by design: the credential is already healthy, and failing the
  // invocation here would only make the next retry rotate again.
  const oldKeyId = stored.keyId;
  if (!oldKeyId) {
    log('WARN', 'Secret recorded no previous keyId — nothing to revoke (it expires on its own)', { secretName });
    return;
  }
  const revoke = await post(platformUrl, '/api/auth/key/revoke', { key: newKey, keyId: oldKeyId })
    .catch((err) => ({ status: 0, body: { message: errorMessage(err) } }));
  if (revoke.status < 200 || revoke.status >= 300) {
    log('ERROR', 'Rotated and stored the new key, but could NOT revoke its predecessor — it stays valid until it expires', {
      secretName, staleKeyId: oldKeyId, status: revoke.status, reason: revoke.body.message,
    });
    return;
  }
  log('INFO', 'Rotation complete', { secretName, keyId: newKeyId, revokedKeyId: oldKeyId });
};
