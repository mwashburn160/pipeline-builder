// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The managed toolchain resolver (docs/plans/bootstrap-image-versioning.md §2,
 * §5, D11, D15) against REAL SQL: the shipped `postgres-init.sql` on PGlite,
 * read as the APPLICATION role under the elevated (sysadmin) scope the resolver
 * uses — so the dedicated toolchain RLS policies are exercised too.
 */

import type { PGlite } from '@electric-sql/pglite';
import { describe, it, expect, beforeAll, afterAll, beforeEach, jest } from '@jest/globals';
import { toolchainMetadata } from '@pipeline-builder/api-core';
import { drizzle } from 'drizzle-orm/pglite';
import { SYSTEM_ORG, asTenant, bootInitDb } from './helpers/pglite-init.js';
import {
  isEligibleRelease,
  isEligibleReleaseWith,
  ManagedToolchainError,
  managedToolchainRefusal,
  resolveManagedToolchain,
  resolveManagedToolchainHalf,
  resolveManagedToolchainWith,
  setManagedToolchainDepsForTests,
  toolchainOrgChain,
  type ManagedToolchainDeps,
  type ToolchainDb,
} from '../src/api/managed-toolchain.js';
import { schema } from '../src/database/drizzle-schema.js';

let pg: PGlite;
let db: ReturnType<typeof drizzle>;

beforeAll(async () => {
  pg = await bootInitDb();
  db = drizzle(pg);
}, 120_000);
afterAll(async () => { await pg?.close(); });

// team → mid → root; `other` is an unrelated root.
const ROOT = 'aaaaaaaaaaaaaaaaaaaaaaa1';
const MID = 'aaaaaaaaaaaaaaaaaaaaaaa2';
const TEAM = 'aaaaaaaaaaaaaaaaaaaaaaa3';
const OTHER = 'bbbbbbbbbbbbbbbbbbbbbbb1';
const PARENTS: Record<string, string | undefined> = { [TEAM]: MID, [MID]: ROOT };

const TOOLCHAIN = { pipelineManager: '3.4.0', awsCdk: '2.275.0', cdkAssets: '3.1.0', esbuild: '0.25.0', pnpm: '10.0.0', node: '22.11.0' };

function deps(parents: Record<string, string | undefined> = PARENTS): ManagedToolchainDeps & { getParent: jest.Mock } {
  return {
    // The resolver's elevated scope, as the app role.
    read: (fn) => asTenant(pg, { isSysadmin: true }, () => fn(db as unknown as ToolchainDb)),
    getParent: jest.fn(async (orgId: string) => parents[orgId]),
  } as ManagedToolchainDeps & { getParent: jest.Mock };
}

interface HalfOpts { orgId?: string; yanked?: boolean; deprecated?: boolean; deleted?: boolean; scanned?: boolean; criticalFixable?: number; toolchain?: boolean; isActive?: boolean }

async function insertHalf(name: 'pipeline-bootstrap' | 'cdk-synth', version: string, o: HalfOpts = {}): Promise<void> {
  const now = new Date();
  await db.insert(schema.plugin).values({
    orgId: o.orgId ?? SYSTEM_ORG,
    name,
    version,
    createdBy: 'test',
    updatedBy: 'test',
    pluginType: name === 'pipeline-bootstrap' ? 'BuildImage' : 'CodeBuildStep',
    imageDigest: `sha256:${'c'.repeat(64)}`,
    isActive: o.isActive ?? true,
    isDefault: false,
    ...(o.scanned === false ? {} : { scannedAt: now, vulnCriticalFixable: o.criticalFixable ?? 0 }),
    ...(name === 'pipeline-bootstrap' && o.toolchain !== false ? { metadata: toolchainMetadata(TOOLCHAIN) } : {}),
    ...(o.yanked ? { yankedAt: now, yankReason: 'bad build', lifecycle: 'yanked' } : {}),
    ...(o.deprecated ? { deprecatedAt: now, deprecationMessage: 'superseded', lifecycle: 'deprecated' } : {}),
    ...(o.deleted ? { deletedAt: now } : {}),
  } as never);
}

/** A full release: the release row and both system-org halves. */
async function release(version: string, o: HalfOpts & { synth?: false } = {}): Promise<void> {
  await db.insert(schema.toolchainRelease).values({ releaseVersion: version, createdBy: 'test' });
  await insertHalf('pipeline-bootstrap', version, o);
  if (o.synth !== false) await insertHalf('cdk-synth', version, o);
}

async function setPlatformDefault(version: string): Promise<void> {
  await db.insert(schema.toolchainPlatformDefault).values({ releaseVersion: version, setBy: 'test' })
    .onConflictDoUpdate({ target: schema.toolchainPlatformDefault.singleton, set: { releaseVersion: version } });
  await db.insert(schema.toolchainDefaultHistory).values({ releaseVersion: version, setBy: 'test', kind: 'set' });
}

async function orgDefault(orgId: string, version: string): Promise<void> {
  await db.insert(schema.orgToolchainDefault).values({ orgId, releaseVersion: version, setBy: 'test' });
}

async function canary(orgId: string, version: string): Promise<void> {
  // PK org_id: adding an org to another release MOVES it.
  await db.insert(schema.toolchainRollout).values({ orgId, releaseVersion: version, addedBy: 'test' })
    .onConflictDoUpdate({ target: schema.toolchainRollout.orgId, set: { releaseVersion: version } });
}

beforeEach(async () => {
  await pg.exec(`
    DELETE FROM toolchain_rollout; DELETE FROM org_toolchain_default; DELETE FROM org_toolchain_default_history;
    DELETE FROM toolchain_platform_default; DELETE FROM toolchain_default_history; DELETE FROM toolchain_release;
    DELETE FROM plugins WHERE name IN ('pipeline-bootstrap', 'cdk-synth');
  `);
});

const resolve = (orgId: string, releasePin?: string, d = deps()) =>
  resolveManagedToolchainWith(d, { orgId }, releasePin ? { releasePin } : {});

async function rejection(p: Promise<unknown>): Promise<ManagedToolchainError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ManagedToolchainError);
    return err as ManagedToolchainError;
  }
  throw new Error('expected a rejection');
}

describe('resolveManagedToolchain — no default (D11)', () => {
  it('refuses 409 TOOLCHAIN_NO_DEFAULT, never the highest version', async () => {
    await release('1.0.0');
    await release('9.9.9');
    const err = await rejection(resolve(TEAM));
    expect(err.code).toBe('TOOLCHAIN_NO_DEFAULT');
    expect(err.statusCode).toBe(409);
  });
});

describe('resolveManagedToolchain — precedence across team → mid → root', () => {
  beforeEach(async () => {
    for (const v of ['1.0.0', '1.1.0', '1.2.0', '1.3.0', '1.4.0', '1.5.0']) await release(v);
    await setPlatformDefault('1.0.0');
  });

  it('falls back to the platform default, without walking when no org has a setting', async () => {
    const d = deps();
    const res = await resolve(TEAM, undefined, d);
    expect(res).toMatchObject({ releaseVersion: '1.0.0', resolvedVia: 'default', warnings: [] });
    expect(d.getParent).not.toHaveBeenCalled();
  });

  it('serves the NEAREST canary', async () => {
    await canary(ROOT, '1.1.0');
    expect(await resolve(TEAM)).toMatchObject({ releaseVersion: '1.1.0', resolvedVia: 'canary' });
    await canary(MID, '1.2.0');
    expect(await resolve(TEAM)).toMatchObject({ releaseVersion: '1.2.0', resolvedVia: 'canary' });
    // Root itself is still on its own canary.
    expect(await resolve(ROOT)).toMatchObject({ releaseVersion: '1.1.0', resolvedVia: 'canary' });
    // An unrelated org never sees it.
    expect(await resolve(OTHER)).toMatchObject({ releaseVersion: '1.0.0', resolvedVia: 'default' });
  });

  it('an org default anywhere on the chain beats any canary; the nearest org default wins', async () => {
    await canary(TEAM, '1.1.0');
    await orgDefault(ROOT, '1.0.0');
    await db.insert(schema.toolchainDefaultHistory).values({ releaseVersion: '1.3.0', setBy: 'test', kind: 'set' });
    expect(await resolve(TEAM)).toMatchObject({ releaseVersion: '1.0.0', resolvedVia: 'org-default' });
    await orgDefault(MID, '1.3.0');
    expect(await resolve(TEAM)).toMatchObject({ releaseVersion: '1.3.0', resolvedVia: 'org-default' });
    await orgDefault(TEAM, '1.1.0');
    expect(await resolve(TEAM)).toMatchObject({ releaseVersion: '1.1.0', resolvedVia: 'org-default' });
    // The parent is unaffected by its team's setting.
    expect(await resolve(MID)).toMatchObject({ releaseVersion: '1.3.0', resolvedVia: 'org-default' });
  });

  it('a release pin beats everything', async () => {
    await canary(TEAM, '1.1.0');
    await orgDefault(TEAM, '1.2.0');
    expect(await resolve(TEAM, '1.4.0')).toMatchObject({ releaseVersion: '1.4.0', resolvedVia: 'pin' });
  });

  it('a second canary membership for an org MOVES it (PK org_id)', async () => {
    await canary(TEAM, '1.1.0');
    await canary(TEAM, '1.2.0');
    const rows = await db.select().from(schema.toolchainRollout);
    expect(rows).toHaveLength(1);
    expect(await resolve(TEAM)).toMatchObject({ releaseVersion: '1.2.0', resolvedVia: 'canary' });
    await expect(db.insert(schema.toolchainRollout).values({ orgId: TEAM, releaseVersion: '1.3.0', addedBy: 'test' })).rejects.toThrow();
  });

  it('a canary that fails its scan or metadata guard falls through to the platform default, silently', async () => {
    await release('2.0.0', { scanned: false });
    await canary(TEAM, '2.0.0');
    const unscanned = await resolve(TEAM);
    expect(unscanned).toMatchObject({ releaseVersion: '1.0.0', resolvedVia: 'default', warnings: [] });
    await release('2.1.0', { toolchain: false });
    await canary(TEAM, '2.1.0');
    expect(await resolve(TEAM)).toMatchObject({ releaseVersion: '1.0.0', resolvedVia: 'default' });
    await release('2.2.0', { criticalFixable: 3 });
    await canary(TEAM, '2.2.0');
    expect(await resolve(TEAM)).toMatchObject({ releaseVersion: '1.0.0', resolvedVia: 'default' });
  });
});

describe('resolveManagedToolchain — existence at resolve time, eligibility at set time', () => {
  beforeEach(async () => {
    await release('1.0.0');
    await setPlatformDefault('1.0.0');
  });

  it('a yanked pin still resolves, with a warning', async () => {
    await release('1.1.0', { yanked: true });
    await db.insert(schema.toolchainDefaultHistory).values({ releaseVersion: '1.1.0', setBy: 'test', kind: 'set' });
    const res = await resolve(TEAM, '1.1.0');
    expect(res.releaseVersion).toBe('1.1.0');
    expect(res.warnings.map((w) => w.code)).toEqual(['TOOLCHAIN_RELEASE_YANKED']);
    expect(res.warnings[0]).toMatchObject({ severity: 'warning', message: expect.stringMatching(/bad build/) });
    expect(await isEligibleReleaseWith(deps(), TEAM, '1.1.0')).toBe(false);
  });

  it('a deprecated org default still resolves, with a warning', async () => {
    await release('1.2.0', { deprecated: true });
    await db.insert(schema.toolchainDefaultHistory).values({ releaseVersion: '1.2.0', setBy: 'test', kind: 'set' });
    await orgDefault(ROOT, '1.2.0');
    const res = await resolve(TEAM);
    expect(res).toMatchObject({ releaseVersion: '1.2.0', resolvedVia: 'org-default' });
    expect(res.warnings.map((w) => w.code)).toEqual(['TOOLCHAIN_RELEASE_DEPRECATED']);
    expect(await isEligibleReleaseWith(deps(), TEAM, '1.2.0')).toBe(false);
  });

  it('an ex-canary release that was never promoted still resolves for a pin, with a warning', async () => {
    await release('1.3.0');
    await canary(TEAM, '1.3.0');
    // In canary for the caller: eligible, and no warning.
    expect(await isEligibleReleaseWith(deps(), TEAM, '1.3.0')).toBe(true);
    expect((await resolve(TEAM, '1.3.0')).warnings).toEqual([]);
    // Not for an org outside the canary.
    expect(await isEligibleReleaseWith(deps(), OTHER, '1.3.0')).toBe(false);
    // Removed from the canary: the pin keeps resolving, loudly, and can't be set again.
    await pg.exec('DELETE FROM toolchain_rollout');
    const res = await resolve(TEAM, '1.3.0');
    expect(res).toMatchObject({ releaseVersion: '1.3.0', resolvedVia: 'pin' });
    expect(res.warnings.map((w) => w.code)).toEqual(['TOOLCHAIN_RELEASE_NOT_PROMOTED']);
    expect(await isEligibleReleaseWith(deps(), TEAM, '1.3.0')).toBe(false);
  });

  it('eligibility: a former platform default is eligible for every org; an unpromoted one for none', async () => {
    await release('1.4.0');
    expect(await isEligibleReleaseWith(deps(), OTHER, '1.0.0')).toBe(true);
    expect(await isEligibleReleaseWith(deps(), OTHER, '1.4.0')).toBe(false);
    expect(await isEligibleReleaseWith(deps(), OTHER, '7.7.7')).toBe(false);
    expect(await isEligibleReleaseWith(deps(), OTHER, 'not-a-version')).toBe(false);
  });

  it('eligibility needs both halves live', async () => {
    await release('1.5.0', { synth: false });
    await db.insert(schema.toolchainDefaultHistory).values({ releaseVersion: '1.5.0', setBy: 'test', kind: 'set' });
    expect(await isEligibleReleaseWith(deps(), TEAM, '1.5.0')).toBe(false);
  });

  it('a deleted or unknown pin is 404 NOT_FOUND, never a fallback', async () => {
    await release('1.6.0', { deleted: true });
    for (const pin of ['1.6.0', '8.8.8']) {
      const err = await rejection(resolve(TEAM, pin));
      expect(err.code).toBe('NOT_FOUND');
      expect(err.statusCode).toBe(404);
    }
    expect((await rejection(resolve(TEAM, '^1.0.0'))).code).toBe('VALIDATION_ERROR');
  });
});

describe('resolveManagedToolchain — one release, system rows only, nothing about other orgs', () => {
  it('both halves come from ONE release; an incomplete default is refused (PAIR_MISMATCH)', async () => {
    await release('1.0.0', { synth: false });
    await setPlatformDefault('1.0.0');
    const err = await rejection(resolve(TEAM));
    expect(err.code).toBe('TOOLCHAIN_PAIR_MISMATCH');
    expect(err.statusCode).toBe(500);

    await release('1.1.0');
    await setPlatformDefault('1.1.0');
    const res = await resolve(TEAM);
    expect(res.bootstrap.version).toBe('1.1.0');
    expect(res.synth.version).toBe('1.1.0');
    expect(res.bootstrap.name).toBe('pipeline-bootstrap');
    expect(res.synth.name).toBe('cdk-synth');
  });

  it("a customer's same-named rows are never candidates, for any caller", async () => {
    await release('1.0.0');
    await setPlatformDefault('1.0.0');
    // Same names in the caller's org and its parent, at the default's version AND higher.
    for (const orgId of [TEAM, MID]) {
      for (const v of ['1.0.0', '99.0.0']) {
        await insertHalf('cdk-synth', v, { orgId });
        await insertHalf('pipeline-bootstrap', v, { orgId });
      }
    }
    for (const caller of [TEAM, MID, SYSTEM_ORG]) {
      const res = await resolve(caller);
      expect(res.bootstrap.orgId).toBe(SYSTEM_ORG);
      expect(res.synth.orgId).toBe(SYSTEM_ORG);
    }
    // A pin to the customer-only version doesn't find the customer's rows either.
    expect((await rejection(resolve(TEAM, '99.0.0'))).code).toBe('NOT_FOUND');
  });

  it('the answer carries resolvedVia and nothing about rollout membership or other orgs', async () => {
    await release('1.0.0');
    await release('1.1.0');
    await setPlatformDefault('1.0.0');
    await canary(ROOT, '1.1.0');
    await orgDefault(OTHER, '1.0.0');
    const res = await resolve(TEAM);
    expect(Object.keys(res).sort()).toEqual(['bootstrap', 'releaseVersion', 'resolvedVia', 'synth', 'warnings']);
    const text = JSON.stringify(res);
    for (const id of [ROOT, MID, OTHER]) expect(text).not.toContain(id);
  });
});

describe('toolchainOrgChain', () => {
  it('walks caller → … → root, own org first', async () => {
    expect(await toolchainOrgChain(TEAM, async (id) => PARENTS[id])).toEqual([TEAM, MID, ROOT]);
    expect(await toolchainOrgChain(SYSTEM_ORG, async () => { throw new Error('never asked'); })).toEqual([SYSTEM_ORG]);
  });

  it('fails closed on a cycle, an over-deep chain or a lookup failure', async () => {
    await expect(toolchainOrgChain('a', async (id) => (id === 'a' ? 'b' : 'a'))).rejects.toThrow(/cycle/);
    let n = 0;
    await expect(toolchainOrgChain('x0', async () => `x${++n}`)).rejects.toThrow(/deeper/);
    await expect(toolchainOrgChain('a', async () => { throw new Error('platform down'); })).rejects.toThrow(/platform down/);
  });
});

describe('the production entry points (deps injected through the test hook)', () => {
  beforeEach(() => { setManagedToolchainDepsForTests(deps()); });
  afterAll(() => { setManagedToolchainDepsForTests(null); });

  it('resolveManagedToolchain / isEligibleRelease / resolveManagedToolchainHalf answer from the same resolver', async () => {
    await release('1.0.0');
    await setPlatformDefault('1.0.0');
    expect(await resolveManagedToolchain({ orgId: TEAM })).toMatchObject({ releaseVersion: '1.0.0', resolvedVia: 'default' });
    expect(await isEligibleRelease(TEAM, '1.0.0')).toBe(true);
    const half = await resolveManagedToolchainHalf({ orgId: TEAM }, 'pipeline-bootstrap');
    expect(half).toMatchObject({ plugin: { name: 'pipeline-bootstrap', version: '1.0.0' }, resolution: { releaseVersion: '1.0.0' } });
    const synthHalf = await resolveManagedToolchainHalf({ orgId: TEAM }, 'cdk-synth', { releasePin: '1.0.0' });
    expect(synthHalf).toMatchObject({ plugin: { name: 'cdk-synth' }, resolution: { resolvedVia: 'pin' } });
  });

  it('resolveManagedToolchainHalf turns a resolver refusal into a step refusal', async () => {
    expect(await resolveManagedToolchainHalf({ orgId: TEAM }, 'cdk-synth')).toMatchObject({ refusal: { code: 'PLUGIN_UNAVAILABLE', reason: 'toolchain_no_default' } });
    expect(await resolveManagedToolchainHalf({ orgId: TEAM }, 'cdk-synth', { releasePin: '3.3.3' })).toMatchObject({ refusal: { code: 'NOT_FOUND', reason: 'toolchain_release_not_found' } });
  });

  it('managedToolchainRefusal maps every resolver code', () => {
    const r = (code: string) => managedToolchainRefusal(new ManagedToolchainError(code as never, 'm', { x: 1 }));
    expect(r('NOT_FOUND')).toMatchObject({ code: 'NOT_FOUND', reason: 'toolchain_release_not_found', details: { x: 1 } });
    expect(r('VALIDATION_ERROR')).toMatchObject({ code: 'NOT_FOUND', reason: 'toolchain_release_invalid' });
    expect(r('TOOLCHAIN_NO_DEFAULT')).toEqual({ code: 'PLUGIN_UNAVAILABLE', reason: 'toolchain_no_default', message: 'm' });
    expect(r('TOOLCHAIN_PAIR_MISMATCH')).toMatchObject({ code: 'PLUGIN_UNAVAILABLE', reason: 'toolchain_unresolved' });
  });

  it('a non-resolver error propagates (a hierarchy failure never resolves the wrong org)', async () => {
    await release('1.0.0');
    await setPlatformDefault('1.0.0');
    await orgDefault(ROOT, '1.0.0');
    setManagedToolchainDepsForTests({ ...deps(), getParent: async () => { throw new Error('platform down'); } });
    await expect(resolveManagedToolchainHalf({ orgId: TEAM }, 'cdk-synth')).rejects.toThrow(/platform down/);
  });
});

describe('resolveManagedToolchain — standing warnings and broken invariants', () => {
  it('warns on an inactive pin, and on yanked / deprecated ones without a message', async () => {
    await release('1.0.0');
    await setPlatformDefault('1.0.0');
    await release('1.1.0', { isActive: false });
    await db.insert(schema.toolchainDefaultHistory).values({ releaseVersion: '1.1.0', setBy: 'test', kind: 'set' });
    expect((await resolve(TEAM, '1.1.0')).warnings.map((w) => w.code)).toEqual(['TOOLCHAIN_RELEASE_INACTIVE']);
    expect(await isEligibleReleaseWith(deps(), TEAM, '1.1.0')).toBe(false);

    await db.insert(schema.toolchainRelease).values({ releaseVersion: '1.2.0', createdBy: 'test' });
    await db.insert(schema.plugin).values([
      { orgId: SYSTEM_ORG, name: 'pipeline-bootstrap', version: '1.2.0', createdBy: 't', updatedBy: 't', yankedAt: new Date(), lifecycle: 'yanked' },
      { orgId: SYSTEM_ORG, name: 'cdk-synth', version: '1.2.0', createdBy: 't', updatedBy: 't', deprecatedAt: new Date(), lifecycle: 'deprecated' },
    ] as never);
    const res = await resolve(TEAM, '1.2.0');
    expect(res.warnings.map((w) => w.code)).toEqual(['TOOLCHAIN_RELEASE_YANKED', 'TOOLCHAIN_RELEASE_DEPRECATED', 'TOOLCHAIN_RELEASE_NOT_PROMOTED']);
    expect(res.warnings[1]!.message).toMatch(/deprecated\.$/);
  });

  it('an org default whose half was deleted underneath it is refused (PAIR_MISMATCH), never a fallback', async () => {
    await release('1.0.0');
    await setPlatformDefault('1.0.0');
    await release('1.3.0');
    await orgDefault(MID, '1.3.0');
    await pg.exec("UPDATE plugins SET deleted_at = now() WHERE name = 'cdk-synth' AND version = '1.3.0'");
    const err = await rejection(resolve(TEAM));
    expect(err.code).toBe('TOOLCHAIN_PAIR_MISMATCH');
    expect(err.details).toMatchObject({ releaseVersion: '1.3.0', missing: ['cdk-synth'] });
  });

  it('a malformed release version is never eligible and a system-org caller never walks', async () => {
    await release('1.0.0');
    await setPlatformDefault('1.0.0');
    await canary(ROOT, '1.0.0');
    const d = deps();
    expect(await resolve(SYSTEM_ORG, undefined, d)).toMatchObject({ releaseVersion: '1.0.0', resolvedVia: 'default' });
    expect(d.getParent).not.toHaveBeenCalled();
    expect(await isEligibleReleaseWith(d, SYSTEM_ORG, '1.0')).toBe(false);
  });
});
