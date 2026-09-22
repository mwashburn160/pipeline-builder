// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Plugin contract enforcement at pipeline create/update (W0.2): each step's
 * plugin is resolved the way synth resolves it, and the pipeline's metadata /
 * vars are checked against that plugin's persisted contract.
 *
 * Real pipeline-core checks and the real pipeline-data query builder; only the
 * DB round-trip (`withTenantTx`) is faked, so the rendered WHERE / ORDER BY are
 * asserted as SQL.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { PgDialect } from 'drizzle-orm/pg-core';

type Row = Record<string, unknown>;
interface Captured { where: unknown; orderBy: unknown[] }

const captured: Captured[] = [];
/** Rows to return, per query in call order (default: none). */
let results: Row[][] = [];
const tenantContexts: unknown[] = [];

const actualData = jest.requireActual('@pipeline-builder/pipeline-data') as Record<string, unknown>;
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  ...actualData,
  withTenantTx: async (fn: (tx: unknown) => Promise<unknown>) => {
    const q: Captured = { where: undefined, orderBy: [] };
    const chain = {
      from: () => chain,
      where: (w: unknown) => { q.where = w; return chain; },
      orderBy: (...o: unknown[]) => { q.orderBy = o; return chain; },
      limit: async () => { captured.push(q); return results[captured.length - 1] ?? []; },
    };
    return fn({ select: () => chain });
  },
  runWithTenantContext: (ctx: unknown, fn: () => unknown) => {
    tenantContexts.push(ctx);
    return (actualData.runWithTenantContext as (c: unknown, f: () => unknown) => unknown)(ctx, fn);
  },
}));

const { findPluginContractViolations, formatContractViolations, resolveContractPlugin, setContractListingSourceForTests } =
  await import('../src/helpers/plugin-contract-check.js');

const dialect = new PgDialect();
const render = (q: Captured) => dialect.sqlToQuery(q.where as never);

function plugin(overrides: Row = {}): Row {
  return {
    id: 'p-1',
    orgId: 'org-a',
    name: 'helm-deploy',
    version: '2.0.0',
    requiredMetadata: [],
    requiredVars: [],
    metadataTypes: {},
    varsTypes: {},
    ...overrides,
  };
}

beforeEach(() => {
  captured.length = 0;
  tenantContexts.length = 0;
  results = [];
});

describe('resolveContractPlugin', () => {
  it('matches the exact name among visible live rows, own org first, then default, then highest semver', async () => {
    results = [[plugin()]];
    await expect(resolveContractPlugin({ name: 'helm-deploy', isActive: true, isDefault: true }, 'org-a')).resolves.toEqual({ plugin: { ...plugin(), publisher: null } });

    const { sql, params } = render(captured[0]!);
    expect(sql).toContain('"plugins"."name" = $');
    expect(sql).not.toContain('ilike');
    expect(sql).toContain('"plugins"."deleted_at" is null');
    expect(params).toContain('helm-deploy');
    const order = dialect.sqlToQuery(captured[0]!.orderBy[0] as never);
    expect(order.sql).toContain('CASE "plugins"."org_id" WHEN $1 THEN 0 ELSE 2 END');
    expect(order.params).toEqual(['org-a']);
    expect(tenantContexts).toEqual([]);
  });

  it('ranks the parent org second for a team caller and reads it under system context', async () => {
    results = [[]];
    await expect(resolveContractPlugin({ name: 'x' }, 'team-1', 'org-a')).resolves.toBeNull();
    const order = dialect.sqlToQuery(captured[0]!.orderBy[0] as never);
    expect(order.sql).toContain('WHEN $2 THEN 1');
    expect(order.params).toEqual(['team-1', 'org-a']);
    // The row read, then the (elevated) listing fallback.
    expect(tenantContexts).toEqual([{ isSuperAdmin: true }, { isSuperAdmin: true }]);
  });
});

/** An in-memory listing source for the listing half of resolution. */
function listingSource(data: { publishers?: Row[]; listings?: Row[]; versions?: Row[]; installs?: Row[]; policies?: Row[] }) {
  const d = { publishers: [], listings: [], versions: [], installs: [], policies: [], ...data } as Record<string, Row[]>;
  return () => ({
    publisherByHandle: async (h: string) => d.publishers!.find((p) => p.handle === h) ?? null,
    publishersByIds: async (ids: string[]) => d.publishers!.filter((p) => ids.includes(p.id as string)),
    listingByName: async (pid: string, name: string) => d.listings!.find((l) => l.publisherId === pid && l.name === name) ?? null,
    liveListings: async () => d.listings!,
    versionsForListings: async (ids: string[]) => d.versions!.filter((v) => ids.includes(v.listingId as string)),
    advisoriesForListings: async () => [],
    installsForOrgs: async (orgIds: string[]) => d.installs!.filter((i) => orgIds.includes(i.orgId as string)),
    policiesForOrgs: async (orgIds: string[]) => d.policies!.filter((p) => orgIds.includes(p.orgId as string)),
  }) as never;
}

describe('listed plugins (plugin ecosystem §3.5)', () => {
  const official = { id: 'pub-o', handle: 'pipeline-builder', tier: 'official', suspendedAt: null };
  const acme = { id: 'pub-a', handle: 'acme', tier: 'verified', suspendedAt: null };
  const version = (listingId: string, v: string, snap: Row = {}) => ({
    id: `${listingId}-${v}`,
    listingId,
    version: v,
    yankedAt: null,
    pausedAt: null,
    breaking: false,
    deprecatedAt: null,
    imageDigest: null,
    imageRepository: null,
    specSnapshot: { requiredVars: ['cluster'], ...snap },
    changelog: null,
  });
  afterEach(() => setContractListingSourceForTests(null));

  it('falls back to the Official listing and checks its frozen contract', async () => {
    setContractListingSourceForTests(listingSource({
      publishers: [official],
      listings: [{ id: 'l-h', publisherId: 'pub-o', name: 'helm-deploy', state: 'listed' }],
      versions: [version('l-h', '1.0.0')],
    }));
    results = [[]];
    const violations = await findPluginContractViolations({ stages: [{ stageName: 'd', steps: [{ plugin: { name: 'helm-deploy' } }] }] }, 'org-a');
    expect(violations).toEqual([expect.objectContaining({ plugin: 'pipeline-builder/helm-deploy', version: '1.0.0', missing: ['vars.cluster'] })]);
  });

  it('resolves a publisher reference only through its install, and reports a refusal per step', async () => {
    const src = {
      publishers: [acme],
      listings: [{ id: 'l-l', publisherId: 'pub-a', name: 'lint', state: 'listed' }],
      versions: [version('l-l', '1.0.0', { requiredVars: [] })],
    };
    setContractListingSourceForTests(listingSource(src));
    const props = {
      stages: [{
        stageName: 'scan',
        steps: [
          { plugin: { publisher: 'acme', name: 'lint', filter: { version: '^1.0.0' } } },
          { plugin: { publisher: 'nobody', name: 'lint' } },
        ],
      }],
    };
    const violations = await findPluginContractViolations(props, 'org-a');
    expect(captured).toHaveLength(0); // own rows are never considered for a qualified reference
    expect(violations).toEqual([
      { path: 'stages[0].steps[0]', step: 'scan/acme/lint', plugin: 'acme/lint', version: '^1.0.0', missing: [], invalid: [], refusal: { code: 'PLUGIN_NOT_INSTALLED', reason: 'not_installed', message: 'acme/lint is not installed in your organization.' } },
      { path: 'stages[0].steps[1]', step: 'scan/nobody/lint', plugin: 'nobody/lint', version: '', missing: [], invalid: [], refusal: { code: 'NOT_FOUND', reason: 'no_listing', message: 'No listing nobody/lint.' } },
    ]);
    expect(formatContractViolations(violations)).toContain('  • scan/acme/lint (acme/lint): acme/lint is not installed in your organization.');

    setContractListingSourceForTests(listingSource({
      ...src,
      installs: [{ id: 'i', orgId: 'org-a', listingId: 'l-l', status: 'active', versionPolicy: 'minor', pinnedVersion: '1.0.0', resolvedVersion: null }],
    }));
    await expect(findPluginContractViolations(props, 'org-a').then((v) => v.map((x) => x.plugin))).resolves.toEqual(['nobody/lint']);
    await expect(resolveContractPlugin({ publisher: 'acme', name: 'lint' }, 'org-a')).resolves.toEqual({
      plugin: { id: 'l-l-1.0.0', orgId: null, publisher: 'acme', name: 'lint', version: '1.0.0', requiredMetadata: [], requiredVars: [], metadataTypes: {}, varsTypes: {} },
    });
  });

  it('never tries a listing for an id pin or a nameless filter', async () => {
    results = [[], []];
    await expect(resolveContractPlugin({ id: 'p-1' } as never, 'org-a')).resolves.toBeNull();
    await expect(resolveContractPlugin({ version: '1.0.0' }, 'org-a')).resolves.toBeNull();
  });
});

describe('findPluginContractViolations', () => {
  const props = {
    project: 'p',
    organization: 'o',
    global: { replicas: 'two' },
    vars: { branch: 'main' },
    synth: { plugin: { name: 'cdk-synth' } },
    stages: [
      { stageName: 'deploy', steps: [{ plugin: { name: 'helm-deploy', alias: 'helm' } }] },
      { stageName: 'verify', steps: [{ plugin: { name: 'helm-deploy' } }, { plugin: { name: 'ghost' } }] },
    ],
  };

  it('reports every missing / ill-typed key per step, resolving each distinct filter once', async () => {
    results = [
      [plugin({ name: 'cdk-synth', version: '1.0.0', requiredVars: ['branch'] })],
      [plugin({ requiredMetadata: ['namespace', 'replicas'], metadataTypes: { replicas: 'number' } })],
      [], // `ghost` resolves to nothing — not a contract problem
    ];
    const violations = await findPluginContractViolations(props, 'org-a');

    expect(captured).toHaveLength(3); // cdk-synth, helm-deploy (shared by two steps), ghost
    expect(violations).toEqual([
      {
        path: 'stages[0].steps[0]',
        step: 'deploy/helm',
        plugin: 'helm-deploy',
        version: '2.0.0',
        missing: ['metadata.namespace'],
        invalid: [{ key: 'metadata.replicas', expected: 'number', message: 'pipeline metadata.replicas must be a number, got "two"' }],
      },
      {
        path: 'stages[1].steps[0]',
        step: 'verify/helm-deploy',
        plugin: 'helm-deploy',
        version: '2.0.0',
        missing: ['metadata.namespace'],
        invalid: [{ key: 'metadata.replicas', expected: 'number', message: 'pipeline metadata.replicas must be a number, got "two"' }],
      },
    ]);
    expect(formatContractViolations(violations)).toBe(
      'Pipeline does not meet the contract of 2 plugin steps:\n'
      + '  • deploy/helm (helm-deploy@2.0.0): missing metadata.namespace; metadata.replicas must be a number\n'
      + '  • verify/helm-deploy (helm-deploy@2.0.0): missing metadata.namespace; metadata.replicas must be a number',
    );
  });

  it('is empty when every contract is met', async () => {
    results = [
      [plugin({ name: 'cdk-synth', requiredVars: ['branch'] })],
      [plugin({ requiredMetadata: ['replicas'] })],
      [plugin({ name: 'ghost' })],
    ];
    await expect(findPluginContractViolations(props, 'org-a')).resolves.toEqual([]);
  });

  it('honours an explicit lookup filter (version pin) and skips one the lookup schema rejects', async () => {
    results = [[plugin({ version: '1.2.0', requiredVars: ['cluster'] })]];
    const violations = await findPluginContractViolations({
      synth: { plugin: { name: 'helm-deploy', filter: { version: '1.2.0' } } },
      stages: [{ stageName: 's', steps: [{ plugin: { name: 'bad', filter: { version: '' } } }] }],
    }, 'org-a');

    expect(captured).toHaveLength(1);
    expect(render(captured[0]!).params).toContain('1.2.0');
    expect(formatContractViolations(violations)).toBe(
      'Pipeline does not meet the contract of 1 plugin step:\n  • synth (helm-deploy@1.2.0): missing vars.cluster',
    );
  });

  it('does nothing for props without plugin steps', async () => {
    await expect(findPluginContractViolations(undefined, 'org-a')).resolves.toEqual([]);
    expect(captured).toHaveLength(0);
  });
});
