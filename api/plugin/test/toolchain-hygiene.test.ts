// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The managed toolchain hygiene notices (docs/plans/bootstrap-image-versioning.md
 * §10) — N34 — against a REAL Postgres (PGlite, the shipped postgres-init.sql),
 * so the elevated reads of every org's defaults and pins are real SQL. The relay
 * client is a recording stub: what is under test is who hears what.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, jest } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';

const realPipelineData = await import('@pipeline-builder/pipeline-data');
const { bootTestDb } = await import('./helpers/pglite-db.js');
const testDb = await bootTestDb(() => realPipelineData.getTenantContext());
const raw = testDb.raw;

const mockIncCounter = jest.fn();
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', { incCounter: mockIncCounter }));
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  ...realPipelineData,
  withTenantTx: testDb.withTenantTx,
}));

const hygiene = await import('../src/services/toolchain-hygiene.js');
const { setEcosystemNotifyClientForTests } = await import('../src/services/ecosystem-notifications.js');

const sent: Array<{ event: string; recipients: any[]; subject: string; text: string }> = [];
const send = jest.fn(async (req: any) => { sent.push(req); return { ok: true } as const; });

const A = 'aaaaaaaaaaaaaaaaaaaaaaa1';
const B = 'bbbbbbbbbbbbbbbbbbbbbbb1';
const C = 'ccccccccccccccccccccccc1';

async function releaseRow(v: string): Promise<void> {
  await raw.query("INSERT INTO toolchain_release (release_version, created_by) VALUES ($1, 'loader') ON CONFLICT DO NOTHING", [v]);
}
async function orgDefault(orgId: string, v: string): Promise<void> {
  await releaseRow(v);
  await raw.query("INSERT INTO org_toolchain_default (org_id, release_version, set_by) VALUES ($1, $2, 'u')", [orgId, v]);
}
async function pinned(orgId: string, project: string, v: string): Promise<void> {
  await raw.query("INSERT INTO pipelines (org_id, created_by, updated_by, project, organization, pipeline_name, props) VALUES ($1, 'u', 'u', $2, 'acme', $2, $3)",
    [orgId, project, JSON.stringify({ project, organization: 'acme', toolchain: { release: v } })]);
}
async function promoted(...versions: string[]): Promise<void> {
  for (const v of versions) {
    await releaseRow(v);
    await raw.query("INSERT INTO toolchain_default_history (release_version, set_by, kind) VALUES ($1, 'op', 'set')", [v]);
  }
  const last = versions.at(-1)!;
  await raw.query(`INSERT INTO toolchain_platform_default (singleton, release_version, set_by) VALUES (true, $1, 'op')
    ON CONFLICT (singleton) DO UPDATE SET release_version = EXCLUDED.release_version`, [last]);
}

const toManagers = (orgId: string) => ({ kind: 'org_permission', orgId, permission: 'toolchain:manage', inheritFromRoot: true });

beforeAll(() => { setEcosystemNotifyClientForTests({ send }); }, 120_000);
afterAll(async () => {
  setEcosystemNotifyClientForTests(undefined);
  await raw.close();
});
beforeEach(async () => {
  jest.clearAllMocks();
  sent.length = 0;
  await raw.exec(`
    DELETE FROM org_toolchain_default; DELETE FROM toolchain_rollout; DELETE FROM toolchain_platform_default;
    DELETE FROM toolchain_default_history; DELETE FROM pipelines; DELETE FROM toolchain_release;`);
});

describe('yanked', () => {
  it('org defaults on it hear it (toolchain:manage), pinned pipelines\' orgs hear it (pipeline writers), each naming only its own pipelines', async () => {
    await promoted('1.0.0', '1.1.0');
    await orgDefault(A, '1.0.0');
    await orgDefault(B, '1.0.0');
    await orgDefault(C, '1.1.0');
    await pinned(A, 'web', '1.0.0');
    await pinned(C, 'api', '1.0.0');
    await pinned(C, 'batch', '1.0.0');
    await pinned(B, 'other', '1.1.0');

    const out = await hygiene.notifyToolchainHygiene({ kind: 'yanked', releaseVersion: '1.0.0', reason: 'synth crash' });
    expect(out).toEqual({ orgDefaultOrgs: 2, pinnedOrgs: 2 });
    expect(sent.every((n) => n.event === 'N34')).toBe(true);

    const defaults = sent.find((n) => n.recipients.some((r) => r.permission === 'toolchain:manage'))!;
    expect(defaults.recipients.sort((x, y) => x.orgId.localeCompare(y.orgId))).toEqual([toManagers(A), toManagers(B)]);
    expect(defaults.subject).toBe("Your organization's toolchain default 1.0.0 was yanked");
    expect(defaults.text).toContain('synth crash');
    expect(defaults.text).toContain('follow the platform default (currently 1.1.0)');

    const pins = sent.filter((n) => n.recipients.some((r) => r.permission === 'pipelines:write'));
    expect(pins.map((n) => n.recipients)).toEqual(expect.arrayContaining([
      [{ kind: 'org_permission', orgId: A, permission: 'pipelines:write' }],
      [{ kind: 'org_permission', orgId: C, permission: 'pipelines:write' }],
    ]));
    const cNotice = pins.find((n) => n.recipients[0].orgId === C)!;
    expect(cNotice.text).toContain('pipeline api');
    expect(cNotice.text).toContain('pipeline batch');
    expect(cNotice.text).not.toContain('pipeline web');
    expect(mockIncCounter).toHaveBeenCalledWith('toolchain_hygiene_notices_total', { kind: 'yanked' }, 4);
  });

  it('nobody on it: nothing sent', async () => {
    await promoted('1.0.0');
    expect(await hygiene.notifyToolchainHygiene({ kind: 'yanked', releaseVersion: '1.0.0' })).toEqual({ orgDefaultOrgs: 0, pinnedOrgs: 0 });
    expect(send).not.toHaveBeenCalled();
  });
});

describe('deprecated and vulnerable', () => {
  it('deprecated: org defaults on it only — pins are not told', async () => {
    await promoted('1.0.0');
    await orgDefault(A, '1.0.0');
    await pinned(B, 'web', '1.0.0');
    expect(await hygiene.notifyToolchainHygiene({ kind: 'deprecated', releaseVersion: '1.0.0', message: 'use 1.1' })).toEqual({ orgDefaultOrgs: 1, pinnedOrgs: 0 });
    expect(sent).toEqual([expect.objectContaining({ event: 'N34', recipients: [toManagers(A)], subject: "Your organization's toolchain default 1.0.0 was deprecated" })]);
    expect(sent[0]!.text).toContain('use 1.1');
  });

  it('vulnerable: names the half, the fixable Criticals and the KEV count', async () => {
    await promoted('1.0.0');
    await orgDefault(A, '1.0.0');
    await hygiene.notifyToolchainHygiene({ kind: 'vulnerable', releaseVersion: '1.0.0', plugin: 'pipeline-bootstrap', criticalFixable: 2, kev: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.recipients).toEqual([toManagers(A)]);
    expect(sent[0]!.text).toContain('pipeline-bootstrap@1.0.0');
    expect(sent[0]!.text).toMatch(/2 fixable Critical findings and 1 on the CISA known-exploited list/);
  });

  it('more than 50 orgs on one release are split across relay requests', async () => {
    await promoted('1.0.0');
    for (let i = 0; i < 51; i += 1) await orgDefault(`dddddddddddddddddddd${String(i).padStart(4, '0')}`, '1.0.0');
    await hygiene.notifyToolchainHygiene({ kind: 'deprecated', releaseVersion: '1.0.0' });
    expect(sent.map((n) => n.recipients.length)).toEqual([50, 1]);
  });
});

describe('behind (K = 3)', () => {
  it('counts PROMOTED releases only and notifies once, on the change that crosses K', async () => {
    expect(hygiene.TOOLCHAIN_BEHIND_THRESHOLD).toBe(3);
    await promoted('1.0.0', '1.1.0', '1.2.0', '1.3.0');
    await releaseRow('1.3.1'); // registered, never promoted: does not count
    await orgDefault(A, '1.0.0');
    await orgDefault(B, '1.3.0');

    // 1.0.0 is 3 behind 1.3.0: not yet.
    expect(await hygiene.notifyToolchainHygiene({ kind: 'behind', platformDefault: '1.3.0', previousDefault: '1.2.0' })).toEqual({ orgDefaultOrgs: 0, pinnedOrgs: 0 });

    await promoted('1.4.0');
    expect(await hygiene.notifyToolchainHygiene({ kind: 'behind', platformDefault: '1.4.0', previousDefault: '1.3.0' })).toEqual({ orgDefaultOrgs: 1, pinnedOrgs: 0 });
    expect(sent).toEqual([expect.objectContaining({ recipients: [toManagers(A)], subject: "Your organization's toolchain default 1.0.0 is 4 releases behind" })]);

    // Already past K before this change: not told again.
    sent.length = 0;
    await promoted('1.5.0');
    await hygiene.notifyToolchainHygiene({ kind: 'behind', platformDefault: '1.5.0', previousDefault: '1.4.0' });
    expect(sent).toEqual([]);
  });

  it('a fresh install (no previous default) or a move BACK never re-notifies a default already behind', async () => {
    await promoted('1.0.0', '1.1.0', '1.2.0', '1.3.0', '1.4.0');
    await orgDefault(A, '1.0.0');
    expect((await hygiene.notifyToolchainHygiene({ kind: 'behind', platformDefault: '1.4.0', previousDefault: null })).orgDefaultOrgs).toBe(1);
    sent.length = 0;
    await hygiene.notifyToolchainHygiene({ kind: 'behind', platformDefault: '1.3.0', previousDefault: '1.4.0' });
    expect(sent).toEqual([]);
  });

  it('releasesBehind counts (from, to]', () => {
    expect(hygiene.releasesBehind('1.0.0', '1.3.0', ['1.0.0', '1.1.0', '1.2.0', '1.3.0', '1.4.0', '1.1.0'])).toBe(3);
    expect(hygiene.releasesBehind('1.3.0', '1.3.0', ['1.3.0'])).toBe(0);
  });
});

describe('never throws', () => {
  it('a relay failure that cannot even be queued is counted, not thrown', async () => {
    await promoted('1.0.0');
    await orgDefault(A, '1.0.0');
    send.mockImplementationOnce(async () => { throw new Error('relay down'); });
    await expect(hygiene.notifyToolchainHygiene({ kind: 'deprecated', releaseVersion: '1.0.0' })).resolves.toEqual({ orgDefaultOrgs: 0, pinnedOrgs: 0 });
    expect(mockIncCounter).toHaveBeenCalledWith('toolchain_hygiene_notice_failures_total', { kind: 'deprecated' });
  });

  it('renders every org-default kind', () => {
    for (const event of [
      { kind: 'yanked', releaseVersion: '1.0.0' },
      { kind: 'deprecated', releaseVersion: '1.0.0' },
      { kind: 'vulnerable', releaseVersion: '1.0.0', plugin: 'cdk-synth', criticalFixable: 1, kev: 0 },
      { kind: 'behind', platformDefault: '1.5.0', previousDefault: '1.4.0' },
    ] as const) {
      const n = hygiene.renderOrgDefaultNotice(event, { releaseVersion: '1.0.0', platformDefault: null, behind: 4 });
      expect(n.subject).toContain('1.0.0');
      expect(n.text).toContain('Settings → Organization → Pipeline toolchain');
    }
    const many = Array.from({ length: 52 }, (_, i) => ({ id: `p${i}`, name: null, orgId: A }));
    expect(hygiene.renderPinnedNotice('1.0.0', null, many).text).toContain('… and 2 more');
  });
});
