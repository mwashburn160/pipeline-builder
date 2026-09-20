// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Drift guard for the deploy-time env contract.
 *
 * `config/index.ts` keys its production guards off `NODE_ENV`: without
 * `production`, a missing `SECRET_ENCRYPTION_KEY` wraps AI provider keys and IdP
 * client secrets under an all-zeros key. None of the service images set
 * `NODE_ENV`, so the ONLY thing standing between a deploy and those fallbacks
 * is each target's `.env.example`. That made the guards dead code in every
 * target until 2026-09-12.
 *
 * These assertions are deliberately about the deploy files rather than the
 * config module: the module was always correct — the env that feeds it was not.
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { basename, extname, join } from 'path';

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

  it('declares NO shared service-token secret — each service signs with its own key (#14)', () => {
    // A stale value here would read as a credential an operator must rotate, and
    // nothing would consume it.
    expect(env.JWT_SECRET).toBeUndefined();
    expect(env.JWT_SECRET_PREVIOUS).toBeUndefined();
    expect(env.JWT_ALGORITHM).toBeUndefined();
    // …and the per-service key config that replaced it. Both are FILES (never
    // env values), so nothing is generated for them here.
    expect(env.SERVICE_SIGNING_KEY_FILE).toBeDefined();
    expect(env.SERVICE_KEY_BUNDLE_FILE).toBeDefined();
  });

  it('declares NO refresh-token secret — refresh tokens ride the ES256 signing key', () => {
    // #5 removed REFRESH_TOKEN_SECRET entirely. A stale key left in .env.example
    // would read as a secret an operator must rotate, and nothing would consume it.
    expect(env.REFRESH_TOKEN_SECRET).toBeUndefined();
    expect(env.REFRESH_TOKEN_SECRET_PREVIOUS).toBeUndefined();
    expect(env.REFRESH_TOKEN_EXPIRES_IN).toBeDefined();
  });

  it('configures ES256 user-token signing', () => {
    // Platform is the only minter; every other verifier reads the JWKS. `local`
    // is the shipped default on every target so a fresh deploy needs no manual
    // AWS step; the AWS targets document the KMS switch alongside it.
    expect(env.TOKEN_SIGNING_MODE).toBe('local');
    expect(env.TOKEN_SIGNING_KEY_FILE).toBe('/etc/pipeline-builder/keys/token-signing.key');
    // Rotation overlap — declared and EMPTY, so the manifests can reference it
    // unconditionally (same convention as every *_PREVIOUS value).
    expect(env.TOKEN_SIGNING_KEY_PREVIOUS_FILE).toBe('');
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
    expect(env.SECRET_ENCRYPTION_KEY).toBe('CHANGE_ME_generate_with_openssl_rand_base64_32');
  });
});

/**
 * Table A: every uncommented var in a `.env.example` must have a CONSUMER.
 *
 * A var that nothing reads is worse than clutter: an operator treats it as live
 * configuration, tunes it, and nothing happens — and if it names a credential,
 * it reads as a secret that must be rotated. Three of these (`SERVICE_TIMEOUT`,
 * `ME_CONFIG_MONGODB_ADMINUSERNAME`, `ME_CONFIG_MONGODB_ADMINPASSWORD`) shipped
 * in all four targets before 2026-09-20; the first was shadowed by the real,
 * PREFIXED knobs (`QUOTA_SERVICE_TIMEOUT` and friends), which is why a naive
 * substring search never noticed it.
 *
 * A "consumer" is any non-doc, non-test file under the roots below: service
 * source, docker-compose, a k8s manifest, a config template, a shell script or
 * a plugin spec. Markdown is deliberately NOT a consumer — documenting a var
 * does not make anything read it — and neither are the `.env*` files themselves.
 */
const CONSUMER_ROOTS = [
  'deploy', 'platform/src', 'frontend/src', 'packages', 'api',
  'projenrc', '.github', 'scripts', 'bin', '.projenrc.ts',
];

/** Directories that hold no consumers (build output, deps, tests, generated docs). */
const NON_CONSUMER_DIRS = new Set([
  'node_modules', '.git', 'dist', 'lib', 'build', 'coverage', '.nx',
  'test-reports', 'test', 'tests', '__tests__', 'generated',
]);

/** File kinds that can actually consume an env var. */
const CONSUMER_EXTS = new Set([
  '.ts', '.tsx', '.js', '.mjs', '.cjs', '.yml', '.yaml', '.json', '.sh',
  '.conf', '.sql', '.tf', '.template', '.properties', '.hcl', '.py', '.toml', '.ini',
]);

/**
 * Vars that a THIRD-PARTY image reads out of a bulk-injected env (`env_file:`,
 * `envFrom: secretRef`), so no file in this repo ever names them. Each entry
 * must say which image reads it — an unannotated entry is how a genuinely dead
 * var gets parked here instead of deleted.
 *
 * Empty as of 2026-09-20: every var in every target is named by a consumer.
 */
const THIRD_PARTY_CONSUMED: Record<string, string> = {
  // 'EXAMPLE_VAR': 'read by the <image> container via env_file',
};

function collectConsumerText(): string {
  const chunks: string[] = [];
  const visit = (p: string) => {
    let st;
    try {
      st = statSync(p);
    } catch {
      return; // an optional root that this checkout does not have
    }
    if (st.isDirectory()) {
      if (NON_CONSUMER_DIRS.has(basename(p))) return;
      for (const entry of readdirSync(p)) visit(join(p, entry));
      return;
    }
    const name = basename(p);
    if (name.startsWith('.env')) return; // the declarations, not a consumer
    if (!CONSUMER_EXTS.has(extname(name)) && !name.startsWith('Dockerfile')) return;
    try {
      chunks.push(readFileSync(p, 'utf-8'));
    } catch {
      /* unreadable file is not a consumer */
    }
  };
  for (const root of CONSUMER_ROOTS) visit(join(REPO_ROOT, root));
  return chunks.join('\n');
}

describe('deploy env contract — no dead vars', () => {
  const consumerText = collectConsumerText();

  it('reads at least one consumer file per root (guards against an empty corpus)', () => {
    // If the walk silently found nothing, the assertion below passes vacuously.
    expect(consumerText.length).toBeGreaterThan(1_000_000);
    expect(consumerText).toContain('QUOTA_SERVICE_TIMEOUT');
  });

  it.each(TARGETS)('%s declares no var that nothing reads', (target) => {
    const declared = Object.keys(parseEnv(target));
    expect(declared.length).toBeGreaterThan(50);
    const dead = declared.filter((key) => {
      if (key in THIRD_PARTY_CONSUMED) return false;
      // Whole-word: `SERVICE_TIMEOUT` must not be satisfied by
      // `QUOTA_SERVICE_TIMEOUT`, which is the real knob and a different var.
      return !new RegExp(`(?<![A-Z0-9_])${key}(?![A-Z0-9_])`).test(consumerText);
    });
    expect(dead).toEqual([]);
  });
});

describe('gen-env-secrets.sh', () => {
  const script = readFileSync(join(REPO_ROOT, 'deploy/bin/gen-env-secrets.sh'), 'utf-8');

  it('substitutes every required secret placeholder', () => {
    expect(script).toContain('s|SECRET_ENCRYPTION_KEY=CHANGE_ME_generate_with_openssl_rand_base64_32|SECRET_ENCRYPTION_KEY=');
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
    expect(guarded).toContain('SECRET_ENCRYPTION_KEY');
    // Every SIGNING key is a FILE, not an env value — none may creep back into
    // the generator as a random string.
    expect(guarded).not.toContain('REFRESH_TOKEN_SECRET');
    expect(guarded).not.toContain('JWT_SECRET');
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
