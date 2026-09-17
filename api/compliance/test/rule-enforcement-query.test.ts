// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * ComplianceRuleService against the REAL pipeline-data CrudService, query
 * builders and schema (only the transaction is faked — see recording-db):
 *
 *  - the org's "own rules" enforcement query must not pull in published SYSTEM
 *    rules via the builder's system-org OR branch (subscription/paywall bypass);
 *  - a pinned subscription snapshot's effective window must be honored (jsonb
 *    returns the dates as strings);
 *  - create must 409 instead of overwriting a same-name rule, live OR deleted
 *    (a deleted rule comes back through restore, behind step-up);
 *  - impact-preview entities are secret-redacted like the live event path.
 */

import { resolve } from 'path';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';
import { createRecordingDb, paramsForColumn } from './helpers/recording-db.js';

const rdb = createRecordingDb();
const fakeTenancy = {
  withTenantTx: async (fn: (tx: unknown) => unknown) => fn(rdb.tx),
  runWithTenantContext: (_ctx: unknown, fn: () => unknown) => fn(),
  getTenantContext: () => undefined,
  requireTenantContext: () => ({}),
};

const { toComplianceAttributes } = await import('@pipeline-builder/api-core/lib/utils/compliance-attributes.js');
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({ toComplianceAttributes }));
// The real CrudService imports its transaction helper by relative path; fake
// only that module so every query is built for real but never hits a database.
jest.unstable_mockModule(resolve(process.cwd(), '../../packages/pipeline-data/lib/database/tenancy.js'), () => fakeTenancy);

const crud = await import('@pipeline-builder/pipeline-data/lib/api/crud-service.js');
const builders = await import('@pipeline-builder/pipeline-data/lib/api/query-builders.js');
const { schema } = await import('@pipeline-builder/pipeline-data/lib/database/drizzle-schema.js');

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => ({ ...crud, ...builders, schema, ...fakeTenancy }));
jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => ({ CoreConstants: { CACHE_TTL_COMPLIANCE_RULES: 60 } }));
jest.unstable_mockModule('../src/helpers/rule-change-notifier.js', () => ({ notifyPublishedRuleChange: async () => undefined }));

const { ComplianceRuleService } = await import('../src/services/compliance-rule-service.js');
const { evaluateRules } = await import('../src/engine/rule-engine.js');

const ORG = 'org-a';
const DAY = 24 * 60 * 60 * 1000;

function rule(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rule-1',
    orgId: '000000000000000000000001',
    name: 'no-bad-names',
    target: 'plugin',
    severity: 'error',
    scope: 'published',
    priority: 0,
    suppressNotification: false,
    field: 'name',
    operator: 'neq',
    value: 'bad',
    conditions: null,
    conditionMode: null,
    effectiveFrom: null,
    effectiveUntil: null,
    isActive: true,
    deletedAt: null,
    tags: [],
    ...overrides,
  };
}

describe('ComplianceRuleService — enforcement queries (real query builder)', () => {
  let svc: InstanceType<typeof ComplianceRuleService>;
  beforeEach(() => {
    rdb.reset();
    svc = new ComplianceRuleService();
  });

  it("restricts the org's own-rules query to scope='org' (published system rules only via subscription)", async () => {
    rdb.results.push([], []); // own rules, subscribed published rules
    await svc.findActiveByOrgAndTarget(ORG, 'plugin');

    const own = rdb.statements[0];
    expect(own.sql).toContain('from "compliance_rules"');
    // The builder's org predicate still ORs in (system AND published) for
    // catalog reads — the enforcement query must AND a scope='org' filter on top.
    expect(paramsForColumn(own, 'scope')).toContain('org');
    // Published rules reach enforcement only through the subscription join.
    expect(rdb.statements[1].sql).toContain('inner join "compliance_rules"');
  });

  it("honors a pinned snapshot's effective window (jsonb dates revived)", async () => {
    const future = new Date(Date.now() + 30 * DAY).toISOString();
    const past = new Date(Date.now() - 30 * DAY).toISOString();
    rdb.results.push(
      [],
      [
        // Pinned before the rule starts applying → must be skipped.
        { rule: rule({ id: 'r-future' }), subscription: { pinnedVersion: { ...rule({ id: 'r-future' }), effectiveFrom: future } } },
        // Pinned after the rule expired → must be skipped.
        { rule: rule({ id: 'r-expired' }), subscription: { pinnedVersion: { ...rule({ id: 'r-expired' }), effectiveUntil: past } } },
        // In-window pinned rule → enforced.
        { rule: rule({ id: 'r-live' }), subscription: { pinnedVersion: { ...rule({ id: 'r-live' }), effectiveFrom: past, effectiveUntil: future } } },
      ],
    );

    const rules = await svc.findActiveByOrgAndTarget(ORG, 'plugin');
    const result = evaluateRules(rules as never, { name: 'bad' }, []);

    expect(result.rulesSkipped).toBe(2);
    expect(result.violations.map((v) => v.ruleId)).toEqual(['r-live']);
  });

  it('409s instead of overwriting a same-name rule — live or deleted', async () => {
    rdb.results.push([]); // ON CONFLICT DO NOTHING: a conflicting row → nothing returned
    const err = await svc.create({ orgId: ORG, name: 'dup', target: 'plugin', scope: 'org' } as never, 'u-1')
      .then(() => null, (e: unknown) => e as { statusCode?: number; code?: string; message?: string });

    expect(err).toEqual(expect.objectContaining({ statusCode: 409, code: 'CONFLICT' }));
    expect(err?.message).toMatch(/restore it instead/);
    const insert = rdb.statements[0];
    expect(insert.sql).toMatch(/on conflict \("org_id","name"\) do nothing/);
    expect(insert.sql).not.toMatch(/do update/);
  });

  it('redacts secret values in impact-preview entities (keys kept for $keys/exists rules)', async () => {
    rdb.results.push(
      [{ id: 'p1', orgId: ORG, name: 'svc', env: { API_TOKEN: 'sekret' }, buildArgs: { NPM_TOKEN: 'npm-sekret' } }],
      [{ id: 'pl1', orgId: ORG, pipelineName: 'prod', props: { synth: { env: { DB_PASSWORD: 'pw' } } } }],
    );

    const plugins = await svc.findOrgEntitiesForTarget('plugin', ORG, 10);
    const pipelines = await svc.findOrgEntitiesForTarget('pipeline', ORG, 10);

    expect(plugins[0]).toEqual({ id: 'p1', name: 'svc', raw: expect.objectContaining({ env: { API_TOKEN: '[REDACTED]' }, buildArgs: { NPM_TOKEN: '[REDACTED]' } }) });
    expect(pipelines[0].name).toBe('prod');
    expect((pipelines[0].raw.props as any).synth.env).toEqual({ DB_PASSWORD: '[REDACTED]' });
    // A rule keyed on the env map still evaluates (keys preserved).
    const result = evaluateRules([rule({ field: 'env.API_TOKEN', operator: 'exists' })] as never, plugins[0].raw, []);
    expect(result.blocked).toBe(false);
    expect(JSON.stringify([plugins, pipelines])).not.toMatch(/sekret|"pw"/);
  });
});
