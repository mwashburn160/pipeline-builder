// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The managed toolchain release service (docs/plans/bootstrap-image-versioning.md
 * §1, §5, §6, §8, D1, D14) against a REAL Postgres (PGlite, the shipped
 * postgres-init.sql, as the RLS-enforced app role).
 *
 * Real, not mocked, because what is under test is SQL: the singleton row lock
 * that makes two promotions serialize, the FK RESTRICTs on the release row, the
 * system-org-only RLS on the release tables, and an upload that registers its
 * release in the same transaction.
 *
 * Only two things are replaced: pipeline-data's `withTenantTx` (bound to the
 * PGlite database) and its `findVersionReferences` (the deployed-manifest
 * reference read, whose SQL runs on pipeline-data's own connection; the
 * deploy-reference path is its own suite there). Audits go to a bound spy.
 */

import { randomUUID } from 'node:crypto';
import { jest, describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { type AnyFn, bindTestAuditService, stubModule } from '@pipeline-builder/api-core/testing';
import { sql } from 'drizzle-orm';

const realApiCore = await import('@pipeline-builder/api-core');
const realPipelineData = await import('@pipeline-builder/pipeline-data');
const { bootTestDb } = await import('./helpers/pglite-db.js');

const SYSTEM = realApiCore.SYSTEM_ORG_ID;
const testDb = await bootTestDb(() => realPipelineData.getTenantContext());
const raw = testDb.raw;

const mockRecordAudit = bindTestAuditService('plugin');
const mockFindVersionReferences = jest.fn<AnyFn>(async () => []);

// The REAL pipeline-data, with its transaction bound to the PGlite database.
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  ...realPipelineData,
  withTenantTx: testDb.withTenantTx,
  findVersionReferences: mockFindVersionReferences,
}));
// A deploy re-resolves declared ranges in the background; not this suite's concern.
jest.unstable_mockModule('../src/services/declared-resolution-refresh.js', () => ({ refreshDeclaredResolutions: jest.fn(async () => undefined) }));

const svc = await import('../src/services/toolchain-release-service.js');
const { pluginService } = await import('../src/services/plugin-service.js');

const TOOLCHAIN = { pipelineManager: '4.4.20', awsCdk: '2.1148.0', cdkAssets: '4.8.0', esbuild: '0.28.1', pnpm: '12.14.0', node: '26.13.0' };
const ADMIN = { isSystemAdmin: true, canPublish: true };
const digest = () => `sha256:${randomUUID().replace(/-/g, '').padEnd(64, '0')}`;

/** Upload one half through the real deploy path, as the loader does (system org). */
async function upload(name: 'pipeline-bootstrap' | 'cdk-synth', version: string, opts: { metadata?: Record<string, string> } = {}) {
  return realPipelineData.runWithTenantContext({ orgId: SYSTEM, isSuperAdmin: false }, () => pluginService.deployVersion({
    orgId: SYSTEM,
    name,
    version,
    pluginType: (name === 'pipeline-bootstrap' ? 'BuildImage' : 'CodeBuildStep') as never,
    computeType: 'SMALL' as never,
    metadata: opts.metadata ?? (name === 'pipeline-bootstrap' ? realApiCore.toolchainMetadata(TOOLCHAIN) : {}),
    visibility: 'public',
    buildType: 'prebuilt',
    imageDigest: digest(),
  }, 'loader', ADMIN));
}

/** A complete, scanned, clean release. */
async function release(version: string, opts: { scanned?: boolean; bootstrapMetadata?: Record<string, string> } = {}) {
  await upload('pipeline-bootstrap', version, opts.bootstrapMetadata ? { metadata: opts.bootstrapMetadata } : {});
  await upload('cdk-synth', version);
  if (opts.scanned !== false) await raw.query('UPDATE plugins SET scanned_at = now(), vuln_critical_fixable = 0 WHERE version = $1', [version]);
}

async function platformDefault(): Promise<string | null> {
  return (await raw.query<{ release_version: string }>('SELECT release_version FROM toolchain_platform_default')).rows[0]?.release_version ?? null;
}

async function history() {
  return (await raw.query<{ release_version: string; previous_release_version: string | null; kind: string; reason: string | null }>(
    'SELECT release_version, previous_release_version, kind, reason FROM toolchain_default_history ORDER BY set_at, id')).rows;
}

const initial = (releaseVersion: string, extra: Record<string, unknown> = {}) =>
  svc.setPlatformDefault({ releaseVersion, kind: 'initial', actor: 'service:deploy-bootstrap', ...extra });
const set = (releaseVersion: string, expectedCurrentDefault: string | null, extra: Record<string, unknown> = {}) =>
  svc.setPlatformDefault({ releaseVersion, kind: 'set', actor: 'u-operator', expectedCurrentDefault, ...extra });

function audits(action: string) {
  return mockRecordAudit.mock.calls.map((c) => c[0] as { action: string; outcome?: string; details: Record<string, unknown> }).filter((e) => e.action === action);
}

beforeAll(() => { /* booted at module load */ }, 120_000);
afterAll(async () => { await raw.close(); });

beforeEach(async () => {
  jest.clearAllMocks();
  mockFindVersionReferences.mockImplementation(async () => []);
  await raw.exec(`
    DELETE FROM toolchain_platform_default; DELETE FROM toolchain_default_history; DELETE FROM toolchain_rollout;
    DELETE FROM org_toolchain_default; DELETE FROM org_toolchain_default_history; DELETE FROM toolchain_release;
    DELETE FROM plugins; DELETE FROM pipelines;`);
});

describe('upload registers the release', () => {
  it('writes toolchain_release(release_version) on the first half, once, and never a default', async () => {
    await upload('pipeline-bootstrap', '1.0.0');
    expect((await raw.query('SELECT release_version, created_by FROM toolchain_release')).rows).toEqual([{ release_version: '1.0.0', created_by: 'loader' }]);
    await upload('cdk-synth', '1.0.0');
    expect((await raw.query('SELECT count(*)::int AS n FROM toolchain_release')).rows).toEqual([{ n: 1 }]);
    expect((await raw.query('SELECT bool_or(is_default) AS any FROM plugins')).rows).toEqual([{ any: false }]);
    expect(await platformDefault()).toBeNull();
  });

  it('a customer-org upload of a managed name never reaches the release table', async () => {
    await expect(realPipelineData.runWithTenantContext({ orgId: 'org-a', isSuperAdmin: false }, () => pluginService.deployVersion({
      orgId: 'org-a', name: 'cdk-synth', version: '9.0.0', metadata: {}, visibility: 'org',
    } as never, 'u-a', ADMIN))).rejects.toMatchObject({ code: 'PLUGIN_MANAGED_NAME_RESERVED' });
    expect((await raw.query('SELECT count(*)::int AS n FROM toolchain_release')).rows).toEqual([{ n: 0 }]);
  });
});

describe('setPlatformDefault — the §8 guards, each with its own code', () => {
  it('pair: one half missing, a half yanked or deprecated → TOOLCHAIN_GUARD_PAIR_INCOMPLETE', async () => {
    await upload('pipeline-bootstrap', '1.0.0');
    await raw.query('UPDATE plugins SET scanned_at = now()');
    await expect(initial('1.0.0')).rejects.toMatchObject({ statusCode: 409, code: 'TOOLCHAIN_GUARD_PAIR_INCOMPLETE', details: { missing: ['cdk-synth'] } });
    await expect(initial('7.7.7')).rejects.toMatchObject({ code: 'TOOLCHAIN_GUARD_PAIR_INCOMPLETE' });

    await release('1.1.0');
    await raw.query("UPDATE plugins SET deprecated_at = now(), lifecycle = 'deprecated' WHERE version = '1.1.0' AND name = 'cdk-synth'");
    await expect(initial('1.1.0')).rejects.toMatchObject({ code: 'TOOLCHAIN_GUARD_PAIR_INCOMPLETE', details: { notLive: [{ name: 'cdk-synth', state: 'deprecated' }] } });

    await release('1.2.0');
    await raw.query("UPDATE plugins SET yanked_at = now(), lifecycle = 'yanked' WHERE version = '1.2.0' AND name = 'pipeline-bootstrap'");
    await expect(initial('1.2.0')).rejects.toMatchObject({ code: 'TOOLCHAIN_GUARD_PAIR_INCOMPLETE', details: { notLive: [{ name: 'pipeline-bootstrap', state: 'yanked' }] } });

    await release('1.3.0');
    await raw.query("UPDATE plugins SET is_active = false WHERE version = '1.3.0' AND name = 'cdk-synth'");
    await expect(initial('1.3.0')).rejects.toMatchObject({ code: 'TOOLCHAIN_GUARD_PAIR_INCOMPLETE', details: { notLive: [{ name: 'cdk-synth', state: 'inactive' }] } });
    expect(await platformDefault()).toBeNull();
  });

  it('pair: both halves but no release row → TOOLCHAIN_GUARD_PAIR_INCOMPLETE', async () => {
    await release('1.0.0');
    await raw.query('DELETE FROM toolchain_release');
    await expect(initial('1.0.0')).rejects.toMatchObject({ code: 'TOOLCHAIN_GUARD_PAIR_INCOMPLETE' });
  });

  it('scan: a half not scanned yet → TOOLCHAIN_GUARD_UNSCANNED', async () => {
    await release('1.0.0', { scanned: false });
    await raw.query("UPDATE plugins SET scanned_at = now() WHERE name = 'cdk-synth'");
    await expect(initial('1.0.0')).rejects.toMatchObject({ statusCode: 409, code: 'TOOLCHAIN_GUARD_UNSCANNED', details: { unscanned: ['pipeline-bootstrap'] } });
  });

  it('floor: a fixable Critical (or a rescan flag) → TOOLCHAIN_GUARD_VULN_FLOOR', async () => {
    await release('1.0.0');
    await raw.query("UPDATE plugins SET vuln_critical_fixable = 2 WHERE name = 'cdk-synth'");
    await expect(initial('1.0.0')).rejects.toMatchObject({
      statusCode: 409, code: 'TOOLCHAIN_GUARD_VULN_FLOOR', details: { maxFindings: 0, breaches: [{ name: 'cdk-synth', gated: 2, flagged: false }] },
    });
    await raw.query("UPDATE plugins SET vuln_critical_fixable = 0, scan_flagged_at = now() WHERE name = 'cdk-synth'");
    await expect(initial('1.0.0')).rejects.toMatchObject({ code: 'TOOLCHAIN_GUARD_VULN_FLOOR', details: { breaches: [{ name: 'cdk-synth', flagged: true }] } });
  });

  it('metadata: a bootstrap without a complete toolchain → TOOLCHAIN_GUARD_METADATA', async () => {
    const { 'toolchain.pnpm': _pnpm, ...partial } = realApiCore.toolchainMetadata(TOOLCHAIN);
    await release('1.0.0', { bootstrapMetadata: partial });
    await expect(initial('1.0.0')).rejects.toMatchObject({ statusCode: 409, code: 'TOOLCHAIN_GUARD_METADATA' });
  });

  it('canary gate (stubbed closed): a never-default release → TOOLCHAIN_GUARD_CANARY_GATE unless overridden with a reason', async () => {
    await release('1.0.0');
    await release('1.1.0');
    await initial('1.0.0');
    await expect(set('1.1.0', '1.0.0')).rejects.toMatchObject({ statusCode: 409, code: 'TOOLCHAIN_GUARD_CANARY_GATE' });
    await expect(set('1.1.0', '1.0.0', { overrideReason: '   ' })).rejects.toMatchObject({ code: 'TOOLCHAIN_GUARD_CANARY_GATE' });
    expect(audits('toolchain.default.set')).toEqual([
      expect.objectContaining({ outcome: 'failure', details: { releaseVersion: '1.1.0', refusal: 'TOOLCHAIN_GUARD_CANARY_GATE' } }),
      expect.objectContaining({ outcome: 'failure' }),
    ]);

    await expect(set('1.1.0', '1.0.0', { overrideReason: 'hotfix for CVE-2026-1' })).resolves.toMatchObject({ releaseVersion: '1.1.0', previousReleaseVersion: '1.0.0', changed: true });
    expect(await platformDefault()).toBe('1.1.0');
    expect(audits('toolchain.default.set').at(-1)).toMatchObject({
      outcome: 'success',
      details: { releaseVersion: '1.1.0', previousReleaseVersion: '1.0.0', gateOverride: { reason: 'hotfix for CVE-2026-1' } },
    });
    expect((await history()).at(-1)).toEqual({ release_version: '1.1.0', previous_release_version: '1.0.0', kind: 'set', reason: 'hotfix for CVE-2026-1' });
  });

  it('re-promoting a former default bypasses the stub-closed gate (rollback)', async () => {
    await release('1.0.0');
    await release('1.1.0');
    await initial('1.0.0');
    await set('1.1.0', '1.0.0', { overrideReason: 'promote' });
    await expect(set('1.0.0', '1.1.0')).resolves.toMatchObject({ releaseVersion: '1.0.0', previousReleaseVersion: '1.1.0', changed: true });
    expect(audits('toolchain.default.set').at(-1)?.details).toEqual({ releaseVersion: '1.0.0', previousReleaseVersion: '1.1.0' });
  });

  it('promoting clears the release\'s canary rows', async () => {
    await release('1.0.0');
    await release('1.1.0');
    await initial('1.0.0');
    await raw.query("INSERT INTO toolchain_rollout (org_id, release_version, added_by) VALUES ('org-a', '1.1.0', 'u'), ('org-b', '1.1.0', 'u')");
    await set('1.1.0', '1.0.0', { overrideReason: 'canary done' });
    expect((await raw.query('SELECT count(*)::int AS n FROM toolchain_rollout')).rows).toEqual([{ n: 0 }]);
  });

  it('refuses the overrides outside their kind, and a set without expectedCurrentDefault (400)', async () => {
    await release('1.0.0');
    await expect(svc.setPlatformDefault({ releaseVersion: '1.0.0', kind: 'set', actor: 'u' })).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
    await expect(set('1.0.0', null, { acceptVulnerabilities: 'x' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(initial('1.0.0', { overrideReason: 'x' })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('setting the current default again writes nothing', async () => {
    await release('1.0.0');
    await initial('1.0.0');
    mockRecordAudit.mockClear();
    await expect(set('1.0.0', '1.0.0')).resolves.toMatchObject({ changed: false });
    expect(await history()).toHaveLength(1);
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });
});

describe('setPlatformDefault — concurrency', () => {
  it('expectedCurrentDefault mismatch → TOOLCHAIN_DEFAULT_CHANGED', async () => {
    await release('1.0.0');
    await release('1.1.0');
    await initial('1.0.0');
    await expect(set('1.1.0', null, { overrideReason: 'r' })).rejects.toMatchObject({ statusCode: 409, code: 'TOOLCHAIN_DEFAULT_CHANGED', details: { currentDefault: '1.0.0' } });
    await expect(set('1.1.0', '0.9.0', { overrideReason: 'r' })).rejects.toMatchObject({ code: 'TOOLCHAIN_DEFAULT_CHANGED' });
  });

  it('two concurrent sets from the same view: exactly one wins, the other sees the change', async () => {
    await release('1.0.0');
    await release('1.1.0');
    await release('1.2.0');
    await initial('1.0.0');
    const results = await Promise.allSettled([
      set('1.1.0', '1.0.0', { overrideReason: 'a' }),
      set('1.2.0', '1.0.0', { overrideReason: 'b' }),
    ]);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0].reason).toMatchObject({ code: 'TOOLCHAIN_DEFAULT_CHANGED' });
    const winner = (won[0] as PromiseFulfilledResult<{ releaseVersion: string }>).value.releaseVersion;
    expect(await platformDefault()).toBe(winner);
    expect((await history()).map((h) => h.kind)).toEqual(['initial', 'set']);
  });
});

describe('setPlatformDefault — initial (D14)', () => {
  it('sets the first default once; a second call → TOOLCHAIN_INITIAL_ALREADY_SET', async () => {
    await release('1.0.0');
    await release('1.1.0');
    await expect(initial('1.0.0')).resolves.toMatchObject({ releaseVersion: '1.0.0', previousReleaseVersion: null, kind: 'initial', changed: true });
    expect(await history()).toEqual([{ release_version: '1.0.0', previous_release_version: null, kind: 'initial', reason: null }]);
    expect(audits('toolchain.default.initial')).toEqual([expect.objectContaining({
      actorId: 'service:deploy-bootstrap', orgId: SYSTEM, outcome: 'success', details: { releaseVersion: '1.0.0', previousReleaseVersion: null },
    })]);

    await expect(initial('1.1.0')).rejects.toMatchObject({ statusCode: 409, code: 'TOOLCHAIN_INITIAL_ALREADY_SET', details: { currentDefault: '1.0.0' } });
    await expect(initial('1.0.0')).rejects.toMatchObject({ code: 'TOOLCHAIN_INITIAL_ALREADY_SET' });
    expect(await platformDefault()).toBe('1.0.0');
    expect(audits('toolchain.default.initial').at(-1)).toMatchObject({ outcome: 'failure', details: { refusal: 'TOOLCHAIN_INITIAL_ALREADY_SET' } });
  });

  it('two concurrent initial calls: one wins (no default row to lock yet — the advisory lock serializes them)', async () => {
    await release('1.0.0');
    await release('1.1.0');
    const results = await Promise.allSettled([initial('1.0.0'), initial('1.1.0')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r): r is PromiseRejectedResult => r.status === 'rejected')?.reason).toMatchObject({ code: 'TOOLCHAIN_INITIAL_ALREADY_SET' });
  });

  it('the vulnerability floor blocks initial unless acceptVulnerabilities is given — and the override is audited', async () => {
    await release('1.0.0');
    await raw.query("UPDATE plugins SET vuln_critical_fixable = 1 WHERE name = 'pipeline-bootstrap'");
    await expect(initial('1.0.0')).rejects.toMatchObject({ code: 'TOOLCHAIN_GUARD_VULN_FLOOR' });
    await expect(initial('1.0.0', { acceptVulnerabilities: '  ' })).rejects.toMatchObject({ code: 'TOOLCHAIN_GUARD_VULN_FLOOR' });

    await expect(initial('1.0.0', { acceptVulnerabilities: 'CVE-2026-9 has no exploit path in CodeBuild; patched release tracked in #123' })).resolves.toMatchObject({ releaseVersion: '1.0.0' });
    expect(audits('toolchain.default.initial').at(-1)).toMatchObject({
      outcome: 'success',
      details: {
        releaseVersion: '1.0.0',
        acceptVulnerabilities: 'CVE-2026-9 has no exploit path in CodeBuild; patched release tracked in #123',
        breaches: [{ name: 'pipeline-bootstrap', gated: 1 }],
      },
    });
    expect((await history())[0].reason).toBe('CVE-2026-9 has no exploit path in CodeBuild; patched release tracked in #123');
  });

  it('acceptVulnerabilities is not recorded when the floor holds anyway', async () => {
    await release('1.0.0');
    await initial('1.0.0', { acceptVulnerabilities: 'just in case' });
    expect(audits('toolchain.default.initial').at(-1)?.details).toEqual({ releaseVersion: '1.0.0', previousReleaseVersion: null });
  });

  it('the release tables stay system-org only: a customer tenant reads none of it', async () => {
    await release('1.0.0');
    await initial('1.0.0');
    const rows = await realPipelineData.runWithTenantContext({ orgId: 'org-a', isSuperAdmin: false }, () => testDb.withTenantTx(async (tx) =>
      (await tx.execute(sql`SELECT * FROM toolchain_platform_default`)).rows));
    expect(rows).toEqual([]);
  });
});

describe('release lifecycle', () => {
  async function defaultChain(): Promise<void> {
    await release('1.0.0');
    await release('1.1.0');
    await initial('1.0.0');
    await set('1.1.0', '1.0.0', { overrideReason: 'promote' });
  }

  it('deprecate: both halves, rollout rows removed, no longer promotable', async () => {
    await release('1.0.0');
    await release('1.1.0');
    await initial('1.0.0');
    await raw.query("INSERT INTO toolchain_rollout (org_id, release_version, added_by) VALUES ('org-a', '1.1.0', 'u')");
    const out = await svc.deprecateRelease({ releaseVersion: '1.1.0', actor: 'u-op', message: 'superseded' });
    expect(out.removedRollout).toBe(1);
    expect(out.plugins.map((p) => [p.name, p.lifecycle, p.deprecationMessage]).sort()).toEqual([
      ['cdk-synth', 'deprecated', 'superseded'], ['pipeline-bootstrap', 'deprecated', 'superseded'],
    ]);
    expect(audits('toolchain.release.deprecate')).toEqual([expect.objectContaining({ details: { releaseVersion: '1.1.0', message: 'superseded', removedRolloutOrgs: 1 } })]);
    await expect(set('1.1.0', '1.0.0', { overrideReason: 'r' })).rejects.toMatchObject({ code: 'TOOLCHAIN_GUARD_PAIR_INCOMPLETE' });
    await expect(svc.deprecateRelease({ releaseVersion: '9.9.9', actor: 'u-op' })).rejects.toMatchObject({ statusCode: 404 });
    expect(audits('toolchain.release.deprecate').at(-1)).toMatchObject({ outcome: 'failure', details: { refusal: 'NOT_FOUND' } });
  });

  it('yank a non-default release: both halves yanked, default untouched', async () => {
    await defaultChain();
    await release('1.2.0');
    const out = await svc.yankRelease({ releaseVersion: '1.2.0', actor: 'u-op', reason: 'bad build' });
    expect(out.restored).toBeNull();
    expect(out.plugins.every((p) => p.lifecycle === 'yanked' && p.yankReason === 'bad build' && p.yankedAt !== null && !p.isDefault)).toBe(true);
    expect(await platformDefault()).toBe('1.1.0');
    expect(audits('toolchain.default.restore')).toEqual([]);
  });

  it('yank of the platform default restores the default it replaced (kind restore, gate waived)', async () => {
    await defaultChain();
    const out = await svc.yankRelease({ releaseVersion: '1.1.0', actor: 'u-op', reason: 'synth crash' });
    expect(out.restored).toMatchObject({ releaseVersion: '1.0.0', previousReleaseVersion: '1.1.0', kind: 'restore' });
    expect(await platformDefault()).toBe('1.0.0');
    expect((await history()).at(-1)).toEqual({ release_version: '1.0.0', previous_release_version: '1.1.0', kind: 'restore', reason: 'yank of 1.1.0: synth crash' });
    expect(audits('toolchain.default.restore')).toEqual([expect.objectContaining({ details: expect.objectContaining({ releaseVersion: '1.0.0', previousReleaseVersion: '1.1.0' }) })]);
    expect(audits('toolchain.release.yank')).toEqual([expect.objectContaining({ details: expect.objectContaining({ releaseVersion: '1.1.0', restoredReleaseVersion: '1.0.0' }) })]);
    expect((await raw.query<{ lifecycle: string }>("SELECT lifecycle FROM plugins WHERE version = '1.1.0'")).rows.map((r) => r.lifecycle)).toEqual(['yanked', 'yanked']);
  });

  it('yank of the default is refused TOOLCHAIN_DEFAULT_REQUIRED with no previous default — and nothing changes', async () => {
    await release('1.0.0');
    await initial('1.0.0');
    await expect(svc.yankRelease({ releaseVersion: '1.0.0', actor: 'u-op', reason: 'r' })).rejects.toMatchObject({
      statusCode: 409, code: 'TOOLCHAIN_DEFAULT_REQUIRED', details: { previousReleaseVersion: null },
    });
    expect((await raw.query<{ lifecycle: string }>('SELECT lifecycle FROM plugins')).rows.every((r) => r.lifecycle === 'production')).toBe(true);
    expect(audits('toolchain.release.yank')).toEqual([expect.objectContaining({ outcome: 'failure', details: { releaseVersion: '1.0.0', refusal: 'TOOLCHAIN_DEFAULT_REQUIRED' } })]);
  });

  it('yank of the default is refused when the previous default is no longer live (never promotes anything else)', async () => {
    await defaultChain();
    await release('1.2.0');
    await svc.deprecateRelease({ releaseVersion: '1.0.0', actor: 'u-op' });
    await expect(svc.yankRelease({ releaseVersion: '1.1.0', actor: 'u-op', reason: 'r' })).rejects.toMatchObject({
      code: 'TOOLCHAIN_DEFAULT_REQUIRED', details: { previousReleaseVersion: '1.0.0', cause: 'TOOLCHAIN_GUARD_PAIR_INCOMPLETE' },
    });
    expect(await platformDefault()).toBe('1.1.0');
    expect((await raw.query<{ lifecycle: string }>("SELECT lifecycle FROM plugins WHERE version = '1.1.0'")).rows.map((r) => r.lifecycle)).toEqual(['production', 'production']);
  });

  it('yank needs a reason', async () => {
    await expect(svc.yankRelease({ releaseVersion: '1.0.0', actor: 'u', reason: ' ' })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('delete is refused PLUGIN_VERSION_IN_USE while the default, an org default, a canary, a pin or a deployment references it', async () => {
    await release('1.0.0');
    await release('1.1.0');
    await initial('1.0.0');
    await expect(svc.deleteRelease({ releaseVersion: '1.0.0', actor: 'u-op' })).rejects.toMatchObject({ statusCode: 409, code: 'PLUGIN_VERSION_IN_USE', details: { platformDefault: true } });

    await raw.query("INSERT INTO org_toolchain_default (org_id, release_version, set_by) VALUES ('org-a', '1.1.0', 'u-a')");
    await expect(svc.deleteRelease({ releaseVersion: '1.1.0', actor: 'u-op' })).rejects.toMatchObject({ code: 'PLUGIN_VERSION_IN_USE', details: { orgDefaults: 1 } });
    await raw.query('DELETE FROM org_toolchain_default');

    await raw.query("INSERT INTO toolchain_rollout (org_id, release_version, added_by) VALUES ('org-a', '1.1.0', 'u')");
    await expect(svc.deleteRelease({ releaseVersion: '1.1.0', actor: 'u-op' })).rejects.toMatchObject({ code: 'PLUGIN_VERSION_IN_USE', details: { canaryOrgs: 1 } });
    await raw.query('DELETE FROM toolchain_rollout');

    await raw.query(`INSERT INTO pipelines (org_id, project, organization, props, created_by, updated_by)
      VALUES ('org-a', 'web', 'acme', '{"toolchain":{"release":"1.1.0"}}'::jsonb, 'u', 'u')`);
    await expect(svc.deleteRelease({ releaseVersion: '1.1.0', actor: 'u-op' })).rejects.toMatchObject({ code: 'PLUGIN_VERSION_IN_USE', details: { pinnedPipelines: 1 } });
    await raw.query('DELETE FROM pipelines');

    // A pipeline DEPLOYED on the synth half (the generic deleteBlockers path, per row).
    mockFindVersionReferences.mockImplementation(async (target: any) => (target.pluginName === 'cdk-synth'
      ? [{ pipelineId: 'p-1', pipelineName: 'web', orgId: 'org-a', source: 'deployed', pipelineDeleted: false, steps: ['synth'] }]
      : []));
    await expect(svc.deleteRelease({ releaseVersion: '1.1.0', actor: 'u-op' })).rejects.toMatchObject({ code: 'PLUGIN_VERSION_IN_USE', details: { deployedPipelines: 1 } });
    expect(mockFindVersionReferences).toHaveBeenCalledWith(expect.objectContaining({ pluginName: 'pipeline-bootstrap', pluginVersion: '1.1.0' }));
    expect(audits('toolchain.release.delete').every((a) => a.outcome === 'failure' && a.details.refusal === 'PLUGIN_VERSION_IN_USE')).toBe(true);
    expect((await raw.query('SELECT count(*)::int AS n FROM plugins WHERE deleted_at IS NULL')).rows).toEqual([{ n: 4 }]);
  });

  it('delete of an unreferenced release tombstones both halves and drops the release row', async () => {
    await release('1.0.0');
    await release('1.1.0');
    await initial('1.0.0');
    const out = await svc.deleteRelease({ releaseVersion: '1.1.0', actor: 'u-op' });
    expect(out.plugins.map((p) => p.name).sort()).toEqual(['cdk-synth', 'pipeline-bootstrap']);
    const rows = (await raw.query<{ deleted_by: string; is_active: boolean; purge_after: Date | null }>("SELECT deleted_by, is_active, purge_after FROM plugins WHERE version = '1.1.0'")).rows;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.deleted_by === 'u-op' && r.is_active === false)).toBe(true);
    expect((await raw.query("SELECT 1 FROM toolchain_release WHERE release_version = '1.1.0'")).rows).toEqual([]);
    expect(audits('toolchain.release.delete')).toEqual([expect.objectContaining({ outcome: 'success', details: expect.objectContaining({ releaseVersion: '1.1.0' }) })]);
    // The version is burned: a re-upload is refused (immutable), it never resurrects.
    await expect(upload('cdk-synth', '1.1.0')).rejects.toMatchObject({ code: 'PLUGIN_VERSION_IMMUTABLE' });
    await expect(svc.deleteRelease({ releaseVersion: '1.1.0', actor: 'u-op' })).rejects.toMatchObject({ statusCode: 404 });
  });
});
