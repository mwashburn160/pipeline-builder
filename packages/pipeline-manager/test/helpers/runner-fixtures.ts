// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** Shared fixtures for the runner tests: an Ed25519 platform key, a signer, a fake JWKS host and SDK fakes. */

import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';

export interface TestKey { kid: string; privateKey: KeyObject; jwk: Record<string, unknown> }

export function makeKey(kid: string): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  return { kid, privateKey, jwk: { ...pub, kid, use: 'sig', alg: 'EdDSA' } };
}

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

export function signJws(key: TestKey, claims: Record<string, unknown>, header: Record<string, unknown> = {}): string {
  const h = b64({ alg: 'EdDSA', typ: 'pb-run+jwt', kid: key.kid, ...header });
  const p = b64(claims);
  const s = cryptoSign(null, Buffer.from(`${h}.${p}`), key.privateKey).toString('base64url');
  return `${h}.${p}.${s}`;
}

export const NOW_MS = Date.UTC(2026, 10, 18, 12, 0, 0);
export const NOW_S = Math.floor(NOW_MS / 1000);

export function claims(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: 'pipeline-builder',
    aud: 'runner-1',
    jti: 'req-1',
    iat: NOW_S,
    exp: NOW_S + 600,
    action: 'start',
    pipelineId: 'pipe-1',
    requestedBy: 'user-1',
    ...over,
  };
}

/** A clock tests can move. */
export function clock(start = NOW_MS) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; }, set: (ms: number) => { t = ms; } };
}

export interface FetchCall { url: string; init?: { method?: string; headers?: Record<string, string>; body?: string; redirect?: string } }

/** A fake fetch routing by URL suffix. */
export function fakeFetch(routes: Record<string, (call: FetchCall) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>>) {
  const calls: FetchCall[] = [];
  const fn = async (url: string, init?: FetchCall['init']) => {
    calls.push({ url, ...(init ? { init } : {}) });
    const key = Object.keys(routes).find((k) => url.endsWith(k) || url.includes(k));
    if (!key) throw new Error(`unexpected fetch ${url}`);
    const r = await routes[key]!({ url, ...(init ? { init } : {}) });
    return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.body };
  };
  return { fn, calls };
}

export interface SentCommand { name: string; input: any; region?: string }

/** A fake SDK client: records every command and answers from `respond`. */
export function fakeSender(respond: (name: string, input: any, region?: string) => unknown, log: SentCommand[] = [], region?: string) {
  return {
    log,
    send: async (cmd: unknown) => {
      const c = cmd as { constructor: { name: string }; input: unknown };
      const entry: SentCommand = { name: c.constructor.name, input: c.input, ...(region ? { region } : {}) };
      log.push(entry);
      const out = respond(entry.name, entry.input, region);
      if (out instanceof Error) throw out;
      return out;
    },
  };
}

export function awsError(name: string, status?: number): Error {
  const e = new Error(name) as Error & { $metadata?: { httpStatusCode?: number } };
  e.name = name;
  if (status) e.$metadata = { httpStatusCode: status };
  return e;
}
