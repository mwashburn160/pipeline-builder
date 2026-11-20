// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Nightly plugin CVE remediation schema (postgres-init.sql, real SQL on
 * PGlite): the idempotency indexes, the vocabulary CHECKs, the kept-source
 * coherence rule, the pipeline election, own-org RLS (no system-org carve-out),
 * the cascade from a purged version, and the org purge.
 */

import { randomUUID } from 'crypto';
import type { PGlite } from '@electric-sql/pglite';
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { ORG_DATA_OWNERSHIP } from '../src/api/org-data-ownership.js';
import { purgeOrgData, purgeRowCounts } from '../src/api/org-data-purge.js';
import { SEEDED_AUTO_APPROVAL_RULE_IDS } from '../src/database/schema/ecosystem.js';
import { bootTenantDb, type TenantTestDb } from '../src/testing/index.js';
import { SYSTEM_ORG, asTenant } from '../src/testing/pglite-init.js';

let tdb: TenantTestDb;
let db: PGlite;
const owner = <T>(fn: (q: PGlite) => Promise<T>) => tdb.asOwner(fn);

const ORG_A = 'org-rem-a';
const ORG_B = 'org-rem-b';
const HASH = 'a'.repeat(64);
const HASH2 = 'b'.repeat(64);

beforeAll(async () => {
  tdb = await bootTenantDb();
  db = tdb.pglite;
}, 120_000);
afterAll(async () => { await tdb?.close(); });

async function insertPlugin(org: string, version = '1.0.0'): Promise<string> {
  const r = await owner((q) => q.query<{ id: string }>(
    'INSERT INTO plugins (org_id, name, version) VALUES ($1, $2, $3) RETURNING id', [org, `p-${randomUUID().slice(0, 8)}`, version]));
  return r.rows[0]!.id;
}

const insertRemediation = (org: string, pluginId: string, stage: string, hash = HASH) => owner((q) => q.query<{ id: string }>(
  `INSERT INTO plugin_remediations (org_id, plugin_id, plugin_name, from_version, findings_hash, stage, created_by)
   VALUES ($1, $2, 'p', '1.0.0', $3, $4, 'system:plugin-remediation') RETURNING id`, [org, pluginId, hash, stage]));

describe('plugin_remediations — idempotency and vocabulary', () => {
  it('allows one live row per (version, findings hash), and a new one once the old failed', async () => {
    const pid = await insertPlugin(ORG_A);
    const first = await insertRemediation(ORG_A, pid, 'published');
    await expect(insertRemediation(ORG_A, pid, 'rolling_out')).rejects.toThrow(/unique|duplicate/i);
    await owner((q) => q.query("UPDATE plugin_remediations SET stage = 'failed' WHERE id = $1", [first.rows[0]!.id]));
    await expect(insertRemediation(ORG_A, pid, 'queued')).resolves.toBeDefined();
  });

  it('allows one in-flight build per version whatever the hash', async () => {
    const pid = await insertPlugin(ORG_A);
    await insertRemediation(ORG_A, pid, 'rebuild', HASH);
    await expect(insertRemediation(ORG_A, pid, 'queued', HASH2)).rejects.toThrow(/unique|duplicate/i);
    // A published fix of one set does not block a different set's build.
    const pid2 = await insertPlugin(ORG_A);
    await insertRemediation(ORG_A, pid2, 'published', HASH);
    await expect(insertRemediation(ORG_A, pid2, 'queued', HASH2)).resolves.toBeDefined();
  });

  it('enforces the stage / outcome vocabulary and the hash shape', async () => {
    const pid = await insertPlugin(ORG_A);
    await expect(insertRemediation(ORG_A, pid, 'rejected')).rejects.toThrow(/check/i);
    await expect(insertRemediation(ORG_A, pid, 'queued', 'XYZ')).rejects.toThrow(/check/i);
    const r = await insertRemediation(ORG_A, pid, 'done');
    await expect(owner((q) => q.query("UPDATE plugin_remediations SET outcome = 'maybe' WHERE id = $1", [r.rows[0]!.id]))).rejects.toThrow(/check/i);
    await expect(owner((q) => q.query("UPDATE plugin_remediations SET outcome = 'cleared', attempt = 0 WHERE id = $1", [r.rows[0]!.id]))).rejects.toThrow(/check/i);
    const row = (await owner((q) => q.query<Record<string, unknown>>('SELECT * FROM plugin_remediations WHERE id = $1', [r.rows[0]!.id]))).rows[0]!;
    expect(row).toMatchObject({ attempt: 1, propose_reasons: [], fix_methods: [], targeted: [], cleared: [], remaining: [] });
  });

  it('defaults kind to plugin, accepts a toolchain release candidate and refuses any other kind', async () => {
    const pid = await insertPlugin(ORG_A);
    const r = await insertRemediation(ORG_A, pid, 'done');
    const row = (await owner((q) => q.query<Record<string, unknown>>('SELECT kind, toolchain_candidate FROM plugin_remediations WHERE id = $1', [r.rows[0]!.id]))).rows[0]!;
    expect(row).toEqual({ kind: 'plugin', toolchain_candidate: null });
    await owner((q) => q.query("UPDATE plugin_remediations SET kind = 'toolchain', toolchain_candidate = $2 WHERE id = $1", [r.rows[0]!.id, JSON.stringify({ toRelease: '1.0.1' })]));
    await expect(owner((q) => q.query("UPDATE plugin_remediations SET kind = 'release' WHERE id = $1", [r.rows[0]!.id]))).rejects.toThrow(/check/i);
  });

  it('cascades from a purged version, and only nulls the link from a purged fix version', async () => {
    const from = await insertPlugin(ORG_A);
    const fix = await insertPlugin(ORG_A, '1.0.1');
    const r = (await insertRemediation(ORG_A, from, 'done')).rows[0]!.id;
    await owner((q) => q.query('UPDATE plugin_remediations SET to_plugin_id = $2 WHERE id = $1', [r, fix]));
    await owner((q) => q.query('DELETE FROM plugins WHERE id = $1', [fix]));
    expect((await owner((q) => q.query('SELECT to_plugin_id FROM plugin_remediations WHERE id = $1', [r]))).rows).toEqual([{ to_plugin_id: null }]);
    await owner((q) => q.query('DELETE FROM plugins WHERE id = $1', [from]));
    expect((await owner((q) => q.query('SELECT 1 FROM plugin_remediations WHERE id = $1', [r]))).rows).toEqual([]);
  });
});

describe('kept sources on plugins and plugin_listing_versions', () => {
  it('defaults to no source, and zip requires key + checksum + size', async () => {
    const pid = await insertPlugin(ORG_A);
    expect((await owner((q) => q.query('SELECT source_kind, delete_batch_id FROM plugins WHERE id = $1', [pid]))).rows)
      .toEqual([{ source_kind: 'none', delete_batch_id: null }]);
    await expect(owner((q) => q.query("UPDATE plugins SET source_kind = 'zip' WHERE id = $1", [pid]))).rejects.toThrow(/check/i);
    await expect(owner((q) => q.query("UPDATE plugins SET source_key = 'k' WHERE id = $1", [pid]))).rejects.toThrow(/check/i);
    await expect(owner((q) => q.query("UPDATE plugins SET source_kind = 'tar', source_key = 'k', source_sha256 = $2, source_size_bytes = 1 WHERE id = $1", [pid, HASH]))).rejects.toThrow(/check/i);
    await expect(owner((q) => q.query("UPDATE plugins SET source_kind = 'zip', source_key = 'k', source_sha256 = 'NOPE', source_size_bytes = 1 WHERE id = $1", [pid]))).rejects.toThrow(/check/i);
    await owner((q) => q.query("UPDATE plugins SET source_kind = 'zip', source_key = 'k', source_sha256 = $2, source_size_bytes = 5000000000, source_kept_at = now() WHERE id = $1", [pid, HASH]));
  });

  it('listed versions carry the same columns and rules', async () => {
    const cols = (await owner((q) => q.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'plugin_listing_versions' AND column_name LIKE 'source_%'"))).rows.map((r) => r.column_name).filter((c) => c !== 'source_plugin_id').sort();
    expect(cols).toEqual(['source_kept_at', 'source_key', 'source_kind', 'source_sha256', 'source_size_bytes']);
    const defs = (await owner((q) => q.query<{ name: string }>(
      "SELECT conname AS name FROM pg_constraint WHERE conrelid = 'plugin_listing_versions'::regclass AND contype = 'c' AND conname LIKE '%source%' ORDER BY 1"))).rows.map((r) => r.name);
    expect(defs).toEqual(['plugin_listing_versions_source_coherence_check', 'plugin_listing_versions_source_kind_check', 'plugin_listing_versions_source_sha256_check']);
  });

  it('publish requests carry the remediation link, and the Remediation fixes rule is seeded', async () => {
    const col = (await owner((q) => q.query("SELECT is_nullable FROM information_schema.columns WHERE table_name = 'plugin_publish_requests' AND column_name = 'remediation_id'"))).rows;
    expect(col).toEqual([{ is_nullable: 'YES' }]);
    const rule = (await owner((q) => q.query<{ enabled: boolean; conditions: Record<string, unknown> }>(
      'SELECT enabled, conditions FROM ecosystem_auto_approval_rules WHERE id = $1', [SEEDED_AUTO_APPROVAL_RULE_IDS.remediationFixes]))).rows[0]!;
    expect(rule.enabled).toBe(true);
    expect(rule.conditions).toMatchObject({ seeded: 'remediation_fixes', requestKinds: ['new_version'], publisherTiers: ['official'], submitterServiceAccount: 'plugin-remediation', remediationOnly: true });
  });
});

describe('pipelines.remediation_upgrades', () => {
  it('defaults to inherit and accepts only the election vocabulary', async () => {
    const r = await owner((q) => q.query<{ id: string; remediation_upgrades: string }>(
      "INSERT INTO pipelines (org_id, project, organization) VALUES ($1, $2, 'o') RETURNING id, remediation_upgrades", [ORG_A, `proj-${randomUUID()}`]));
    expect(r.rows[0]!.remediation_upgrades).toBe('inherit');
    await owner((q) => q.query("UPDATE pipelines SET remediation_upgrades = 'off' WHERE id = $1", [r.rows[0]!.id]));
    await expect(owner((q) => q.query("UPDATE pipelines SET remediation_upgrades = 'sometimes' WHERE id = $1", [r.rows[0]!.id]))).rejects.toThrow(/check/i);
  });
});

describe('settings, orphans and pipeline upgrades', () => {
  it('settings default to propose / minor / NULL rollout / allowPipelineApply', async () => {
    const r = await owner((q) => q.query('INSERT INTO plugin_remediation_settings (org_id) VALUES ($1) RETURNING mode, library_upgrade_level, library_upgrade_level_by_type, library_upgrade_level_by_plugin, rollout, allow_pipeline_apply', [`settings-${randomUUID()}`]));
    expect(r.rows[0]).toEqual({ mode: 'propose', library_upgrade_level: 'minor', library_upgrade_level_by_type: {}, library_upgrade_level_by_plugin: {}, rollout: null, allow_pipeline_apply: true });
    await expect(owner((q) => q.query("INSERT INTO plugin_remediation_settings (org_id, rollout) VALUES ($1, 'always')", [`s-${randomUUID()}`]))).rejects.toThrow(/check/i);
    await expect(owner((q) => q.query("INSERT INTO plugin_remediation_settings (org_id, mode) VALUES ($1, 'auto')", [`s-${randomUUID()}`]))).rejects.toThrow(/check/i);
  });

  it('an orphan is one row per target; its kind is a closed list', async () => {
    const ins = (kind: string) => owner((q) => q.query(
      "INSERT INTO plugin_source_orphans (org_id, kind, bucket, target, last_error) VALUES ($1, $2, 'plugin-sources', 'a/b/1.0.0/', 'NoSuchBucket')", [ORG_A, kind]));
    await ins('prefix');
    await expect(ins('prefix')).rejects.toThrow(/unique|duplicate/i);
    await expect(ins('file')).rejects.toThrow(/check/i);
  });

  it('a pipeline upgrade is one row per (remediation, pipeline) and goes with its pipeline', async () => {
    const p = (await owner((q) => q.query<{ id: string }>(
      "INSERT INTO pipelines (org_id, project, organization) VALUES ($1, $2, 'o') RETURNING id", [ORG_A, `proj-${randomUUID()}`]))).rows[0]!.id;
    const rem = randomUUID();
    const ins = (state: string) => owner((q) => q.query(
      "INSERT INTO pipeline_remediation_upgrades (org_id, remediation_id, pipeline_id, plugin_name, from_version, to_version, mode, state) VALUES ($1, $2, $3, 'p', '1.0.0', '1.0.1', 'propose', $4)",
      [ORG_A, rem, p, state]));
    await expect(ins('pending')).rejects.toThrow(/check/i);
    await ins('proposed');
    await expect(ins('moved')).rejects.toThrow(/unique|duplicate/i);
    await owner((q) => q.query('DELETE FROM pipelines WHERE id = $1', [p]));
    expect((await owner((q) => q.query('SELECT 1 FROM pipeline_remediation_upgrades WHERE remediation_id = $1', [rem]))).rows).toEqual([]);
  });
});

describe('RLS — own org only, no system-org read carve-out', () => {
  const TABLES = ['plugin_remediations', 'plugin_source_orphans', 'plugin_remediation_settings', 'pipeline_remediation_upgrades'];

  it('every new table is RLS-enabled and FORCEd, with own-org policies only', async () => {
    const r = await owner((q) => q.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      'SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ANY($1) ORDER BY 1', [TABLES]));
    expect(r.rows).toEqual([...TABLES].sort().map((relname) => ({ relname, relrowsecurity: true, relforcerowsecurity: true })));
    const policies = await owner((q) => q.query<{ policyname: string }>('SELECT DISTINCT policyname FROM pg_policies WHERE tablename = ANY($1) ORDER BY 1', [TABLES]));
    expect(policies.rows.map((p) => p.policyname)).toEqual(['rls_own_org_delete', 'rls_own_org_insert', 'rls_own_org_read', 'rls_own_org_update']);
  });

  it('an org sees and writes only its own remediations and settings — not another org\'s, not the system org\'s', async () => {
    const own = (await insertRemediation(ORG_A, await insertPlugin(ORG_A), 'done')).rows[0]!.id;
    const other = (await insertRemediation(ORG_B, await insertPlugin(ORG_B), 'done')).rows[0]!.id;
    const sys = (await insertRemediation(SYSTEM_ORG, await insertPlugin(SYSTEM_ORG), 'done')).rows[0]!.id;
    await owner((q) => q.query('INSERT INTO plugin_remediation_settings (org_id) VALUES ($1), ($2) ON CONFLICT DO NOTHING', [ORG_B, SYSTEM_ORG]));
    await asTenant(db, { orgId: ORG_A }, async (q) => {
      const seen = (await q.query<{ id: string }>('SELECT id FROM plugin_remediations WHERE id = ANY($1)', [[own, other, sys]])).rows.map((r) => r.id);
      expect(seen).toEqual([own]);
      expect((await q.query('UPDATE plugin_remediations SET stage = stage WHERE id = ANY($1)', [[other, sys]])).affectedRows).toBe(0);
      expect((await q.query('DELETE FROM plugin_remediations WHERE id = ANY($1)', [[other, sys]])).affectedRows).toBe(0);
      expect((await q.query('SELECT org_id FROM plugin_remediation_settings WHERE org_id = ANY($1)', [[ORG_B, SYSTEM_ORG]])).rows).toEqual([]);
    });
    await expect(asTenant(db, { orgId: ORG_A }, (q) => q.query('INSERT INTO plugin_remediation_settings (org_id) VALUES ($1)', [`${ORG_B}-x`])))
      .rejects.toThrow(/row-level security|violates/i);
    await asTenant(db, { orgId: ORG_A, isSysadmin: true }, async (q) => {
      expect((await q.query('SELECT id FROM plugin_remediations WHERE id = ANY($1)', [[own, other, sys]])).rows).toHaveLength(3);
    });
    await asTenant(db, {}, async (q) => {
      expect((await q.query('SELECT id FROM plugin_remediations WHERE id = ANY($1)', [[own, other, sys]])).rows).toEqual([]);
    });
  });
});

describe('org purge', () => {
  it('plugin owns the remediation tables, pipeline owns the per-pipeline upgrades (all hard)', () => {
    const names = (o: keyof typeof ORG_DATA_OWNERSHIP) => ORG_DATA_OWNERSHIP[o].hard.map((t) => t.name);
    expect(names('plugin')).toEqual(expect.arrayContaining(['plugin_remediations', 'plugin_remediation_settings', 'plugin_source_orphans']));
    expect(names('pipeline')).toContain('pipeline_remediation_upgrades');
  });

  it('removes the purged org\'s remediation rows, settings and orphans, and nobody else\'s', async () => {
    const PURGED = `purged-${randomUUID().slice(0, 8)}`;
    const KEPT = `kept-${randomUUID().slice(0, 8)}`;
    for (const org of [PURGED, KEPT]) {
      await insertRemediation(org, await insertPlugin(org), 'needs_owner');
      await owner((q) => q.query('INSERT INTO plugin_remediation_settings (org_id) VALUES ($1)', [org]));
      await owner((q) => q.query("INSERT INTO plugin_source_orphans (org_id, kind, bucket, target, last_error) VALUES ($1, 'object', 'plugin-sources', $2, 'e')", [org, `${org}/x.zip`]));
    }
    const result = await purgeOrgData('plugin', PURGED);
    expect(result.failed).toEqual([]);
    expect(purgeRowCounts(result)).toMatchObject({ plugin_remediations: 1, plugin_remediation_settings: 1, plugin_source_orphans: 1 });
    for (const table of ['plugin_remediations', 'plugin_remediation_settings', 'plugin_source_orphans']) {
      const left = await owner((q) => q.query<{ org_id: string }>(`SELECT DISTINCT org_id FROM ${table} WHERE org_id = ANY($1)`, [[PURGED, KEPT]]));
      expect([table, left.rows.map((r) => r.org_id)]).toEqual([table, [KEPT]]);
    }
  });
});
