// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The per-org runner signing-key tables, against the shipped init script
 * (PGlite): the one-key-per-state indexes the key store's transitions rely on,
 * the CHECKs that keep a retired key's private key wiped, the version counter
 * the replicas poll, the key-mode and pause-toggle rows, the runner-link
 * columns on the registry, tenant isolation, and the ownership entry that makes
 * an org purge remove the keys while the org export never carries them.
 */

import type { PGlite } from '@electric-sql/pglite';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { getTableName } from 'drizzle-orm';
import { ORG_DATA_OWNERSHIP, allOrgScopedTables, redactSecretColumns } from '../src/api/org-data-ownership.js';
import { schema } from '../src/database/drizzle-schema.js';
import { SYSTEM_ORG, asTenant, bootInitDb } from '../src/testing/pglite-init.js';

const ORG_A = 'org-a';
const ORG_B = 'org-b';
const BLOB = JSON.stringify({ alg: 'aes-256-gcm-v1', iv: 'aXY=', ciphertext: 'Y3Q=' });

let db: PGlite;
beforeAll(async () => { db = await bootInitDb(); }, 120_000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec('DELETE FROM pipeline_runner_signing_keys; DELETE FROM pipeline_runner_key_settings; DELETE FROM pipeline_runner_platform_settings;');
});

let kidSeq = 0;
/** Insert one key row as the superuser; returns its id and version. */
async function key(org: string, state: string, extra: Record<string, unknown> = {}): Promise<{ id: string; runner_key_version: string }> {
  const kid = (extra.kid as string | undefined) ?? `kid-${++kidSeq}`;
  const row = {
    private_key_enc: state === 'retired' ? null : BLOB,
    retire_after: state === 'retiring' ? new Date(Date.now() + 3_600_000) : null,
    ...extra,
  };
  const r = await db.query<{ id: string; runner_key_version: string }>(
    `INSERT INTO pipeline_runner_signing_keys (org_id, kid, public_jwk, private_key_enc, state, activates_at, retire_after)
     VALUES ($1, $2, $3, $4, $5, now(), $6) RETURNING id, runner_key_version`,
    [org, kid, JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: 'x', kid, use: 'sig', alg: 'EdDSA' }), row.private_key_enc, state, row.retire_after]);
  return r.rows[0]!;
}

async function sqlState(p: Promise<unknown>): Promise<string | undefined> {
  try { await p; return undefined; } catch (e) { return (e as { code?: string }).code; }
}

describe('pipeline_runner_signing_keys — one key per state per org', () => {
  it.each(['next', 'active', 'retiring'])('a second %s key for the same org is refused (23505); another org may have one', async (state) => {
    await key(ORG_A, state);
    expect(await sqlState(key(ORG_A, state))).toBe('23505');
    await expect(key(ORG_B, state)).resolves.toBeDefined();
  });

  it('an org holds next, active and retiring at once, and any number of retired keys', async () => {
    await key(ORG_A, 'next');
    await key(ORG_A, 'active');
    await key(ORG_A, 'retiring');
    await key(ORG_A, 'retired');
    await key(ORG_A, 'retired');
    const r = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM pipeline_runner_signing_keys WHERE org_id = $1', [ORG_A]);
    expect(r.rows[0]!.n).toBe(5);
  });

  it('a promotion inside one transaction (active -> retiring, next -> active) satisfies the indexes', async () => {
    const old = await key(ORG_A, 'active');
    const nxt = await key(ORG_A, 'next');
    await db.exec('BEGIN');
    await db.query("UPDATE pipeline_runner_signing_keys SET state = 'retiring', retire_after = now() + interval '1 hour' WHERE id = $1", [old.id]);
    await db.query("UPDATE pipeline_runner_signing_keys SET state = 'active' WHERE id = $1", [nxt.id]);
    await db.exec('COMMIT');
    const r = await db.query<{ id: string; state: string }>('SELECT id, state FROM pipeline_runner_signing_keys WHERE org_id = $1 ORDER BY state', [ORG_A]);
    expect(r.rows).toEqual([{ id: nxt.id, state: 'active' }, { id: old.id, state: 'retiring' }]);
  });

  it('a kid names one key on the whole deployment', async () => {
    await key(ORG_A, 'active', { kid: 'same' });
    expect(await sqlState(key(ORG_B, 'active', { kid: 'same' }))).toBe('23505');
  });
});

describe('pipeline_runner_signing_keys — CHECKs', () => {
  it('a retired key must have its private key wiped, and only a retired key may', async () => {
    expect(await sqlState(key(ORG_A, 'retired', { private_key_enc: BLOB }))).toBe('23514');
    expect(await sqlState(key(ORG_A, 'active', { private_key_enc: null }))).toBe('23514');
    const k = await key(ORG_A, 'active');
    expect(await sqlState(db.query("UPDATE pipeline_runner_signing_keys SET state = 'retired' WHERE id = $1", [k.id]))).toBe('23514');
    await db.query("UPDATE pipeline_runner_signing_keys SET state = 'retired', private_key_enc = NULL, retired_at = now(), retired_reason = 'revoked' WHERE id = $1", [k.id]);
  });

  it('a retiring key needs retire_after; the state and reason vocabularies are closed', async () => {
    expect(await sqlState(key(ORG_A, 'retiring', { retire_after: null }))).toBe('23514');
    expect(await sqlState(key(ORG_A, 'revoked'))).toBe('23514');
    const k = await key(ORG_A, 'active');
    expect(await sqlState(db.query("UPDATE pipeline_runner_signing_keys SET retired_reason = 'bored' WHERE id = $1", [k.id]))).toBe('23514');
  });
});

describe('runner_key_version', () => {
  it('draws every row from one rising sequence, and a change raises the org max', async () => {
    const a = await key(ORG_A, 'active');
    const b = await key(ORG_B, 'active');
    expect(BigInt(b.runner_key_version)).toBeGreaterThan(BigInt(a.runner_key_version));
    const s = await db.query<{ runner_key_version: string }>(
      "INSERT INTO pipeline_runner_key_settings (org_id, mode) VALUES ($1, 'own') RETURNING runner_key_version", [ORG_A]);
    expect(BigInt(s.rows[0]!.runner_key_version)).toBeGreaterThan(BigInt(b.runner_key_version));
    await db.query("UPDATE pipeline_runner_signing_keys SET runner_key_version = nextval('pipeline_runner_key_version_seq') WHERE id = $1", [a.id]);
    const max = await db.query<{ v: string }>('SELECT max(runner_key_version) AS v FROM pipeline_runner_signing_keys WHERE org_id = $1', [ORG_A]);
    expect(BigInt(max.rows[0]!.v)).toBeGreaterThan(BigInt(s.rows[0]!.runner_key_version));
  });

  it('the application role may draw from the sequence', async () => {
    await asTenant(db, { orgId: ORG_A, isSysadmin: true }, async (q) => {
      await q.query("INSERT INTO pipeline_runner_key_settings (org_id, mode) VALUES ($1, 'inherit')", [ORG_A]);
    });
  });
});

describe('pipeline_runner_key_settings', () => {
  it('holds one row per org with a closed mode vocabulary', async () => {
    await db.query("INSERT INTO pipeline_runner_key_settings (org_id, mode) VALUES ($1, 'inherit')", [ORG_A]);
    expect(await sqlState(db.query("INSERT INTO pipeline_runner_key_settings (org_id, mode) VALUES ($1, 'own')", [ORG_A]))).toBe('23505');
    expect(await sqlState(db.query("INSERT INTO pipeline_runner_key_settings (org_id, mode) VALUES ($1, 'shared')", [ORG_B]))).toBe('23514');
  });

  it('a transition sets its kind, switch time and end together, or none of them', async () => {
    await db.query(
      `INSERT INTO pipeline_runner_key_settings (org_id, mode, transition_kind, previous_key_org_id, switch_at, transition_until)
       VALUES ($1, 'inherit', 'to_inherit', $1, now() + interval '10 minutes', now() + interval '70 minutes')`, [ORG_A]);
    expect(await sqlState(db.query(
      "INSERT INTO pipeline_runner_key_settings (org_id, mode, transition_kind) VALUES ($1, 'own', 'to_own')", [ORG_B]))).toBe('23514');
    expect(await sqlState(db.query(
      "INSERT INTO pipeline_runner_key_settings (org_id, mode, switch_at) VALUES ($1, 'own', now())", [ORG_B]))).toBe('23514');
    expect(await sqlState(db.query(
      `INSERT INTO pipeline_runner_key_settings (org_id, mode, transition_kind, switch_at, transition_until)
       VALUES ($1, 'own', 'sideways', now(), now())`, [ORG_B]))).toBe('23514');
  });
});

describe('pipeline_runner_platform_settings (the pause toggle)', () => {
  it('holds at most one row', async () => {
    await db.query('INSERT INTO pipeline_runner_platform_settings (deliveries_paused) VALUES (true)');
    expect(await sqlState(db.query('INSERT INTO pipeline_runner_platform_settings (deliveries_paused) VALUES (false)'))).toBe('23505');
    expect(await sqlState(db.query('INSERT INTO pipeline_runner_platform_settings (singleton) VALUES (false)'))).toBe('23514');
  });

  it('is system-org only: a tenant reads nothing and writes nothing', async () => {
    await db.query('INSERT INTO pipeline_runner_platform_settings (deliveries_paused) VALUES (true)');
    await asTenant(db, { orgId: ORG_A }, async (q) => {
      expect((await q.query('SELECT 1 FROM pipeline_runner_platform_settings')).rows).toHaveLength(0);
      expect((await q.query('UPDATE pipeline_runner_platform_settings SET deliveries_paused = false')).affectedRows).toBe(0);
    });
    await db.query('DELETE FROM pipeline_runner_platform_settings');
    await expect(asTenant(db, { orgId: ORG_A }, (q) => q.query('INSERT INTO pipeline_runner_platform_settings (deliveries_paused) VALUES (false)')))
      .rejects.toThrow(/row-level security|violates/i);
    await db.query('INSERT INTO pipeline_runner_platform_settings (deliveries_paused) VALUES (true)');
    for (const scope of [{ orgId: SYSTEM_ORG }, { orgId: ORG_A, isSysadmin: true }]) {
      await asTenant(db, scope, async (q) => {
        expect((await q.query<{ deliveries_paused: boolean }>('SELECT deliveries_paused FROM pipeline_runner_platform_settings')).rows)
          .toEqual([{ deliveries_paused: true }]);
      });
    }
  });
});

describe('signing keys and key settings — own org only (no system-org read carve-out)', () => {
  it('another org and the system org are invisible and unwritable', async () => {
    const a = await key(ORG_A, 'active');
    const b = await key(ORG_B, 'active');
    const sys = await key(SYSTEM_ORG, 'active');
    await db.query("INSERT INTO pipeline_runner_key_settings (org_id, mode) VALUES ($1, 'own'), ($2, 'own'), ($3, 'own')", [ORG_A, ORG_B, SYSTEM_ORG]);
    await asTenant(db, { orgId: ORG_A }, async (q) => {
      const seen = (await q.query<{ id: string }>('SELECT id FROM pipeline_runner_signing_keys')).rows.map((r) => r.id);
      expect(seen).toEqual([a.id]);
      expect((await q.query('UPDATE pipeline_runner_signing_keys SET updated_at = now() WHERE id = ANY($1)', [[b.id, sys.id]])).affectedRows).toBe(0);
      expect((await q.query('DELETE FROM pipeline_runner_signing_keys WHERE id = ANY($1)', [[b.id, sys.id]])).affectedRows).toBe(0);
      expect((await q.query<{ org_id: string }>('SELECT org_id FROM pipeline_runner_key_settings')).rows).toEqual([{ org_id: ORG_A }]);
    });
    await expect(asTenant(db, { orgId: ORG_A }, (q) => q.query(
      "INSERT INTO pipeline_runner_key_settings (org_id, mode) VALUES ($1, 'inherit')", ['org-c'])))
      .rejects.toThrow(/row-level security|violates/i);
    await asTenant(db, { orgId: ORG_A, isSysadmin: true }, async (q) => {
      expect((await q.query('SELECT id FROM pipeline_runner_signing_keys')).rows).toHaveLength(3);
    });
  });

  it('both tables FORCE row level security', async () => {
    const r = await db.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE relname IN ('pipeline_runner_signing_keys', 'pipeline_runner_key_settings', 'pipeline_runner_platform_settings') ORDER BY relname`);
    expect(r.rows.every((x) => x.relrowsecurity && x.relforcerowsecurity)).toBe(true);
    expect(r.rows).toHaveLength(3);
  });
});

describe('pipeline_registry runner link columns', () => {
  it('a new registry row is unlinked; the status vocabulary is closed', async () => {
    const r = await db.query<{ id: string; runner_link_status: string; runner_link_checked_at: Date | null }>(
      "INSERT INTO pipeline_registry (pipeline_id, org_id, pipeline_name) VALUES (gen_random_uuid(), $1, 'p') RETURNING id, runner_link_status, runner_link_checked_at", [ORG_A]);
    expect(r.rows[0]).toMatchObject({ runner_link_status: 'unlinked', runner_link_checked_at: null });
    await db.query(
      "UPDATE pipeline_registry SET runner_link_status = 'ambiguous', runner_link_checked_at = now(), runner_link_detail = $2 WHERE id = $1",
      [r.rows[0]!.id, JSON.stringify({ runnersChecked: ['prod', 'shared'], matched: ['prod', 'shared'], errorCode: 'AMBIGUOUS_RUNNER' })]);
    expect(await sqlState(db.query("UPDATE pipeline_registry SET runner_link_status = 'maybe' WHERE id = $1", [r.rows[0]!.id]))).toBe('23514');
    await db.query('DELETE FROM pipeline_registry WHERE id = $1', [r.rows[0]!.id]);
  });
});

describe('ownership: the keys are hard pipeline data; the export never carries them', () => {
  it('both tables are HARD tables of the pipeline service', () => {
    const hard = ORG_DATA_OWNERSHIP.pipeline.hard.map((t) => t.name);
    expect(hard).toEqual(expect.arrayContaining(['pipeline_runner_signing_keys', 'pipeline_runner_key_settings']));
    expect(ORG_DATA_OWNERSHIP.pipeline.soft.map((t) => t.name)).not.toContain('pipeline_runner_signing_keys');
    expect(getTableName(schema.pipelineRunnerSigningKey)).toBe('pipeline_runner_signing_keys');
  });

  it('marks private_key_enc secret, and only on the key table', () => {
    const withSecrets = allOrgScopedTables().filter((t) => t.secretColumns?.length);
    expect(withSecrets.map((t) => [t.name, t.secretColumns])).toEqual([['pipeline_runner_signing_keys', ['private_key_enc']]]);
  });

  it('redactSecretColumns drops the secret in either spelling and keeps the rest', () => {
    const scoped = allOrgScopedTables().find((t) => t.name === 'pipeline_runner_signing_keys')!;
    expect(redactSecretColumns(scoped, { kid: 'k', privateKeyEnc: BLOB, private_key_enc: BLOB, state: 'active' }))
      .toEqual({ kid: 'k', state: 'active' });
    const other = allOrgScopedTables().find((t) => t.name === 'pipeline_runners')!;
    const row = { label: 'r', functionUrl: 'u' };
    expect(redactSecretColumns(other, row)).toBe(row);
  });
});
