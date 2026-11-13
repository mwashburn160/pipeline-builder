// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The org toolchain default service (docs/plans/bootstrap-image-versioning.md
 * §5, Phase 4, D7, D15) against a REAL Postgres (PGlite, the shipped
 * postgres-init.sql, as the RLS-enforced app role).
 *
 * Real, not mocked, because the property under test is RLS: writes run in the
 * org's OWN tenant context, so `org_toolchain_default`'s own-org policies are
 * what stop one org touching another's default. The resolver reads (effective,
 * eligibility) run elevated through pipeline-data's test hook, on the same
 * database. Audits go to a bound spy.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, jest } from '@jest/globals';
import { bindTestAuditService, stubModule } from '@pipeline-builder/api-core/testing';

const realApiCore = await import('@pipeline-builder/api-core');
const realPipelineData = await import('@pipeline-builder/pipeline-data');
const { bootTestDb } = await import('./helpers/pglite-db.js');

const testDb = await bootTestDb(() => realPipelineData.getTenantContext());
const raw = testDb.raw;
const mockRecordAudit = bindTestAuditService('plugin');

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  ...realPipelineData,
  withTenantTx: testDb.withTenantTx,
}));

const svc = await import('../src/services/org-toolchain-default-service.js');

const SYSTEM = realApiCore.SYSTEM_ORG_ID;
// team → root; `other` is an unrelated root.
const ROOT = 'aaaaaaaaaaaaaaaaaaaaaaa1';
const TEAM = 'aaaaaaaaaaaaaaaaaaaaaaa2';
const OTHER = 'bbbbbbbbbbbbbbbbbbbbbbb1';
const PARENTS: Record<string, string | undefined> = { [TEAM]: ROOT };
const TOOLCHAIN = { pipelineManager: '4.4.20', awsCdk: '2.1148.0', cdkAssets: '4.8.0', esbuild: '0.28.1', pnpm: '12.14.0', node: '26.13.0' };

realPipelineData.setManagedToolchainDepsForTests({
  read: (fn) => realPipelineData.runWithTenantContext({ isSuperAdmin: true }, () => testDb.withTenantTx((tx) => fn(tx))),
  getParent: async (orgId) => PARENTS[orgId],
});

const me = (orgId = ROOT, userId = 'u-admin') => ({ orgId, userId });

interface ReleaseOpts { yanked?: boolean; deprecated?: boolean; criticalFixable?: number; kev?: number; flagged?: boolean; notes?: string }

async function half(name: 'pipeline-bootstrap' | 'cdk-synth', version: string, o: ReleaseOpts): Promise<void> {
  const metadata = name === 'pipeline-bootstrap' ? realApiCore.toolchainMetadata(TOOLCHAIN) : {};
  const summary = { criticalFixable: o.criticalFixable ?? 0, highFixable: 1, critical: 0, high: 1, medium: 0, low: 0, kev: o.kev ?? 0, findings: [], truncated: false, waived: [], scannedAt: '2026-11-01T00:00:00.000Z' };
  await raw.query(
    `INSERT INTO plugins (org_id, name, version, created_by, updated_by, plugin_type, image_digest, is_active, is_default, scanned_at, vuln_critical_fixable,
       scan_summary, metadata, lifecycle, yanked_at, yank_reason, deprecated_at, scan_flagged_at)
     VALUES ($1, $2, $3, 'loader', 'loader', $4, $5, true, false, '2026-11-01T00:00:00Z', $6, $7, $8, $9, $10, $11, $12, $13)`,
    [SYSTEM, name, version, name === 'pipeline-bootstrap' ? 'BuildImage' : 'CodeBuildStep', `sha256:${'c'.repeat(64)}`, o.criticalFixable ?? 0,
      JSON.stringify(summary), JSON.stringify(metadata),
      o.yanked ? 'yanked' : o.deprecated ? 'deprecated' : 'production',
      o.yanked ? new Date() : null, o.yanked ? 'bad' : null, o.deprecated ? new Date() : null, o.flagged ? new Date() : null],
  );
}

async function release(version: string, o: ReleaseOpts = {}): Promise<void> {
  await raw.query('INSERT INTO toolchain_release (release_version, created_by, release_notes) VALUES ($1, $2, $3)', [version, 'loader', o.notes ?? null]);
  await half('pipeline-bootstrap', version, o);
  await half('cdk-synth', version, o);
}

async function promote(version: string): Promise<void> {
  await raw.query(`INSERT INTO toolchain_platform_default (singleton, release_version, set_by) VALUES (true, $1, 'op')
    ON CONFLICT (singleton) DO UPDATE SET release_version = EXCLUDED.release_version`, [version]);
  await raw.query("INSERT INTO toolchain_default_history (release_version, set_by, kind) VALUES ($1, 'op', 'set')", [version]);
}

async function pipeline(orgId: string, project: string, pin?: string): Promise<void> {
  await raw.query('INSERT INTO pipelines (org_id, created_by, updated_by, project, organization, props) VALUES ($1, $2, $2, $3, $4, $5)',
    [orgId, 'u', project, 'acme', JSON.stringify({ project, organization: 'acme', ...(pin ? { toolchain: { release: pin } } : {}) })]);
}

const ownDefault = async (orgId: string) =>
  (await raw.query<{ release_version: string }>('SELECT release_version FROM org_toolchain_default WHERE org_id = $1', [orgId])).rows[0]?.release_version ?? null;
const auditsOf = (action: string) => mockRecordAudit.mock.calls.map((c) => c[0] as { action: string; orgId: string; actorId: string; details: Record<string, unknown> }).filter((e) => e.action === action);

beforeAll(() => { /* booted at module load */ }, 120_000);
afterAll(async () => {
  realPipelineData.setManagedToolchainDepsForTests(null);
  await raw.close();
});

beforeEach(async () => {
  jest.clearAllMocks();
  await raw.exec(`
    DELETE FROM toolchain_rollout; DELETE FROM org_toolchain_default; DELETE FROM org_toolchain_default_history;
    DELETE FROM toolchain_platform_default; DELETE FROM toolchain_default_history; DELETE FROM toolchain_release;
    DELETE FROM plugins; DELETE FROM pipelines;`);
  await release('1.0.0');
  await release('1.1.0', { notes: 'Node 26' });
  await promote('1.0.0');
  await promote('1.1.0');
});

describe('set / clear / revert — own org only', () => {
  it('sets an eligible release, writes history, audits with previousReleaseVersion; a second set records the first as previous', async () => {
    const first = await svc.setOrgToolchainDefault(me(), { releaseVersion: '1.0.0', reason: '  hold for QA  ' });
    expect(first).toMatchObject({ orgDefault: { releaseVersion: '1.0.0', setBy: 'u-admin', reason: 'hold for QA' }, previousReleaseVersion: null, warnings: [] });
    const second = await svc.setOrgToolchainDefault(me(), { releaseVersion: '1.1.0' });
    expect(second.previousReleaseVersion).toBe('1.0.0');
    expect(await ownDefault(ROOT)).toBe('1.1.0');
    expect(auditsOf('toolchain.org_default.set').map((a) => [a.orgId, a.actorId, a.details])).toEqual([
      [ROOT, 'u-admin', { releaseVersion: '1.0.0', previousReleaseVersion: null, reason: 'hold for QA' }],
      [ROOT, 'u-admin', { releaseVersion: '1.1.0', previousReleaseVersion: '1.0.0' }],
    ]);
  });

  it('clear deletes the row and appends a NULL history row; history is newest first; revert = set the previous one', async () => {
    await svc.setOrgToolchainDefault(me(), { releaseVersion: '1.0.0' });
    await svc.setOrgToolchainDefault(me(), { releaseVersion: '1.1.0' });
    expect(await svc.clearOrgToolchainDefault(me())).toEqual({ previousReleaseVersion: '1.1.0' });
    expect(await ownDefault(ROOT)).toBeNull();
    const { history } = await svc.getOrgToolchainHistory(me());
    expect(history.map((h) => h.releaseVersion)).toEqual([null, '1.1.0', '1.0.0']);
    expect(auditsOf('toolchain.org_default.clear').map((a) => a.details)).toEqual([{ releaseVersion: null, previousReleaseVersion: '1.1.0' }]);

    // "Revert to previous": the newest non-null entry before the current one.
    const previous = history.find((h) => h.releaseVersion !== null)!.releaseVersion!;
    await svc.setOrgToolchainDefault(me(), { releaseVersion: previous });
    expect(await ownDefault(ROOT)).toBe('1.1.0');
  });

  it('clearing with nothing set writes no history and still answers', async () => {
    expect(await svc.clearOrgToolchainDefault(me())).toEqual({ previousReleaseVersion: null });
    expect((await svc.getOrgToolchainHistory(me())).history).toEqual([]);
  });

  it('another org can neither see nor change the default: its writes and reads touch only its own row', async () => {
    await svc.setOrgToolchainDefault(me(ROOT), { releaseVersion: '1.0.0' });
    await svc.setOrgToolchainDefault(me(OTHER, 'u-other'), { releaseVersion: '1.1.0' });
    await svc.clearOrgToolchainDefault(me(OTHER, 'u-other'));
    expect(await ownDefault(ROOT)).toBe('1.0.0');
    expect((await svc.getOrgToolchainHistory(me(OTHER))).history.map((h) => h.releaseVersion)).toEqual([null, '1.1.0']);
    expect((await svc.getOrgToolchainHistory(me(ROOT))).history.map((h) => h.releaseVersion)).toEqual(['1.0.0']);
    expect((await svc.getOrgToolchainPanel(me(OTHER))).orgDefault).toBeNull();
  });

  it('RLS: in an org\'s own tenant context, another org\'s row is invisible and unwritable', async () => {
    await svc.setOrgToolchainDefault(me(ROOT), { releaseVersion: '1.0.0' });
    const asOther = <T>(fn: (tx: any) => Promise<T>) => realPipelineData.runWithTenantContext({ orgId: OTHER, isSuperAdmin: false }, () => testDb.withTenantTx(fn));
    const { schema } = realPipelineData;
    const { eq } = await import('drizzle-orm');
    expect(await asOther((tx) => tx.select().from(schema.orgToolchainDefault))).toEqual([]);
    expect(await asOther((tx) => tx.update(schema.orgToolchainDefault).set({ releaseVersion: '1.1.0' }).where(eq(schema.orgToolchainDefault.orgId, ROOT)).returning())).toEqual([]);
    expect(await asOther((tx) => tx.delete(schema.orgToolchainDefault).where(eq(schema.orgToolchainDefault.orgId, ROOT)).returning())).toEqual([]);
    await expect(asOther((tx) => tx.insert(schema.orgToolchainDefault).values({ orgId: ROOT, releaseVersion: '1.1.0', setBy: 'x' })
      .onConflictDoUpdate({ target: schema.orgToolchainDefault.orgId, set: { releaseVersion: '1.1.0' } }))).rejects.toThrow();
    await expect(asOther((tx) => tx.insert(schema.orgToolchainDefaultHistory).values({ orgId: ROOT, releaseVersion: '1.1.0', setBy: 'x' }))).rejects.toThrow();
    expect(await ownDefault(ROOT)).toBe('1.0.0');
  });
});

describe('eligibility (D15)', () => {
  it.each([
    ['unknown', '9.9.9', async () => undefined],
    ['never promoted, not a canary', '1.2.0', async () => { await release('1.2.0'); }],
    ['yanked', '1.2.0', async () => { await release('1.2.0', { yanked: true }); await promote('1.2.0'); }],
    ['deprecated', '1.2.0', async () => { await release('1.2.0', { deprecated: true }); await promote('1.2.0'); }],
    ['another org\'s canary', '1.2.0', async () => { await release('1.2.0'); await raw.query(`INSERT INTO toolchain_rollout (org_id, release_version, added_by) VALUES ('${OTHER}', '1.2.0', 'op')`); }],
  ])('refuses %s → 400 TOOLCHAIN_RELEASE_NOT_ELIGIBLE, writes nothing', async (_name, v, seed) => {
    await seed();
    await expect(svc.setOrgToolchainDefault(me(), { releaseVersion: v })).rejects.toMatchObject({ statusCode: 400, code: 'TOOLCHAIN_RELEASE_NOT_ELIGIBLE' });
    expect(await ownDefault(ROOT)).toBeNull();
    expect(auditsOf('toolchain.org_default.set')).toEqual([]);
  });

  it('the caller\'s OWN canary (or its root\'s, for a team) is eligible before promotion', async () => {
    await release('1.2.0');
    await raw.query(`INSERT INTO toolchain_rollout (org_id, release_version, added_by) VALUES ('${ROOT}', '1.2.0', 'op')`);
    await expect(svc.setOrgToolchainDefault(me(TEAM, 'u-team'), { releaseVersion: '1.2.0' })).resolves.toMatchObject({ orgDefault: { releaseVersion: '1.2.0' } });
  });

  it('a vulnerability found after promotion is a WARNING, not a refusal', async () => {
    await release('1.2.0', { criticalFixable: 2, kev: 1, flagged: true });
    await promote('1.2.0');
    const out = await svc.setOrgToolchainDefault(me(), { releaseVersion: '1.2.0' });
    expect(out.orgDefault.releaseVersion).toBe('1.2.0');
    expect(out.warnings).toEqual([expect.objectContaining({ code: 'TOOLCHAIN_RELEASE_VULNERABLE', severity: 'warning' })]);
  });
});

describe('the panel', () => {
  it('follows the platform default with no org default; counts pipelines, pins and those behind', async () => {
    await release('1.2.0');
    await promote('1.2.0');
    await pipeline(ROOT, 'a');
    await pipeline(ROOT, 'b', '1.0.0');
    await pipeline(ROOT, 'c', '1.2.0');
    await pipeline(OTHER, 'z', '1.0.0');
    expect(await svc.getOrgToolchainPanel(me())).toEqual({
      effective: { releaseVersion: '1.2.0', resolvedVia: 'default' },
      orgDefault: null,
      inheritedFrom: null,
      canary: { member: false, releaseVersion: null, effective: false },
      platformDefault: '1.2.0',
      counts: { pipelines: 3, pinned: 2, behind: 1 },
    });
  });

  it('an org default overrides a canary (canary.effective false) and puts unpinned pipelines behind', async () => {
    await release('1.2.0');
    await raw.query(`INSERT INTO toolchain_rollout (org_id, release_version, added_by) VALUES ('${ROOT}', '1.2.0', 'op')`);
    expect((await svc.getOrgToolchainPanel(me())).canary).toEqual({ member: true, releaseVersion: '1.2.0', effective: true });
    await svc.setOrgToolchainDefault(me(), { releaseVersion: '1.0.0' });
    await pipeline(ROOT, 'a');
    const panel = await svc.getOrgToolchainPanel(me());
    expect(panel).toMatchObject({
      effective: { releaseVersion: '1.0.0', resolvedVia: 'org-default' },
      orgDefault: { releaseVersion: '1.0.0', setBy: 'u-admin' },
      canary: { member: true, releaseVersion: '1.2.0', effective: false },
      counts: { pipelines: 1, pinned: 0, behind: 1 },
    });
  });

  it('a team without its own default shows the root\'s as inheritedFrom; with its own, its own wins', async () => {
    await svc.setOrgToolchainDefault(me(ROOT), { releaseVersion: '1.0.0' });
    expect(await svc.getOrgToolchainPanel(me(TEAM, 'u-team'))).toMatchObject({
      effective: { releaseVersion: '1.0.0', resolvedVia: 'org-default' }, orgDefault: null, inheritedFrom: ROOT,
    });
    await svc.setOrgToolchainDefault(me(TEAM, 'u-team'), { releaseVersion: '1.1.0' });
    expect(await svc.getOrgToolchainPanel(me(TEAM, 'u-team'))).toMatchObject({
      effective: { releaseVersion: '1.1.0' }, orgDefault: { releaseVersion: '1.1.0' }, inheritedFrom: null,
    });
    // The team's write never touched the root's row.
    expect(await ownDefault(ROOT)).toBe('1.0.0');
  });

  it('no platform default at all → the resolver\'s 409 TOOLCHAIN_NO_DEFAULT', async () => {
    await raw.exec('DELETE FROM toolchain_platform_default; DELETE FROM toolchain_default_history;');
    await expect(svc.getOrgToolchainPanel(me())).rejects.toMatchObject({ code: 'TOOLCHAIN_NO_DEFAULT' });
  });
});

describe('eligible releases', () => {
  it('lists ONLY what the caller may pin or set, newest first, with status, relation, toolchain, notes and scan', async () => {
    await release('1.2.0', { yanked: true });
    await promote('1.2.0'); // a yanked former default: never listed
    await promote('1.1.0'); // back to 1.1.0
    await release('1.3.0', { deprecated: true });
    await release('1.4.0'); // never promoted, nobody's canary
    await release('1.5.0', { criticalFixable: 1, kev: 1 });
    await raw.query(`INSERT INTO toolchain_rollout (org_id, release_version, added_by) VALUES ('${ROOT}', '1.5.0', 'op')`);
    await release('1.6.0');
    await raw.query(`INSERT INTO toolchain_rollout (org_id, release_version, added_by) VALUES ('${OTHER}', '1.6.0', 'op')`);

    const out = await svc.getEligibleToolchainReleases(me());
    expect(out.platformDefault).toBe('1.1.0');
    expect(out.releases.map((r) => [r.releaseVersion, r.status, r.relation])).toEqual([
      ['1.5.0', 'canary', 'newer'],
      ['1.1.0', 'default', 'current'],
      ['1.0.0', 'available', 'older'],
    ]);
    expect(out.releases[1]).toMatchObject({ toolchain: TOOLCHAIN, releaseNotes: 'Node 26', scan: { scannedAt: '2026-11-01T00:00:00.000Z', criticalFixable: 0, highFixable: 2, kev: 0 } });
    expect(out.releases[0]!.scan).toMatchObject({ criticalFixable: 2, kev: 2 });

    // Another org sees its own canary and not ROOT's.
    expect((await svc.getEligibleToolchainReleases(me(OTHER))).releases.map((r) => [r.releaseVersion, r.status])).toEqual([
      ['1.6.0', 'canary'], ['1.1.0', 'default'], ['1.0.0', 'available'],
    ]);
  });
});
