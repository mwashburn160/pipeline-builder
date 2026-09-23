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
import { describe, it, expect } from '@jest/globals';
import { REPO_ROOT } from '../src/index.js';

// Jest runs with cwd = `platform/`; these files live at the repo root.

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

  it('declares NO shared service-token secret — each service signs with its own key', () => {
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
    // Platform is the only minter; every other verifier reads the JWKS.
    //
    // The mode is deliberately NOT uniform. The AWS targets default to `kms`,
    // where the key that mints a person's session never leaves AWS, so reading
    // the host's disk yields no signing key — worth the one prerequisite it
    // adds (the KMS key must exist before the first deploy; setup fails closed
    // if TOKEN_SIGNING_KMS_KEY_ID is unset rather than falling back to a file).
    // docker/minikube stay `local`: there is no KMS to reach, and a laptop
    // deploy must need no AWS account at all.
    const isAws = target.includes('/aws/');
    expect(env.TOKEN_SIGNING_MODE).toBe(isAws ? 'kms' : 'local');
    if (isAws) {
      // By ALIAS, never an ARN — an ARN embeds the AWS account id, and
      // platform's own validation rejects one. The alias must match what the
      // IAM grant is scoped to (ec2: the TokenSigningKmsAlias stack parameter,
      // eks: resolved by setup.sh), or every sign call AccessDenies.
      expect(env.TOKEN_SIGNING_KMS_KEY_ID).toMatch(/^alias\/[A-Za-z0-9/_-]+$/);
      expect(env.TOKEN_SIGNING_KMS_KEY_ID).not.toMatch(/^arn:/);
      expect(env.TOKEN_SIGNING_KMS_KEY_PREVIOUS_ID).toBe('');
    }
    // Kept on every target: local mode reads it, and kms mode ignores it.
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
 * Table 0: KEY PARITY across the four `.env.example` files.
 *
 * The four files used to be rendered from ONE template by a generator, whose
 * per-target block directives were the only place that recorded "this key
 * belongs to these targets and not the others". The template is gone: each file
 * is now a source maintained on its own, so a new key has to be added to all
 * four BY HAND, and forgetting one is silent at author time.
 *
 * It is not silent at deploy time, it is just unreadable. `pb_sync_env_keys`
 * (deploy/bin/gen-env-secrets.sh) appends only keys the example already has, and
 * a target seeds `.env` from `.env.example` only when `.env` is absent — so the
 * target that missed the key dies under `set -u` with a bare
 *   setup.sh: line N: PLUGIN_S3_ACCESS_KEY: unbound variable
 * which is exactly how the MinIO credential rework broke provisioning.
 *
 * So this table takes over the job those directives were doing, as data rather
 * than as a generator: a key must appear in ALL FOUR files unless it is listed here
 * with the EXACT set of targets it belongs to. That distinguishes the two cases
 * the template distinguished, and fails on either mistake:
 *   - a key added to some targets and forgotten in others is not in the table →
 *     "missing from" failure;
 *   - a genuinely target-specific key is in the table, and the assertion is set
 *     EQUALITY, so it also fails if the key later appears in a target the entry
 *     does not name (or disappears from one it does). Widening a key's reach is
 *     then a deliberate one-line edit here, reviewed with the change.
 *
 * What this does NOT cover, deliberately, and what still needs eyes in review:
 *   - VALUE drift. A key present everywhere with the wrong value on one target
 *     is invisible here, because most of these keys are SUPPOSED to differ per
 *     target (hostnames, replica counts, URLs) and there is no way to tell a
 *     deliberate difference from a typo. The value assertions that do matter
 *     are written out one by one in the `describe.each(TARGETS)` block above.
 *   - COMMENTED-OUT keys (`#FOO=bar` tunables). `pb_sync_env_keys` only ever
 *     syncs uncommented assignments, so a commented key reaching only three
 *     files cannot break a bring-up; matching its parser keeps the two in step.
 *   - Section ordering and comment text, which drift harmlessly.
 */
const TARGET_KEYS: Record<string, string> = {
  'deploy/local/docker/.env.example': 'docker',
  'deploy/local/minikube/.env.example': 'minikube',
  'deploy/aws/ec2/.env.example': 'ec2',
  'deploy/aws/eks/.env.example': 'eks',
};

/**
 * The keys that legitimately exist on only some targets, each with the exact
 * target set and the reason. Every entry must carry a reason: an unannotated
 * entry is how a key that was simply FORGOTTEN on a target gets parked here
 * instead of added.
 */
const TARGET_SPECIFIC: Record<string, { targets: string[]; why: string }> = {
  // --- Infrastructure SHAPE, not cloud: compose runs one of everything and no
  //     service mesh, so these have no meaning there.
  REDIS_URL: { targets: ['docker', 'minikube'], why: 'single Redis; the AWS targets run Sentinel HA and use REDIS_SENTINELS instead' },
  REDIS_SENTINELS: { targets: ['ec2', 'eks'], why: 'Sentinel HA; docker/minikube run one redis and use REDIS_URL' },
  REDIS_SENTINEL_MASTER: { targets: ['ec2', 'eks'], why: 'Sentinel master name; meaningless without Sentinel' },
  AUTH_LIMITER_MAX: { targets: ['docker', 'minikube'], why: 'raised for local setup runs; the AWS targets keep the strict code default' },
  KIALI_SIGNING_KEY: { targets: ['minikube', 'ec2', 'eks'], why: 'Kiali ships with the service mesh, which only the k8s targets run' },
  OTEL_TRACING_ENABLED: { targets: ['minikube', 'ec2', 'eks'], why: 'tracing collector is a k8s-target workload' },
  OTEL_EXPORTER_OTLP_ENDPOINT: { targets: ['minikube', 'ec2', 'eks'], why: 'ditto — no collector on the compose target' },
  REGISTRY_HTTP_SECRET: { targets: ['minikube', 'ec2', 'eks'], why: 'shared upload-session secret across registry REPLICAS; compose runs one' },

  // --- AWS-only: an account, a domain, a KMS key, a VPC.
  DOMAIN: { targets: ['ec2', 'eks'], why: 'public DNS name; the local targets are reached at localhost' },
  DEPLOY_MODE: { targets: ['ec2', 'eks'], why: 'private/public ALB scheme + how CodeBuild reaches it; there is no ALB locally' },
  ADMIN_UIS_ENABLED: { targets: ['ec2', 'eks'], why: 'the internet-exposed admin-UI switch; local targets reach them directly' },
  SES_CONFIGURATION_SET: { targets: ['ec2', 'eks'], why: 'SES bounce/complaint config set; local targets send through the mail catcher' },
  TOKEN_SIGNING_KMS_KEY_ID: { targets: ['ec2', 'eks'], why: 'TOKEN_SIGNING_MODE=kms only on AWS (asserted above); local signs from a file' },
  TOKEN_SIGNING_KMS_KEY_PREVIOUS_ID: { targets: ['ec2', 'eks'], why: 'KMS rotation overlap slot' },
  PIPELINE_VPC_ID: { targets: ['ec2', 'eks'], why: 'VPC wiring for pipeline execution' },
  PIPELINE_SUBNET_IDS: { targets: ['ec2', 'eks'], why: 'VPC wiring for pipeline execution' },
  PIPELINE_SECURITY_GROUP_IDS: { targets: ['ec2', 'eks'], why: 'VPC wiring for pipeline execution' },
  GHCR_USER: { targets: ['ec2', 'eks'], why: 'images are PULLED from GHCR on AWS; local targets build/load them' },
  GHCR_TOKEN: { targets: ['ec2', 'eks'], why: 'ditto' },
  IMAGE_REGISTRY_PULL_HOST: { targets: ['ec2', 'eks'], why: 'plugin pulls traverse the public gateway (${DOMAIN}) on AWS only' },
  IMAGE_REGISTRY_PULL_PORT: { targets: ['ec2', 'eks'], why: 'ditto' },

  // --- One target only.
  PIPELINE_ROOT: { targets: ['ec2'], why: 'the EC2 instance data root (/opt/pipeline); no other target has a host filesystem layout' },
};

describe('.env.example key parity', () => {
  const keysOf = (relPath: string) => new Set(Object.keys(parseEnv(relPath)));
  const byTarget = new Map(Object.entries(TARGET_KEYS).map(([p, t]) => [t, keysOf(p)] as const));
  const allTargets = [...byTarget.keys()].sort();
  const union = [...new Set([...byTarget.values()].flatMap((s) => [...s]))].sort();

  it('parses a plausible number of keys from each file (guards against a vacuous pass)', () => {
    for (const [target, keys] of byTarget) expect([target, keys.size > 150]).toEqual([target, true]);
  });

  it('declares every key on every target, except the declared target-specific ones', () => {
    const problems: string[] = [];
    for (const key of union) {
      const present = allTargets.filter((t) => byTarget.get(t)!.has(key));
      const declared = TARGET_SPECIFIC[key];
      const want = declared ? [...declared.targets].sort() : allTargets;
      if (present.join(' ') === want.join(' ')) continue;
      const missing = want.filter((t) => !present.includes(t));
      const extra = present.filter((t) => !want.includes(t));
      problems.push(
        `${key}: present on [${present.join(', ')}], expected [${want.join(', ')}]` +
        (declared
          ? ` per its TARGET_SPECIFIC entry (${declared.why})`
          : ' — add it to the missing target(s), or, if it is genuinely target-specific, add a TARGET_SPECIFIC entry saying why') +
        (missing.length ? ` | missing from: ${missing.join(', ')}` : '') +
        (extra.length ? ` | unexpectedly on: ${extra.join(', ')}` : ''),
      );
    }
    expect(problems).toEqual([]);
  });

  it('carries no stale TARGET_SPECIFIC entry', () => {
    // A key deleted from the examples must not leave a carve-out behind that
    // would later excuse a genuine omission of the same name.
    const stale = Object.entries(TARGET_SPECIFIC).filter(([k, v]) => !union.includes(k) || v.targets.length === 0 || !v.why);
    expect(stale.map(([k]) => k)).toEqual([]);
    for (const [key, v] of Object.entries(TARGET_SPECIFIC)) {
      expect([key, v.targets.every((t) => allTargets.includes(t))]).toEqual([key, true]);
      // A carve-out naming all four targets is not a carve-out.
      expect([key, v.targets.length < allTargets.length]).toEqual([key, true]);
    }
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
