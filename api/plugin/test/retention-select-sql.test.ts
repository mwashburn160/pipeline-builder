// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The superseded-version retention pass's SQL (services/retention/select.ts)
 * against a REAL Postgres (PGlite, the shipped postgres-init.sql, as the
 * RLS-enforced app role under the elevated scope the pass uses): the reference
 * holds of `retentionHoldSql` over seeded pipelines, soft-deleted pipelines,
 * templates, step manifests and listings; the install, listing and retirement
 * reads; and the declared-without-resolution count.
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect, afterAll, beforeEach } from '@jest/globals';

const realPipelineData = await import('@pipeline-builder/pipeline-data');
const { SYSTEM_ORG_ID } = await import('@pipeline-builder/api-core');
const { bootTestDb } = await import('./helpers/pglite-db.js');
const sel = await import('../src/services/retention/select.js');

const testDb = await bootTestDb(() => realPipelineData.getTenantContext());
const raw = testDb.raw;
const asSystem = <T>(fn: (tx: any) => Promise<T>) => realPipelineData.runWithTenantContext({ orgId: SYSTEM_ORG_ID, isSuperAdmin: true }, () => testDb.withTenantTx(fn));

const TENANT = 'aaaaaaaaaaaaaaaaaaaaaaa1';
const digest = () => `sha256:${randomUUID().replace(/-/g, '').padEnd(64, '0')}`;

afterAll(async () => { await raw.close(); });

beforeEach(async () => {
  await raw.exec(`
    DELETE FROM plugin_retirements; DELETE FROM plugin_installs; DELETE FROM plugin_listing_versions; DELETE FROM plugin_listings;
    DELETE FROM pipeline_plugin_resolution; DELETE FROM pipeline_step_manifests; DELETE FROM plugin_vuln_exposure;
    DELETE FROM pipeline_templates; DELETE FROM pipelines; DELETE FROM plugins;`);
});

async function row(name: string, version: string, over: { org?: string; isDefault?: boolean; digest?: string | null; deleted?: boolean; yanked?: boolean } = {}): Promise<{ id: string; digest: string | null }> {
  const d = over.digest === undefined ? digest() : over.digest;
  const r = await raw.query<{ id: string }>(
    `INSERT INTO plugins (org_id, name, version, image_digest, is_default, visibility, deleted_at, yanked_at)
     VALUES ($1, $2, $3, $4, $5, 'public', $6, $7) RETURNING id`,
    [over.org ?? SYSTEM_ORG_ID, name, version, d, over.isDefault ?? false, over.deleted ? new Date() : null, over.yanked ? new Date() : null]);
  return { id: r.rows[0]!.id, digest: d };
}

async function listing(name: string): Promise<string> {
  const r = await raw.query<{ id: string }>(
    "INSERT INTO plugin_listings (publisher_id, name) SELECT id, $1 FROM publishers WHERE handle = 'pipeline-builder' RETURNING id", [name]);
  return r.rows[0]!.id;
}

async function listed(listingId: string, version: string, over: { digest?: string; paused?: boolean; yanked?: boolean } = {}): Promise<string> {
  const r = await raw.query<{ id: string }>(
    `INSERT INTO plugin_listing_versions (listing_id, version, image_digest, image_repository, paused_at, yanked_at, published_by)
     VALUES ($1, $2, $3, $4, $5, $6, 'u') RETURNING id`,
    [listingId, version, over.digest ?? digest(), 'public/pipeline-builder/x', over.paused ? new Date() : null, over.yanked ? new Date() : null]);
  return r.rows[0]!.id;
}

const props = (name: string, version?: string, publisher?: string) => JSON.stringify({
  stages: [{ stageName: 'Build', steps: [{ name: 'scan', plugin: { name, ...(publisher ? { publisher } : {}), ...(version ? { filter: { version } } : {}) } }] }],
});

async function pipeline(p: string, over: { deleted?: boolean; org?: string } = {}): Promise<string> {
  const r = await raw.query<{ id: string }>(
    "INSERT INTO pipelines (org_id, project, organization, props, deleted_at) VALUES ($1, $4, 'o', $2::jsonb, $3) RETURNING id",
    [over.org ?? TENANT, p, over.deleted ? new Date() : null, randomUUID()]);
  return r.rows[0]!.id;
}

async function resolution(pipelineId: string, name: string, version: string | null, d: string | null, over: { declared?: string; publisher?: string | null } = {}): Promise<void> {
  await raw.query(
    `INSERT INTO pipeline_plugin_resolution (org_id, pipeline_id, stage_name, step_name, plugin_publisher, plugin_name, declared_version, resolved_version, resolved_digest)
     VALUES ($1, $2, 'Build', 'scan', $3, $4, $5, $6, $7)`,
    [TENANT, pipelineId, over.publisher === undefined ? 'pipeline-builder' : over.publisher, name, over.declared ?? null, version, d]);
}

async function facts(name: string, listingId: string | null = null) {
  const out = await asSystem((tx) => sel.versionFacts(tx, name, listingId));
  return Object.fromEntries(out.map((f) => [f.version, f]));
}

describe('systemPluginNames', () => {
  it('lists live system plugin names, never managed toolchain names, deleted-only names or other orgs\'', async () => {
    await row('lint', '1.0.0');
    await row('lint', '1.1.0');
    await row('gone', '1.0.0', { deleted: true });
    await row('cdk-synth', '1.0.0');
    await row('tenant-only', '1.0.0', { org: TENANT });
    expect(await asSystem((tx) => sel.systemPluginNames(tx))).toEqual(['lint']);
  });
});

describe('retentionHoldSql (via versionFacts)', () => {
  it('holds nothing on an unreferenced version, and reads yank / deprecation state', async () => {
    await row('lint', '1.0.0');
    await row('lint', '0.9.0', { yanked: true });
    await row('lint', '0.8.0', { deleted: true });
    const f = await facts('lint');
    expect(Object.keys(f).sort()).toEqual(['0.9.0', '1.0.0']);
    expect(f['1.0.0']).toMatchObject({ held: null, yanked: false, deprecated: false, retirement: null, listing: null });
    expect(f['0.9.0']!.yanked).toBe(true);
  });

  it('holds the default version', async () => {
    await row('lint', '1.0.0', { isDefault: true });
    expect((await facts('lint'))['1.0.0']!.held).toBe('default_version');
  });

  it('holds a version a LIVE pipeline\'s declared resolution names by digest, but not a deleted pipeline\'s through that rule', async () => {
    const a = await row('lint', '1.0.0');
    await resolution(await pipeline(props('lint')), 'lint', '1.0.0', a.digest);
    expect((await facts('lint'))['1.0.0']!.held).toBe('pipeline_reference');
  });

  it('holds a version any deployed step manifest runs (a soft-deleted pipeline\'s too)', async () => {
    const a = await row('lint', '1.0.0');
    const p = await pipeline(props('lint'), { deleted: true });
    await raw.query(`INSERT INTO pipeline_step_manifests (pipeline_id, org_id, stage_name, action_name, plugin_name, plugin_version, image_digest)
                     VALUES ($1, $2, 'Build', 'scan', 'lint', '1.0.0', $3)`, [p, TENANT, a.digest]);
    expect((await facts('lint'))['1.0.0']!.held).toBe('pipeline_reference');
  });

  it('holds a listed version whose PUBLIC copy a pipeline references', async () => {
    await row('lint', '1.0.0');
    const lid = await listing('lint');
    const pub = digest();
    await listed(lid, '1.0.0', { digest: pub });
    await resolution(await pipeline(props('lint')), 'lint', '1.0.0', pub);
    const f = (await facts('lint', lid))['1.0.0']!;
    expect(f.held).toBe('pipeline_reference');
    expect(f.listing).toMatchObject({ digest: pub, yanked: false, deprecated: false });
  });

  it('holds a version a SOFT-DELETED pipeline resolved, or pins exactly in its stored config', async () => {
    await row('lint', '1.0.0');
    await row('lint', '1.1.0');
    await resolution(await pipeline(props('lint'), { deleted: true }), 'lint', '1.0.0', null);
    await pipeline(props('lint', '1.1.0'), { deleted: true });
    const f = await facts('lint');
    expect(f['1.0.0']!.held).toBe('deleted_pipeline_pin');
    expect(f['1.1.0']!.held).toBe('deleted_pipeline_pin');
  });

  it('holds a version a template pins exactly (deleted templates too), never one it only ranges over', async () => {
    await row('lint', '1.0.0');
    await row('lint', '1.1.0');
    await row('lint', '1.2.0');
    await raw.query("INSERT INTO pipeline_templates (org_id, name, props) VALUES ($1, 't1', $2::jsonb)", [SYSTEM_ORG_ID, props('lint', '1.0.0')]);
    await raw.query("INSERT INTO pipeline_templates (org_id, name, props, deleted_at) VALUES ($1, 't2', $2::jsonb, now())", [TENANT, props('lint', '1.1.0', 'pipeline-builder')]);
    await raw.query("INSERT INTO pipeline_templates (org_id, name, props) VALUES ($1, 't3', $2::jsonb)", [TENANT, props('lint', '^1.2.0')]);
    await raw.query("INSERT INTO pipeline_templates (org_id, name, props) VALUES ($1, 't4', $2::jsonb)", [TENANT, props('lint', '1.2.0', 'someone-else')]);
    const f = await facts('lint');
    expect(f['1.0.0']!.held).toBe('template_pin');
    expect(f['1.1.0']!.held).toBe('template_pin');
    expect(f['1.2.0']!.held).toBeNull();
  });

  it('holds a version whose listed copy is paused', async () => {
    await row('lint', '1.0.0');
    const lid = await listing('lint');
    await listed(lid, '1.0.0', { paused: true });
    expect((await facts('lint', lid))['1.0.0']!.held).toBe('paused');
  });

  it('reads the pass\'s own pending retirement, and ignores one already yanked', async () => {
    const a = await row('lint', '1.0.0');
    const b = await row('lint', '1.1.0');
    await raw.query("INSERT INTO plugin_retirements (plugin_id, plugin_name, version, rule, deprecated_at) VALUES ($1, 'lint', '1.0.0', 'superseded_in_major', '2026-10-01T00:00:00Z')", [a.id]);
    await raw.query("INSERT INTO plugin_retirements (plugin_id, plugin_name, version, rule, yanked_at) VALUES ($1, 'lint', '1.1.0', 'superseded_in_major', now())", [b.id]);
    const f = await facts('lint');
    expect(f['1.0.0']!.retirement).toEqual({ deprecatedAt: new Date('2026-10-01T00:00:00Z') });
    expect(f['1.1.0']!.retirement).toBeNull();
  });
});

describe('installs, listing and declared resolutions', () => {
  it('reads the listing\'s non-denied installs (with a pending change) and its versions', async () => {
    const lid = await listing('lint');
    await listed(lid, '1.0.0');
    await listed(lid, '1.1.0', { yanked: true });
    await raw.query("INSERT INTO plugin_installs (org_id, listing_id, version_policy, pinned_version, resolved_version, installed_by) VALUES ($1, $2, 'pinned', '1.0.0', '1.0.0', 'u')", [TENANT, lid]);
    await raw.query(`INSERT INTO plugin_installs (org_id, listing_id, version_policy, pinned_version, installed_by, pending_change)
                     VALUES ('bbbbbbbbbbbbbbbbbbbbbbb2', $1, 'patch', '1.0.0', 'u', '{"version":"1.1.0","versionPolicy":"minor","requestedBy":"u","requestedAt":"x","note":null}')`, [lid]);
    await raw.query("INSERT INTO plugin_installs (org_id, listing_id, status, installed_by) VALUES ('ccccccccccccccccccccccc3', $1, 'denied', 'u')", [lid]);
    const installs = await asSystem((tx) => sel.installFacts(tx, lid));
    expect(installs).toEqual(expect.arrayContaining([
      { versionPolicy: 'pinned', pinnedVersion: '1.0.0', resolvedVersion: '1.0.0', pendingChange: null },
      { versionPolicy: 'patch', pinnedVersion: '1.0.0', resolvedVersion: null, pendingChange: { version: '1.1.0', versionPolicy: 'minor' } },
    ]));
    expect(installs).toHaveLength(2);
    const versions = await asSystem((tx) => sel.listedVersions(tx, lid));
    expect(versions.find((x) => x.version === '1.1.0')!.yankedAt).toBeInstanceOf(Date);
    expect(await asSystem((tx) => sel.officialListing(tx, 'lint'))).toMatchObject({ id: lid });
    expect(await asSystem((tx) => sel.officialListing(tx, 'nope'))).toBeNull();
    expect(await asSystem((tx) => sel.installFacts(tx, null))).toEqual([]);
    expect(await asSystem((tx) => sel.listedVersions(tx, null))).toEqual([]);
  });

  it('counts live pipelines that declare the plugin but have no resolution row for it', async () => {
    const withRows = await pipeline(props('lint'));
    await resolution(withRows, 'lint', '1.0.0', null);
    await pipeline(props('lint', undefined, 'pipeline-builder'));
    await pipeline(props('lint'), { deleted: true });
    await pipeline(props('lint', undefined, 'someone-else'));
    expect(await asSystem((tx) => sel.declaredWithoutResolution(tx, 'lint'))).toBe(1);
  });
});
