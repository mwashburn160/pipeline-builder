// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Lambda handler that re-mints the platform JWT in Secrets Manager so it never
 * lapses. Deployed + scheduled by `pipeline-manager store-token` (default once a
 * day). Self-contained on purpose — only `@aws-sdk/client-secrets-manager` (which
 * the Lambda Node runtime provides) and node built-ins — so it can be zipped and
 * uploaded as a single file with no bundling.
 *
 * Each run: read the secret's current JWT → ask the platform for a fresh
 * long-lived token (`/api/user/generate-token`, falling back to `/auth/refresh`
 * if the current token has expired) → write it back in store-token's schema.
 * The new token is validated before it overwrites the still-valid one.
 *
 * Env: PLATFORM_SECRET_NAME, PLATFORM_BASE_URL, RENEW_DAYS (default 30).
 */
import { request as httpsRequest } from 'node:https';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

interface SecretPayload {
  username?: string;
  password?: string;       // the platform JWT
  refreshToken?: string;
  platformUrl?: string;
  [k: string]: unknown;
}

interface TokenResponse {
  accessToken?: string;
  refreshToken?: string;
  expiresIn?: number;
}

/** Minimal JSON POST. Honours NODE_TLS_REJECT_UNAUTHORIZED via the node runtime. */
function postJson(url: string, body: unknown, bearer?: string): Promise<{ status: number; json: unknown }> {
  const u = new URL(url);
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        method: 'POST',
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        },
        timeout: 20_000,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json: unknown = undefined;
          try { json = data ? JSON.parse(data) : undefined; } catch { /* leave undefined */ }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.write(payload);
    req.end();
  });
}

/** Unwrap the platform's `{ success, data: {...} }` envelope (or a bare body). */
function unwrap<T>(json: unknown): T {
  const j = json as { data?: T } | T;
  return ((j as { data?: T })?.data ?? j) as T;
}

/** Basic JWT sanity: decodes, must carry an org and a future `exp`. */
function looksValid(jwt: string): boolean {
  const parts = jwt.split('.');
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf-8')) as { exp?: number; organizationId?: string };
    if (!payload.exp || payload.exp * 1000 <= Date.now()) return false;
    return typeof payload.organizationId === 'string';
  } catch {
    return false;
  }
}

export const handler = async (): Promise<void> => {
  const secretName = required('PLATFORM_SECRET_NAME');
  const platformUrl = required('PLATFORM_BASE_URL').replace(/\/$/, '');
  const days = parseInt(process.env.RENEW_DAYS || '30', 10);
  const expiresIn = days * 24 * 60 * 60;
  const region = process.env.AWS_REGION;

  const sm = new SecretsManagerClient({ region });
  const current = await sm.send(new GetSecretValueCommand({ SecretId: secretName }));
  if (!current.SecretString) throw new Error(`Secret "${secretName}" is empty`);
  const secret = JSON.parse(current.SecretString) as SecretPayload;
  if (!secret.password) throw new Error(`Secret "${secretName}" missing password (JWT)`);

  // 1. Try generate-token with the current JWT.
  let bearer = secret.password;
  let res = await postJson(`${platformUrl}/api/user/generate-token`, { expiresIn }, bearer);

  // 2. If unauthorized, refresh the access token first, then retry.
  if (res.status === 401 && secret.refreshToken) {
    const refreshed = unwrap<TokenResponse>(
      (await postJson(`${platformUrl}/auth/refresh`, { refreshToken: secret.refreshToken })).json,
    );
    if (refreshed.accessToken) {
      bearer = refreshed.accessToken;
      res = await postJson(`${platformUrl}/api/user/generate-token`, { expiresIn }, bearer);
    }
  }

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`generate-token failed (HTTP ${res.status})`);
  }

  const token = unwrap<TokenResponse>(res.json);
  if (!token.accessToken || !looksValid(token.accessToken)) {
    // Do NOT overwrite a still-valid secret with a bad response.
    throw new Error('generate-token returned no usable access token; leaving existing secret untouched');
  }

  // 3. Write the renewed secret in store-token's schema.
  const actualExpiresIn = token.expiresIn ?? expiresIn;
  const next: SecretPayload = {
    username: secret.username,
    password: token.accessToken,
    ...(token.refreshToken ? { refreshToken: token.refreshToken } : (secret.refreshToken ? { refreshToken: secret.refreshToken } : {})),
    platformUrl: secret.platformUrl ?? platformUrl,
    expiresIn: actualExpiresIn,
    expiresAt: new Date(Date.now() + actualExpiresIn * 1000).toISOString(),
    createdAt: new Date().toISOString(),
  };
  await sm.send(new PutSecretValueCommand({ SecretId: secretName, SecretString: JSON.stringify(next) }));

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ level: 'INFO', msg: 'platform token renewed', secretName, expiresAt: next.expiresAt }));
};

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} environment variable is required`);
  return v;
}
