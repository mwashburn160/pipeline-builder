// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Automatic plugin version tidying end to end against a REAL Postgres (PGlite,
 * the shipped postgres-init.sql, as the RLS-enforced app role): who qualifies,
 * every protection, the weekly digest (N41), notify vs on mode on a fake clock
 * (warn at N-7, deactivate at N, retire at N+30, purge deadline N+60), Keep, a
 * new use and a restore restarting the clock, the operator switch, and the
 * preview matching the run.
 *
 * Replaced: pipeline-data's `withTenantTx` (bound to PGlite) and
 * `findVersionReferences` (its SQL runs on pipeline-data's own connection; the
 * "in use" answer is driven per version here), the soft-delete itself
 * (CrudService's own connection — its effect is reproduced and the call
 * asserted), image-registry (bytes unmeasured) and the notification relay.
 */

import { randomUUID } from 'node:crypto';
import { jest, describe, it, expect, afterAll, beforeAll, beforeEach, afterEach } from '@jest/globals';
import { type AnyFn, bindTestAuditService, stubModule } from '@pipeline-builder/api-core/testing';

const realPipelineData = await import('@pipeline-builder/pipeline-data');
const { bootTestDb } = await import('./helpers/pglite-db.js');
const testDb = await bootTestDb(() => realPipelineData.getTenantContext());
const raw = testDb.raw;

const A = 'aaaaaaaaaaaaaaaaaaaaaaa1';
const B = 'bbbbbbbbbbbbbbbbbbbbbbb2';
const C = 'ccccccccccccccccccccccc3';

const mockRecordAudit = bindTestAuditService('plugin');
const mockIncCounter = jest.fn();
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', { incCounter: mockIncCounter, setGauge: jest.fn() }));
/** `name@version` a pipeline references (drives findVersionReferences). */
const inUse = new Set<string>();
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  ...realPipelineData,
  withTenantTx: testDb.withTenantTx,
  findVersionReferences: jest.fn(async (t: { pluginName: string; pluginVersion: string }) => (inUse.has(`${t.pluginName}@${t.pluginVersion}`)
    ? [{ pipelineId: randomUUID(), pipelineName: 'web', orgId: A, source: 'declared', pipelineDeleted: false, steps: ['build/lint'] }]
    : [])),
}));
const mockReclaimPlan = jest.fn<AnyFn>(async () => null);
jest.unstable_mockModule('../src/services/storage-reclaim.js', () => ({ reclaimPlan: mockReclaimPlan }));

const { runTidyPass, tidyPreview, createTidyScheduler } = await import('../src/services/tidy/pass.js');
const { keepVersion, recordPluginUse, setNeverTidy, resetUseThrottleForTests } = await import('../src/services/tidy/usage.js');
const { writeTidySettings, readTidySettings } = await import('../src/services/tidy/settings.js');
const { pluginService } = await import('../src/services/plugin-service.js');
const { setEcosystemNotifyClientForTests } = await import('../src/services/ecosystem-notifications.js');

const DAY = 86_400_000;
const T0 = new Date('2026-11-14T00:00:00Z');
const at = (days: number) => new Date(T0.getTime() + days * DAY);
const digest = () => `sha256:${randomUUID().replace(/-/g, '').padEnd(64, '0')}`;

const sent: Array<{ event: string; recipients: any[]; subject: string; text: string }> = [];
const send = jest.fn(async (req: any) => { sent.push(req); return { ok: true } as const; });
beforeAll(() => setEcosystemNotifyClientForTests({ send }));
afterAll(async () => {
  setEcosystemNotifyClientForTests(undefined);
  await raw.close();
});
afterEach(() => { delete process.env.PLUGIN_AUTO_TIDY_ENABLED; });

// The soft-delete is CrudService's (pipeline-data's own connection): its effect
// is reproduced, with the shared 30-day purge window.
const fakeDelete = async (row: any) => {
  await raw.query("UPDATE plugins SET deleted_at = $2, deleted_by = 'system', is_active = false, purge_after = $2::timestamptz + interval '30 days' WHERE id = $1", [row.id, currentNow]);
  return { deleted: row, inUse: 0, listed: false, promoted: null };
};
let currentNow = T0;
let deleteVersion: ReturnType<typeof jest.spyOn>;

/** Insert one version of org A, created long ago. */
async function version(name: string, v: string, extra: Record<string, unknown> = {}, org = A): Promise<string> {
  const cols = { org_id: org, name, version: v, image_digest: digest(), visibility: 'org', created_at: at(-200), ...extra };
  const keys = Object.keys(cols);
  const r = await raw.query<{ id: string }>(`INSERT INTO plugins (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, Object.values(cols));
  return r.rows[0]!.id;
}

const ids: Record<string, string> = {};

beforeEach(async () => {
  jest.clearAllMocks();
  resetUseThrottleForTests();
  currentNow = T0;
  deleteVersion = jest.spyOn(pluginService, 'deleteVersion').mockImplementation(fakeDelete as never);
  sent.length = 0;
  inUse.clear();
  await raw.exec(`
    DELETE FROM plugin_retention_settings; DELETE FROM plugin_installs; DELETE FROM plugin_listing_versions; DELETE FROM plugin_listings;
    DELETE FROM publishers WHERE handle = 'acme'; DELETE FROM plugin_vuln_exposure; DELETE FROM pipeline_remediation_upgrades;
    DELETE FROM pipeline_plugin_resolution; DELETE FROM pipeline_step_manifests; DELETE FROM pipelines;
    DELETE FROM ecosystem_notification_queue; DELETE FROM plugin_security_notification_prefs; DELETE FROM plugins;`);
  // lint: every protection, plus two plain candidates (1.0.0, 0.7.0 — listed, but its listing is unused).
  ids['1.0.0'] = await version('lint', '1.0.0');
  ids['1.0.2'] = await version('lint', '1.0.2', { is_active: false }); // deactivated by its OWNER
  ids['1.1.0'] = await version('lint', '1.1.0', { frozen_at: at(-100) });
  ids['1.2.0'] = await version('lint', '1.2.0', { is_default: true });
  ids['1.3.0'] = await version('lint', '1.3.0');
  inUse.add('lint@1.3.0');
  ids['1.4.0'] = await version('lint', '1.4.0'); // latest
  ids['0.9.0'] = await version('lint', '0.9.0', {
    scan_flagged_at: at(-50),
    scan_flag: JSON.stringify({ gated: 1, high: 0, maxFindings: 0, kev: 1, findings: [{ id: 'CVE-2026-9', severity: 'critical', packageName: 'openssl', packageVersion: '3.0.1', fixedIn: [], kev: true }] }),
  });
  ids['0.8.0'] = await version('lint', '0.8.0');
  ids['0.7.0'] = await version('lint', '0.7.0');
  ids['0.6.0'] = await version('lint', '0.6.0');
  ids.solo = await version('solo', '1.0.0');
  ids.keepme = await version('keepme', '1.0.0');
  await version('keepme', '2.0.0');
  // KEV-flagged 0.9.0 is covered by an active risk acceptance (a rollback target).
  const d09 = (await raw.query<{ image_digest: string }>('SELECT image_digest FROM plugins WHERE id = $1', [ids['0.9.0']])).rows[0]!.image_digest;
  await raw.query(`INSERT INTO plugin_vuln_exposure (id, org_id, pipeline_id, plugin_name, plugin_version, image_digest, source, triage_state, accepted_until, accepted_kev)
                   VALUES ($5, $1, $2, 'lint', '0.9.0', $3, 'declared', 'accepted', $4, true)`, [A, randomUUID(), d09, at(60), randomUUID()]);
  // 0.8.0 and 0.7.0 are listed; org B's install pins 0.8.0.
  const pub = await raw.query<{ id: string }>("INSERT INTO publishers (owner_org_id, handle, display_name) VALUES ($1, 'acme', 'Acme') RETURNING id", [A]);
  const listing = await raw.query<{ id: string }>("INSERT INTO plugin_listings (publisher_id, name) VALUES ($1, 'lint') RETURNING id", [pub.rows[0]!.id]);
  for (const v of ['0.8.0', '0.7.0']) {
    await raw.query(`INSERT INTO plugin_listing_versions (listing_id, source_plugin_id, version, image_digest, image_repository, published_by)
                     VALUES ($1, $2, $3, $4, 'public/acme/lint', 'u')`, [listing.rows[0]!.id, ids[v], v, digest()]);
  }
  await raw.query("INSERT INTO plugin_installs (org_id, listing_id, version_policy, pinned_version, resolved_version, installed_by) VALUES ($1, $2, 'pinned', '0.8.0', '0.8.0', 'u')", [B, listing.rows[0]!.id]);
  // A pending remediation proposal moves a pipeline off 0.6.0.
  const pl = await raw.query<{ id: string }>("INSERT INTO pipelines (org_id, project, organization) VALUES ($1, 'p', 'o') RETURNING id", [A]);
  await raw.query(`INSERT INTO pipeline_remediation_upgrades (org_id, remediation_id, pipeline_id, plugin_name, from_version, to_version, mode, state)
                   VALUES ($1, $2, $3, 'lint', '0.6.0', '1.4.0', 'propose', 'proposed')`, [A, randomUUID(), pl.rows[0]!.id]);
  await writeTidySettings(A, { neverTidy: ['keepme'] }, 'u-admin');
});

const rowOf = async (id: string) => (await raw.query<any>('SELECT * FROM plugins WHERE id = $1', [id])).rows[0];
const orgReport = (result: any, org = A) => result.orgs.find((o: any) => o.orgId === org);
const entryOf = (report: any, id: string) => report.versions.find((v: any) => v.pluginId === id);
const audits = (action: string) => mockRecordAudit.mock.calls.map((c) => c[0] as any).filter((e) => e.action === action);
const counted = (name: string, labels: Record<string, string>) => mockIncCounter.mock.calls
  .filter((c) => c[0] === name && JSON.stringify(c[1]) === JSON.stringify(labels)).reduce((n, c) => n + Number(c[2] ?? 1), 0);
const run = (days: number, dryRun = false) => { currentNow = at(days); return runTidyPass({ dryRun, now: at(days) }); };

describe('who qualifies', () => {
  it('never touches a protected version, saying why, and finds only the unused ones', async () => {
    await writeTidySettings(A, { autoTidy: 'on' }, 'u-admin');
    const report = orgReport(await run(0, true));
    const reason = (key: string) => entryOf(report, ids[key]!)?.reason;
    expect(reason('1.4.0')).toBe('latest');
    expect(reason('1.2.0')).toBe('default');
    expect(reason('1.3.0')).toBe('in_use');
    expect(reason('1.1.0')).toBe('frozen');
    expect(reason('1.0.2')).toBe('inactive_by_owner');
    expect(reason('0.9.0')).toBe('kev_accepted');
    expect(reason('0.8.0')).toBe('install_pin');
    expect(reason('0.6.0')).toBe('remediation_pending');
    expect(reason('solo')).toBe('only_version');
    expect(reason('keepme')).toBe('never_tidy');
    expect(entryOf(report, ids['1.0.0']!)).toMatchObject({ state: 'warn' });
    expect(entryOf(report, ids['1.0.0']!).reason).toBeUndefined();
    expect(entryOf(report, ids['0.7.0']!)).toMatchObject({ state: 'warn' });
    expect(report.totals).toMatchObject({ warn: 2, skipped: 11 });

    // Act on the run, all the way to retirement: the protected rows never change.
    const before = await Promise.all(['1.4.0', '1.2.0', '1.3.0', '1.1.0', '1.0.2', '0.9.0', '0.8.0', '0.6.0', 'solo', 'keepme'].map((k) => rowOf(ids[k]!)));
    for (const d of [0, 7, 37]) await run(d);
    const after = await Promise.all(['1.4.0', '1.2.0', '1.3.0', '1.1.0', '1.0.2', '0.9.0', '0.8.0', '0.6.0', 'solo', 'keepme'].map((k) => rowOf(ids[k]!)));
    expect(after).toEqual(before);
    expect(deleteVersion.mock.calls.map((c: unknown[]) => (c[0] as { version: string }).version).sort()).toEqual(['0.7.0', '1.0.0']);
    expect(counted('plugin_tidy_skipped_total', { reason: 'latest' })).toBeGreaterThan(0);
  });

  it('a managed toolchain name is never considered', async () => {
    const id = await version('cdk-synth', '1.0.0');
    await version('cdk-synth', '2.0.0');
    const report = orgReport(await run(0, true));
    expect(entryOf(report, id)).toMatchObject({ state: 'skipped', reason: 'managed' });
  });

  it('a version used recently is fresh: nothing is warned', async () => {
    await raw.query('UPDATE plugins SET last_used_at = $1', [at(-10)]);
    const report = orgReport(await run(0, true));
    expect(report.totals.warn).toBe(0);
    await run(0);
    expect(sent).toEqual([]);
  });
});

describe('notify mode (the default): warn only', () => {
  it('sends ONE digest to the plugin security recipients listing the stale versions with dates and a Keep link each, and never deactivates', async () => {
    expect((await readTidySettings(A)).autoTidy).toBe('notify');
    const result = await run(0);
    expect(sent.map((n) => n.event)).toEqual(['N41']);
    expect(sent[0]!.recipients).toEqual([{ kind: 'org_permission', orgId: A, permission: 'plugins:write' }]);
    expect(sent[0]!.subject).toBe('2 unused plugin versions are stale');
    expect(sent[0]!.text).toMatch(/lint@1\.0\.0/);
    expect(sent[0]!.text).toMatch(/lint@0\.7\.0/);
    expect(sent[0]!.text).toMatch(new RegExp(`tidyKeep=${ids['1.0.0']}`));
    expect(sent[0]!.text).toMatch(/would be deactivated on 2026-11-21 if automatic tidying were on/);
    expect(entryOf(orgReport(result), ids['1.0.0']!).action).toBe('warned');
    expect((await rowOf(ids['1.0.0']!)).tidy_warned_at).not.toBeNull();
    expect(audits('plugin.tidy.warned').map((e) => e.details.version).sort()).toEqual(['0.7.0', '1.0.0']);
    expect(counted('plugin_tidy_versions_total', { outcome: 'warned' })).toBe(2);

    for (const d of [7, 37, 70]) await run(d);
    expect((await rowOf(ids['1.0.0']!)).is_active).toBe(true);
    expect(deleteVersion).not.toHaveBeenCalled();
    expect(audits('plugin.tidy.deactivated')).toEqual([]);
  });

  it('sends nothing to an org with nothing stale', async () => {
    await raw.query('UPDATE plugins SET created_at = $1', [at(-5)]);
    await run(0);
    expect(sent).toEqual([]);
  });
});

describe('on mode: deactivate at N, retire at N+30, purge deadline N+60', () => {
  beforeEach(async () => { await writeTidySettings(A, { autoTidy: 'on' }, 'u-admin'); });

  it('walks a version through every step on the clock', async () => {
    const id = ids['1.0.0']!;
    await run(0);
    expect((await rowOf(id)).tidy_deactivate_after.toISOString()).toBe(at(7).toISOString());
    await run(6);
    expect((await rowOf(id)).is_active).toBe(true);
    const deact = await run(7);
    expect(entryOf(orgReport(deact), id).action).toBe('deactivated');
    const row = await rowOf(id);
    expect(row).toMatchObject({ is_active: false, deleted_at: null });
    expect(row.tidy_deactivated_at.toISOString()).toBe(at(7).toISOString());
    expect(audits('plugin.tidy.deactivated').map((e) => e.details.version).sort()).toEqual(['0.7.0', '1.0.0']);

    await run(36);
    expect(deleteVersion).not.toHaveBeenCalled();
    const retire = await run(37);
    expect(entryOf(orgReport(retire), id).action).toBe('retired');
    // Through the ordinary delete path; the listed-but-unused 0.7.0 with force.
    expect(deleteVersion).toHaveBeenCalledWith(expect.objectContaining({ id }), A, 'system', { force: false });
    expect(deleteVersion).toHaveBeenCalledWith(expect.objectContaining({ id: ids['0.7.0'] }), A, 'system', { force: true });
    const gone = await rowOf(id);
    // One batch id per org per pass: Restore plugin brings the batch back within 30 days.
    expect(gone.delete_batch_id).toBeTruthy();
    expect((await rowOf(ids['0.7.0']!)).delete_batch_id).toBe(gone.delete_batch_id);
    expect(gone.purge_after.toISOString()).toBe(at(67).toISOString());
    expect(audits('plugin.tidy.retired')[0]).toMatchObject({ actorId: 'system', orgId: A, details: { version: expect.any(String), batchId: gone.delete_batch_id } });
    expect(counted('plugin_tidy_versions_total', { outcome: 'retired' })).toBe(2);
  });

  it('does not retire a version a use reactivated after the pass read it', async () => {
    const id = ids['1.0.0']!;
    await run(0);
    await run(7);
    expect((await rowOf(id)).is_active).toBe(false);
    // A lookup lands while the day-37 pass is planning (after it read the rows).
    const blockers = jest.spyOn(pluginService, 'deleteBlockers');
    let used = false;
    blockers.mockImplementation((async (row: { id: string }) => {
      if (!used && row.id === id) {
        used = true;
        resetUseThrottleForTests();
        await recordPluginUse({ id, tidyDeactivatedAt: at(7), tidyWarnedAt: at(0) } as any, at(37));
      }
      return { frozen: false, inUse: 0, listed: false };
    }) as never);
    try {
      const retire = await run(37);
      expect(entryOf(orgReport(retire), id)).toMatchObject({ action: 'refused' });
    } finally {
      blockers.mockRestore();
    }
    expect(deleteVersion.mock.calls.map((c: unknown[]) => (c[0] as { id: string }).id)).not.toContain(id);
    expect(await rowOf(id)).toMatchObject({ is_active: true, deleted_at: null });
  });

  it('never deactivates sooner than 7 days after the warning, even for a long-stale version', async () => {
    await run(0);
    await run(3);
    expect((await rowOf(ids['1.0.0']!)).is_active).toBe(true);
  });

  it('a version that became protected while deactivated is reactivated', async () => {
    await run(0);
    await run(7);
    inUse.add('lint@1.0.0');
    await run(8);
    expect(await rowOf(ids['1.0.0']!)).toMatchObject({ is_active: true, tidy_deactivated_at: null, tidy_warned_at: null });
  });
});

describe('the clock restarts', () => {
  beforeEach(async () => { await writeTidySettings(A, { autoTidy: 'on' }, 'u-admin'); });

  it('on Keep: a warned version is fresh again, a deactivated one active again', async () => {
    await run(0);
    await run(7);
    const kept = await keepVersion(A, ids['1.0.0']!, 'u-1', at(8));
    expect(kept).toMatchObject({ id: ids['1.0.0'], isActive: true, tidyDeactivatedAt: null, tidyWarnedAt: null });
    expect(audits('plugin.tidy.kept')[0]).toMatchObject({ actorId: 'u-1', orgId: A, targetId: ids['1.0.0'] });
    const report = orgReport(await run(9, true));
    expect(entryOf(report, ids['1.0.0']!)).toBeUndefined(); // fresh: not listed
    expect(await keepVersion(B, ids['1.0.0']!, 'u-2', at(9))).toBeNull(); // another org's version
  });

  it('on a new use (a lookup), throttled to one write an hour per version', async () => {
    await run(0);
    await run(7);
    await recordPluginUse({ id: ids['1.0.0']!, tidyDeactivatedAt: at(7), tidyWarnedAt: at(0) } as any, at(8));
    const used = await rowOf(ids['1.0.0']!);
    expect(used).toMatchObject({ is_active: true, tidy_deactivated_at: null, tidy_warned_at: null });
    expect(used.last_used_at.toISOString()).toBe(at(8).toISOString());
    // A stamp is bookkeeping: it does not move updated_at (an editor's If-Match stays valid).
    resetUseThrottleForTests();
    await recordPluginUse({ id: ids['1.0.0']!, tidyDeactivatedAt: null, tidyWarnedAt: null } as any, new Date(at(8).getTime() + 2 * 3_600_000));
    const restamped = await rowOf(ids['1.0.0']!);
    expect(restamped.updated_at.toISOString()).toBe(used.updated_at.toISOString());
    expect(restamped.last_used_at.toISOString()).toBe(new Date(at(8).getTime() + 2 * 3_600_000).toISOString());
    // Within the hour: no write at all.
    await recordPluginUse({ id: ids['1.0.0']!, tidyDeactivatedAt: null, tidyWarnedAt: null } as any, new Date(at(8).getTime() + 2.5 * 3_600_000));
    expect((await rowOf(ids['1.0.0']!)).last_used_at.toISOString()).toBe(new Date(at(8).getTime() + 2 * 3_600_000).toISOString());
  });

  it('on restore: the restored row carries a fresh clock', async () => {
    const extra = await (pluginService as any).restoreExtraSet(ids['1.0.0'], { select: () => ({ from: () => ({ where: async () => [{ orgId: A, name: 'lint', isDefault: false }] }) }) });
    expect(extra).toMatchObject({ tidyWarnedAt: null, tidyDeactivateAfter: null, tidyDeactivatedAt: null, tidyKeptAt: expect.any(Date) });
  });

  it('a plugin set to never tidy is reactivated at once', async () => {
    await run(0);
    await run(7);
    await setNeverTidy(A, 'lint', true, 'u-1');
    expect((await rowOf(ids['1.0.0']!)).is_active).toBe(true);
    expect((await readTidySettings(A)).neverTidy).toEqual(['keepme', 'lint']);
    await setNeverTidy(A, 'lint', false, 'u-1');
    expect((await readTidySettings(A)).neverTidy).toEqual(['keepme']);
  });
});

describe('the digest', () => {
  it('is weekly at most and lists only newly stale versions', async () => {
    await run(0);
    expect(sent).toHaveLength(1);
    // A version going stale two days later waits for next week's digest.
    await raw.query('UPDATE plugins SET created_at = $1 WHERE id = $2', [at(-90 + 2 + 7), ids.solo]);
    const extra = await version('solo', '0.9.0', { created_at: at(-90 + 2 + 7) });
    sent.length = 0;
    const mid = orgReport(await run(2));
    expect(sent).toEqual([]);
    expect(entryOf(mid, extra)).toMatchObject({ state: 'warn_queued', nextDigestAt: at(7).toISOString() });
    await run(7);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toMatch(/solo@0\.9\.0/);
    expect(sent[0]!.text).not.toMatch(/lint@1\.0\.0/);
  });

  it('nothing for an org whose mode is off', async () => {
    await writeTidySettings(A, { autoTidy: 'off' }, 'u-admin');
    const result = await run(0);
    expect(sent).toEqual([]);
    expect(orgReport(result)).toMatchObject({ mode: 'off', versions: [] });
  });
});

describe('the operator switch', () => {
  it('PLUGIN_AUTO_TIDY_ENABLED=false: the scheduled job does no work; only the literal "false" disables', async () => {
    process.env.PLUGIN_AUTO_TIDY_ENABLED = 'false';
    const result = await run(0);
    expect(result).toMatchObject({ operatorEnabled: false, orgs: [] });
    expect(sent).toEqual([]);
    expect((await rowOf(ids['1.0.0']!)).tidy_warned_at).toBeNull();
    // The preview still answers (and says the job is off).
    expect(await tidyPreview(A, { now: T0 })).toMatchObject({ operatorEnabled: false, totals: { warn: 2 } });
    process.env.PLUGIN_AUTO_TIDY_ENABLED = '0';
    expect((await run(0)).operatorEnabled).toBe(true);
  });

  it('builds a leader-locked daily scheduler', () => {
    const s = createTidyScheduler(() => ({}) as never);
    expect(typeof s.start).toBe('function');
    expect(typeof s.stop).toBe('function');
  });
});

describe('the preview', () => {
  it('matches the run, state for state', async () => {
    await writeTidySettings(A, { autoTidy: 'on' }, 'u-admin');
    for (const d of [0, 7, 37]) {
      const preview = await tidyPreview(A, { now: at(d) });
      const result = orgReport(await run(d));
      const verb: Record<string, string> = { warn: 'warned', deactivate: 'deactivated', retire: 'retired' };
      const planned = preview.versions.filter((v: any) => verb[v.state]).map((v: any) => `${v.pluginId}:${verb[v.state]}`).sort();
      const acted = result.versions.filter((v: any) => v.action && v.action !== 'failed').map((v: any) => `${v.pluginId}:${v.action}`).sort();
      expect(acted).toEqual(planned);
      expect(planned.length).toBeGreaterThan(0);
    }
  });

  it('is per org, and adds the bytes tidying frees when image-registry measures them', async () => {
    mockReclaimPlan.mockResolvedValueOnce({ candidates: [{ pluginName: 'lint', version: '1.0.0', marginalBytes: 1000 }, { pluginName: 'lint', version: '0.7.0', marginalBytes: 24 }] } as never);
    await raw.query('UPDATE plugins SET source_kind = $1, source_key = $2, source_sha256 = $3, source_size_bytes = 76 WHERE id = $4', ['zip', 'k', 'a'.repeat(64), ids['1.0.0']]);
    const preview = await tidyPreview(A, { now: T0 });
    expect(entryOf(preview, ids['1.0.0']!).bytes).toBe(1076);
    expect(preview.totals.bytesFreed).toBe(1100);
    expect(preview.storage).toEqual({ measured: true });
    expect((await tidyPreview(C, { now: T0 })).versions).toEqual([]);
  });
});
