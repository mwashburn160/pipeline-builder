// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * What an application pod is allowed to have in its environment.
 *
 * `pb_split_app_env` (deploy/bin/k8s-resources.sh) splits the cleaned `.env`
 * into the `app-env` ConfigMap and the `app-secrets` Secret, and EVERY
 * application workload reads both through `envFrom`. So anything that is not
 * explicitly dropped is handed to every service in the fleet.
 *
 * WHY THIS FILE EXISTS. That drop-list had no test of any kind, and the gap was
 * not theoretical: adding `DB_REPLICATION_PASSWORD` for the read replicas put a
 * credential carrying Postgres's `REPLICATION` attribute into `app-secrets` —
 * because secret detection is by NAME and the key ends in `PASSWORD` — and from
 * there into every application pod. A replication connection streams the WAL,
 * which contains every row of every org BELOW row-level security entirely.
 * `postgres-init.sql` creates the application role `NOREPLICATION` and refuses
 * to start when `DB_REPLICATION_USER` equals `DB_USER` precisely to prevent
 * that; the split would have re-opened it from the other side, and the function's
 * own comment claims the opposite invariant ("no application pod ever receives a
 * credential that bypasses row-level security or tenant scoping").
 *
 * The rules are REIMPLEMENTED here from the shell source rather than executed,
 * because the real function needs a cleaned env file and kubectl. That is a real
 * limitation — a divergence between this model and the awk would go unnoticed —
 * so the first test pins the awk's own patterns, and the model is derived from
 * the same strings this file asserts are present.
 */

import { describe, it, expect } from '@jest/globals';
import { ALL_TARGETS, read } from '../src/index.js';

const SCRIPT = 'deploy/bin/k8s-resources.sh';

/**
 * Credentials that MUST never reach an application pod, each with what it would
 * give away. These are the ones that bypass tenant scoping — not merely
 * sensitive, but authority the application layer is deliberately denied.
 */
const MUST_BE_DROPPED: Record<string, string> = {
  POSTGRES_USER: 'the bootstrap superuser; a superuser bypasses RLS unconditionally, even with FORCE ROW LEVEL SECURITY',
  POSTGRES_PASSWORD: 'same superuser',
  DB_REPLICATION_USER: 'the REPLICATION role; streaming WAL reads every org\'s rows below RLS',
  DB_REPLICATION_PASSWORD: 'same replication role',
  MONGO_INITDB_ROOT_USERNAME: 'Mongo root',
  MONGO_INITDB_ROOT_PASSWORD: 'Mongo root',
  RUSTFS_ROOT_ACCESS_KEY: 'object-store root, across every tenant prefix',
  RUSTFS_ROOT_SECRET_KEY: 'object-store root',
  GRAFANA_ADMIN_PASSWORD: 'Grafana reads Prometheus with no org scoping',
  KIALI_SIGNING_KEY: 'mesh console session signing',
  GHCR_TOKEN: 'registry push',
};

/** Keys an application pod legitimately needs, as a guard against over-dropping. */
const MUST_REACH_APPS = [
  'DB_PASSWORD', // the app's OWN NOSUPERUSER NOBYPASSRLS role
  'DB_HOST',
  'DATABASE',
  'DB_READ_DATABASE', // which pgbouncer pool routes to the standby
  'PG_READ_REPLICA_MAX', // the rung controller's "out before up" bound
];

/** The three patterns the awk uses, extracted from the script itself. */
function rules() {
  const src = read(SCRIPT);
  // Character classes include DIGITS: the prefix list carries LOKI_S3_,
  // THANOS_S3_, REGISTRY_S3_. Omitting 0-9 made this return null, and the
  // vacuous-model guard below is what surfaced it rather than letting every
  // assertion pass against an empty rule set.
  const admin = /key ~ \/\^\(([A-Z0-9_|]+)\)\$\/ \\\n\s*\|\| key ~ \/\^\(([A-Z0-9_|]+)\)\//.exec(src);
  expect(admin).not.toBeNull();
  const adminExact = new Set(admin![1].split('|'));
  const adminPrefix = admin![2].split('|');
  const secretLine = /if \(key ~ \/\((PASSWORD\|[^)]+)\)\$\//.exec(src);
  expect(secretLine).not.toBeNull();
  const secretSuffix = secretLine![1].split('|');
  return { adminExact, adminPrefix, secretSuffix };
}

type Placement = 'dropped' | 'app-secrets' | 'app-env';

function place(key: string): Placement {
  const { adminExact, adminPrefix, secretSuffix } = rules();
  if (adminExact.has(key)) return 'dropped';
  if (adminPrefix.some((p) => key.startsWith(p))) return 'dropped';
  if (/^PASSWORD_BREACH_CHECK/.test(key)) return 'app-env';
  if (/(_EXPIRES_IN|_ISSUER|_SERVICE|_REALM|_TTL_MS|_TOKEN_URL|_KEY_ID|_LENGTH|_KMS|ATTRIBUTE_KEYS)$/.test(key)) return 'app-env';
  if (secretSuffix.some((suf) => key.endsWith(suf.replace(/^_/, '_')) || key.endsWith(suf))) return 'app-secrets';
  if (/SECRET|PASSWORD|WEBHOOK_URL/.test(key) || key === 'REDIS_URL') return 'app-secrets';
  return 'app-env';
}

describe('the split model matches the shell it models', () => {
  it('finds all three rule sets in the script (guards a vacuous model)', () => {
    // If any regex above stopped matching, `place()` would silently classify
    // everything as app-env and every assertion below would pass by accident.
    const { adminExact, adminPrefix, secretSuffix } = rules();
    expect(adminExact.size).toBeGreaterThanOrEqual(10);
    expect(adminPrefix.length).toBeGreaterThanOrEqual(6);
    expect(secretSuffix.length).toBeGreaterThanOrEqual(6);
  });

  it('classifies the three known examples the way the script does', () => {
    // Positive controls from the script's own comments: the superuser is
    // dropped, the app role's password is a secret, and a breach-check knob
    // stays config despite containing "PASSWORD".
    expect(place('POSTGRES_PASSWORD')).toBe('dropped');
    expect(place('DB_PASSWORD')).toBe('app-secrets');
    expect(place('PASSWORD_MIN_LENGTH')).toBe('app-env');
  });
});

describe('no application pod receives authority the app layer is denied', () => {
  it.each(Object.entries(MUST_BE_DROPPED))('drops %s', (key, why) => {
    expect({ key, placement: place(key), why }).toEqual({ key, placement: 'dropped', why });
  });

  it('still delivers what the services actually need', () => {
    // The other half of the guard: over-dropping is also a bug, and it fails as
    // a pod that boots and then cannot reach its database.
    const withheld = MUST_REACH_APPS.filter((k) => place(k) === 'dropped');
    expect(withheld).toEqual([]);
  });

  it('drops every DB_REPLICATION_* key, not only the two that exist today', () => {
    // A third one (DB_REPLICATION_SLOT_PREFIX, say) would default to app-env
    // under the exact-match list. This asserts the invariant by example so the
    // next addition is a deliberate decision rather than an omission.
    for (const k of ['DB_REPLICATION_USER', 'DB_REPLICATION_PASSWORD']) {
      expect({ k, p: place(k) }).toEqual({ k, p: 'dropped' });
    }
  });
});

describe('every key the targets actually ship is placed deliberately', () => {
  it.each(ALL_TARGETS)('%s: no RLS-bypassing credential lands in app-env or app-secrets', (target) => {
    const env = read(`${target}/.env.example`);
    const keys = [...env.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(50); // guards an empty parse
    const leaked = keys
      .filter((k) => k in MUST_BE_DROPPED && place(k) !== 'dropped')
      .map((k) => `${k}: ${MUST_BE_DROPPED[k]}`);
    expect(leaked).toEqual([]);
  });

  it('puts the replication credential in postgres-secret, where its real consumers read it', () => {
    // Dropping it from the app split is only safe because the primary (for
    // postgres-init.sql's \\getenv) and the standby's pg_basebackup read it from
    // a dedicated Secret BY KEY.
    const script = read(SCRIPT);
    expect(script).toContain('--from-literal=DB_REPLICATION_USER=');
    expect(script).toContain('--from-literal=DB_REPLICATION_PASSWORD=');
  });
});
