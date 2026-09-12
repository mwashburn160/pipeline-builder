// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Drift guard for the deploy-time env contract.
 *
 * `config/index.ts` keys its production guards off `NODE_ENV`: without
 * `production`, a missing `JWT_SECRET` is silently replaced with the literal
 * `'dev-only-insecure-secret'`, a missing `SECRET_ENCRYPTION_KEY` wraps AI
 * provider keys and IdP client secrets under an all-zeros key, and
 * `auth.cookie.secure` resolves false. None of the service images set
 * `NODE_ENV`, so the ONLY thing standing between a deploy and those fallbacks
 * is each target's `.env.example`. That made the guards dead code in every
 * target until 2026-09-12.
 *
 * These assertions are deliberately about the deploy files rather than the
 * config module: the module was always correct — the env that feeds it was not.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

// Jest runs with cwd = `platform/`; these files live at the repo root.
const REPO_ROOT = join(process.cwd(), '..');

/** Every deploy target that builds an app env from a `.env.example`. */
const TARGETS = [
  'deploy/local/docker/.env.example',
  'deploy/local/minikube/.env.example',
  'deploy/aws/eks/.env.example',
  'deploy/aws/ec2/.env.example',
];

/** Uncommented `KEY=value` assignments, last-wins (as `--from-env-file` reads them). */
function parseEnv(relPath: string): Record<string, string> {
  const text = readFileSync(join(REPO_ROOT, relPath), 'utf-8');
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

describe.each(TARGETS)('deploy env contract — %s', (target) => {
  const env = parseEnv(target);

  it('sets NODE_ENV=production so the production secret guards are live', () => {
    expect(env.NODE_ENV).toBe('production');
  });

  it('sets SECRET_ENCRYPTION_KEY (not commented out)', () => {
    // A commented-out key means platform boots with the all-zeros dev key.
    expect(env.SECRET_ENCRYPTION_KEY).toBeDefined();
    expect(env.SECRET_ENCRYPTION_KEY).not.toBe('');
  });

  it('requires JWT_SECRET and REFRESH_TOKEN_SECRET', () => {
    expect(env.JWT_SECRET).toBeDefined();
    expect(env.REFRESH_TOKEN_SECRET).toBeDefined();
  });

  it('pins DB_SSL=false, because NODE_ENV=production would otherwise enable Postgres TLS', () => {
    // Every target runs Postgres without a server certificate. getSslConfig
    // (pipeline-data) defaults SSL ON under NODE_ENV=production, so dropping
    // this line takes the database connection down fleet-wide.
    expect(env.DB_SSL).toBe('false');
  });

  it('leaves the CHANGE_ME secrets for gen-env-secrets.sh to fill', () => {
    // The generator matches on this exact placeholder; renaming it in the
    // .env.example silently ships a literal CHANGE_ME credential.
    for (const key of ['JWT_SECRET', 'REFRESH_TOKEN_SECRET', 'SECRET_ENCRYPTION_KEY']) {
      expect(env[key]).toBe('CHANGE_ME_generate_with_openssl_rand_base64_32');
    }
  });
});

describe('gen-env-secrets.sh', () => {
  const script = readFileSync(join(REPO_ROOT, 'deploy/bin/gen-env-secrets.sh'), 'utf-8');

  it('substitutes every required secret placeholder', () => {
    for (const key of ['JWT_SECRET', 'REFRESH_TOKEN_SECRET', 'SECRET_ENCRYPTION_KEY']) {
      expect(script).toContain(`s|${key}=CHANGE_ME_generate_with_openssl_rand_base64_32|${key}=`);
    }
  });

  it('fails closed when a required placeholder drifts', () => {
    // The guard grep must cover the same keys it substitutes, or a renamed
    // placeholder ships a literal CHANGE_ME and still exits 0.
    const guard = /grep -qE '\^\(([A-Z_|]+)\)=CHANGE_ME'/.exec(script);
    expect(guard).not.toBeNull();
    const guarded = guard![1].split('|');
    expect(guarded).toContain('JWT_SECRET');
    expect(guarded).toContain('REFRESH_TOKEN_SECRET');
    expect(guarded).toContain('SECRET_ENCRYPTION_KEY');
  });
});
