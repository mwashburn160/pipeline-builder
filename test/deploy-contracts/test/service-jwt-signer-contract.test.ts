// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `sign_service_jwt` (deploy/bin/common.sh) mints the `deploy-bootstrap`
 * service token the deploy scripts push base images with. Its private key lives
 * on the operator / CI host, OUTSIDE the cluster, and its public half is in the
 * bundle every service mounts — so whatever this token claims, every service
 * would once have believed. It used to claim `isSuperAdmin: true`,
 * `isAdmin: true` and `role: admin`, making a deploy credential a fleet-wide
 * superadmin.
 *
 * The contract now: least privilege, the same shape api-core's
 * `signServiceToken` mints — no superadmin, no admin role, an explicit
 * `permissions` claim the CALLER names, a per-mint `jti`, a 300s default TTL.
 * The signer is executed for real (with a throwaway key) and its signature
 * verified, so what is pinned is what the deploy produces.
 */

import { spawnSync } from 'child_process';
import crypto from 'crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { REPO_ROOT, read } from '../src/index.js';

const COMMON = join(REPO_ROOT, 'deploy/bin/common.sh');

let dir: string;
let keyFile: string;
let bundleFile: string;
let publicKey: crypto.KeyObject;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'pb-sign-jwt-'));
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  publicKey = pair.publicKey;
  keyFile = join(dir, 'deploy-bootstrap.key');
  bundleFile = join(dir, 'bundle.json');
  writeFileSync(keyFile, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string);
  writeFileSync(bundleFile, JSON.stringify({ services: { 'deploy-bootstrap': { keys: [{ kid: 'test-kid' }] } } }));
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Run `sign_service_jwt` with the given trailing args (after key + bundle). */
function sign(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  // Single-quote each arg for bash, closing the quote around any embedded one.
  const quoted = args.map((a) => `'${a.split('\'').join('\'\\\'\'')}'`).join(' ');
  const r = spawnSync('bash', ['-c', `. "${COMMON}"; sign_service_jwt "${keyFile}" "${bundleFile}" ${quoted}`], { encoding: 'utf-8' });
  return { status: r.status, stdout: r.stdout.trim(), stderr: r.stderr };
}

function decode(token: string): { header: Record<string, unknown>; payload: Record<string, unknown>; signatureOk: boolean } {
  const [h, p, s] = token.split('.');
  return {
    header: JSON.parse(Buffer.from(h!, 'base64url').toString('utf-8')) as Record<string, unknown>,
    payload: JSON.parse(Buffer.from(p!, 'base64url').toString('utf-8')) as Record<string, unknown>,
    signatureOk: crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s!, 'base64url')),
  };
}

describe('sign_service_jwt — the deploy-bootstrap token is least-privilege', () => {
  it('mints a valid ES256 token for service:deploy-bootstrap', () => {
    const r = sign('plugins:write');
    expect(r.status).toBe(0);
    const { header, payload, signatureOk } = decode(r.stdout);
    expect(signatureOk).toBe(true);
    expect(header).toEqual({ alg: 'ES256', typ: 'JWT', kid: 'test-kid' });
    expect(payload).toMatchObject({
      sub: 'service:deploy-bootstrap',
      principalType: 'service',
      token_use: 'access',
      type: 'access',
      organizationId: 'system',
    });
  });

  it('asserts no superadmin and no admin role', () => {
    const { payload } = decode(sign('plugins:write').stdout);
    expect(payload).not.toHaveProperty('isSuperAdmin');
    expect(payload).not.toHaveProperty('isAdmin');
    expect(payload.role).toBe('member');
  });

  it('carries exactly the permissions the caller names', () => {
    expect(decode(sign('plugins:write').stdout).payload.permissions).toEqual(['plugins:write']);
    expect(decode(sign('plugins:write,registry:read').stdout).payload.permissions).toEqual(['plugins:write', 'registry:read']);
  });

  it('stamps a fresh jti on every mint', () => {
    const a = decode(sign('plugins:write').stdout).payload.jti;
    const b = decode(sign('plugins:write').stdout).payload.jti;
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(b).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });

  it('defaults to a 300s TTL and honours an explicit one', () => {
    const d = decode(sign('plugins:write').stdout).payload;
    expect((d.exp as number) - (d.iat as number)).toBe(300);
    const e = decode(sign('plugins:write', '900').stdout).payload;
    expect((e.exp as number) - (e.iat as number)).toBe(900);
  });

  it('refuses to sign without permissions, or with a malformed one', () => {
    expect(sign().status).not.toBe(0);
    for (const bad of ['plugins', 'plugins:write"}', 'a:b,"isSuperAdmin":true', ' plugins:write']) {
      const r = sign(bad);
      expect([bad, r.status, r.stdout]).toEqual([bad, 1, '']);
    }
    expect(sign('plugins:write', '30s').status).toBe(1);
  });
});

describe('sign_service_jwt callers', () => {
  it.each(['deploy/bin/build-plugin-images.sh', 'deploy/bin/push-base-images.sh'])('%s asks for plugins:write and nothing broader', (f) => {
    const calls = [...read(f).matchAll(/sign_service_jwt\s+("[^"]*"\s+"[^"]*")\s+([^\s)"]+)/g)];
    expect(calls.length).toBeGreaterThan(0);
    for (const m of calls) expect(m[2]).toBe('plugins:write');
  });

  it('no deploy script hand-writes an admin claim into a token', () => {
    expect(read('deploy/bin/common.sh')).not.toMatch(/"isSuperAdmin"\s*:\s*true|"isAdmin"\s*:\s*true|"role"\s*:\s*"admin"/);
  });
});
