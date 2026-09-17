// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Drift guard for the deploy-time env contract.
 *
 * `config/index.ts` keys its production guards off `NODE_ENV`: without
 * `production`, a missing `JWT_SECRET` is silently replaced with the literal
 * `'dev-only-insecure-secret'`, a missing `SECRET_ENCRYPTION_KEY` wraps AI
 * provider keys and IdP client secrets under an all-zeros key. None of the service images set
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

  it('declares every MinIO credential the manifests consume, with no shipped default', () => {
    // minio-secret used to be a literal Secret inside each target's
    // k8s/minio.yaml carrying `minioadmin`/`minioadmin` and predictable
    // `<svc>-svc-secret` keys. That made these .env values INERT — the
    // workloads read the Secret, so changing .env did nothing. The Secret is
    // now built from .env, which means two things must hold per target: the
    // keys exist, and the secret half is a CHANGE_ME placeholder that
    // gen-env-secrets randomises rather than a working default.
    const names = ['MINIO_ROOT_USER', 'MESSAGE_S3_ACCESS_KEY', 'REGISTRY_S3_ACCESS_KEY',
      'LOKI_S3_ACCESS_KEY', 'THANOS_S3_ACCESS_KEY', 'PLUGIN_S3_ACCESS_KEY'];
    const secrets = ['MINIO_ROOT_PASSWORD', 'MESSAGE_S3_SECRET_KEY', 'REGISTRY_S3_SECRET_KEY',
      'LOKI_S3_SECRET_KEY', 'THANOS_S3_SECRET_KEY', 'PLUGIN_S3_SECRET_KEY'];
    for (const k of [...names, ...secrets]) {
      expect(env[k]).toBeDefined();
      expect(env[k]).not.toBe('');
    }
    for (const k of secrets) {
      expect(env[k]).toBe('CHANGE_ME');
      expect(env[k]).not.toBe('minioadmin');
    }
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
    // The key-name class allows DIGITS: the MinIO/S3 keys (MESSAGE_S3_SECRET_KEY
    // and friends) contain a `3`, and a [A-Z_|]-only pattern silently stopped
    // matching the guard altogether when they were added — failing this test
    // open would have been worse than failing it closed.
    const guard = /grep -qE '\^\(([A-Z0-9_|]+)\)=CHANGE_ME'/.exec(script);
    expect(guard).not.toBeNull();
    const guarded = guard![1].split('|');
    expect(guarded).toContain('JWT_SECRET');
    expect(guarded).toContain('REFRESH_TOKEN_SECRET');
    expect(guarded).toContain('SECRET_ENCRYPTION_KEY');
  });

  it('generates and guards every MinIO credential the manifests consume', () => {
    // minio-secret used to be a literal Secret inside k8s/minio.yaml on ALL
    // three kubernetes targets, carrying working `minioadmin` defaults — which
    // meant the MINIO_*/S3 values in .env were inert. It is now built from .env
    // (pb_create_app_secrets on aws/*, the inline `secret` helper on minikube),
    // so these must be both substituted AND guarded — otherwise a fresh
    // provision ships predictable object-store credentials.
    const secrets = [
      'MINIO_ROOT_PASSWORD', 'MESSAGE_S3_SECRET_KEY', 'REGISTRY_S3_SECRET_KEY',
      'LOKI_S3_SECRET_KEY', 'THANOS_S3_SECRET_KEY', 'PLUGIN_S3_SECRET_KEY',
    ];
    const guarded = /grep -qE '\^\(([A-Z0-9_|]+)\)=CHANGE_ME'/.exec(script)![1].split('|');
    for (const key of secrets) {
      expect(script).toContain(`s|${key}=CHANGE_ME|${key}=`);
      expect(guarded).toContain(key);
    }
  });
});
