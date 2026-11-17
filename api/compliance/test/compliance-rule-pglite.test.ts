// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Compliance rules against a REAL Postgres: rule CRUD + its history trail, and
 * the database half of `/validate` (the active-rule read feeding the engine).
 *
 * The mock-based suites pin which calls the service makes; this one runs
 * `complianceRuleService` unmodified through pipeline-data's real `withTenantTx`,
 * as the application role under the init script's RLS, FORCE flags and unique
 * indexes (`@pipeline-builder/pipeline-data/testing`).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { ConcurrencyConflictError, ConflictError } from '@pipeline-builder/api-core';
import { asTenantContext, bootTenantDb, type TenantTestDb } from '@pipeline-builder/pipeline-data/testing';

const { complianceRuleService, InvalidRuleRegexError } = await import('../src/services/compliance-rule-service.js');
const { evaluateEntity } = await import('../src/helpers/evaluate-entity.js');

let tdb: TenantTestDb;
// The raw PGlite handle's type, via the testing entry (PGlite is pipeline-data's dependency, not this service's).
type PGlite = TenantTestDb['pglite'];
const owner = <T>(fn: (q: PGlite) => Promise<T>) => tdb.asOwner(fn);

const ORG = 'org-comply';
const OTHER = 'org-other';
const USER = 'user-1';

const as = <T>(fn: () => Promise<T>, orgId = ORG) => asTenantContext({ orgId, userId: USER }, fn);

const ruleInput = (over: Record<string, unknown> = {}) => ({
  orgId: ORG,
  name: 'project-must-be-web',
  target: 'pipeline' as const,
  severity: 'error' as const,
  field: 'project',
  operator: 'eq' as const,
  value: 'web',
  createdBy: USER,
  updatedBy: USER,
  ...over,
});

/** History rows commit WITH the mutation (in-tx hooks): read them straight away, no polling. */
async function historyFor(ruleId: string): Promise<Array<{ change_type: string; previous_state: unknown }>> {
  const { rows } = await owner((q) => q.query<{ change_type: string; previous_state: unknown }>(
    'SELECT change_type, previous_state FROM compliance_rule_history WHERE rule_id = $1 ORDER BY changed_at, change_type',
    [ruleId],
  ));
  return rows;
}

beforeAll(async () => {
  tdb = await bootTenantDb();
}, 120_000);

afterAll(async () => {
  // Let the fire-and-forget side effects (cache invalidation, rule-change scan)
  // drain before PGlite closes under them.
  await new Promise((r) => setTimeout(r, 100));
  await tdb?.close();
});

beforeEach(async () => {
  await owner((q) => q.exec('DELETE FROM compliance_rule_history; DELETE FROM compliance_scans; DELETE FROM compliance_rules;'));
});

describe('rule CRUD + history (real Postgres, RLS)', () => {
  it('create → update → delete records each change, with the PRIOR state', async () => {
    const created = await as(() => complianceRuleService.create(ruleInput() as never, USER));
    expect(created).toMatchObject({ orgId: ORG, name: 'project-must-be-web', scope: 'org', isActive: true });

    const updated = await as(() => complianceRuleService.update(created.id, { value: 'api' }, ORG, USER));
    expect(updated?.value).toBe('api');

    const deleted = await as(() => complianceRuleService.delete(created.id, ORG, USER));
    expect(deleted?.id).toBe(created.id);

    const history = await historyFor(created.id);
    expect(history).toHaveLength(3);
    expect(history.map((h) => h.change_type).sort()).toEqual(['created', 'deleted', 'updated']);
    const priorOfUpdate = history.find((h) => h.change_type === 'updated')?.previous_state as { value?: unknown };
    expect(priorOfUpdate?.value).toBe('web');

    const viaService = await as(() => complianceRuleService.findRuleHistory(created.id, ORG, { limit: 10, offset: 0 }));
    expect(viaService.total).toBe(3);
  });

  it('a rule change queues ONE coalesced rescan for the org/target', async () => {
    const a = await as(() => complianceRuleService.create(ruleInput() as never, USER));
    expect(await historyFor(a.id)).toHaveLength(1);
    await as(() => complianceRuleService.create(ruleInput({ name: 'second' }) as never, USER));
    await new Promise((r) => setTimeout(r, 100));
    const { rows } = await owner((q) => q.query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM compliance_scans WHERE org_id = $1 AND target = 'pipeline' AND status = 'pending'", [ORG],
    ));
    expect(rows[0]?.n).toBe(1);
  });

  it('each mutation\'s history row is committed by the time the call resolves', async () => {
    const created = await as(() => complianceRuleService.create(ruleInput() as never, USER));
    expect((await historyFor(created.id)).map((h) => h.change_type)).toEqual(['created']);
    await as(() => complianceRuleService.update(created.id, { value: 'api' }, ORG, USER));
    expect(await historyFor(created.id)).toHaveLength(2);
  });

  it('a history insert that fails rolls the mutation back with it (atomic)', async () => {
    const created = await as(() => complianceRuleService.create(ruleInput() as never, USER));
    // Make every further history insert fail inside the mutation's transaction.
    await owner((q) => q.exec(`
      CREATE OR REPLACE FUNCTION test_reject_history() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'history write refused'; END $$;
      CREATE TRIGGER test_reject_history BEFORE INSERT ON compliance_rule_history FOR EACH ROW EXECUTE FUNCTION test_reject_history();
    `));
    try {
      await expect(as(() => complianceRuleService.update(created.id, { value: 'api' }, ORG, USER))).rejects.toThrow(/compliance_rule_history/);
      await expect(as(() => complianceRuleService.delete(created.id, ORG, USER))).rejects.toThrow(/compliance_rule_history/);
    } finally {
      await owner((q) => q.exec('DROP TRIGGER test_reject_history ON compliance_rule_history; DROP FUNCTION test_reject_history();'));
    }
    const { rows } = await owner((q) => q.query<{ value: unknown; is_active: boolean }>('SELECT value, is_active FROM compliance_rules WHERE id = $1', [created.id]));
    expect(rows[0]).toEqual({ value: 'web', is_active: true });
    expect((await historyFor(created.id)).map((h) => h.change_type)).toEqual(['created']);
  });

  it('a stale expectedUpdatedAt is a 412 that changes nothing and records no history', async () => {
    const created = await as(() => complianceRuleService.create(ruleInput() as never, USER));
    const loaded = new Date(created.updatedAt).toISOString();
    // Someone else edits first.
    await as(() => complianceRuleService.update(created.id, { value: 'api' }, ORG, USER, { expectedUpdatedAt: loaded }));
    await expect(as(() => complianceRuleService.update(created.id, { value: 'other' }, ORG, USER, { expectedUpdatedAt: loaded })))
      .rejects.toBeInstanceOf(ConcurrencyConflictError);
    const { rows } = await owner((q) => q.query<{ value: unknown }>('SELECT value FROM compliance_rules WHERE id = $1', [created.id]));
    expect(rows[0]?.value).toBe('api');
    expect((await historyFor(created.id)).map((h) => h.change_type).sort()).toEqual(['created', 'updated']);
  });

  it('a same-name rule in the same org is a 409 (the real unique index)', async () => {
    await as(() => complianceRuleService.create(ruleInput() as never, USER));
    await expect(as(() => complianceRuleService.create(ruleInput() as never, USER))).rejects.toBeInstanceOf(ConflictError);
  });

  it('the same name in ANOTHER org is fine', async () => {
    await as(() => complianceRuleService.create(ruleInput() as never, USER));
    await expect(as(() => complianceRuleService.create(ruleInput({ orgId: OTHER }) as never, USER), OTHER)).resolves.toMatchObject({ orgId: OTHER });
  });

  it('rejects an unsafe regex before touching the database', async () => {
    await expect(as(() => complianceRuleService.create(ruleInput({ operator: 'regex', value: '(a+)+$' }) as never, USER)))
      .rejects.toBeInstanceOf(InvalidRuleRegexError);
    const { rows } = await owner((q) => q.query('SELECT 1 FROM compliance_rules'));
    expect(rows).toEqual([]);
  });

  it('another org cannot update or delete the rule (RLS + org scope)', async () => {
    const created = await as(() => complianceRuleService.create(ruleInput() as never, USER));
    expect(await as(() => complianceRuleService.update(created.id, { value: 'x' }, OTHER, USER), OTHER)).toBeNull();
    expect(await as(() => complianceRuleService.delete(created.id, OTHER, USER), OTHER)).toBeNull();
    const { rows } = await owner((q) => q.query<{ value: unknown; is_active: boolean }>('SELECT value, is_active FROM compliance_rules WHERE id = $1', [created.id]));
    expect(rows[0]).toEqual({ value: 'web', is_active: true });
  });
});

describe('validate — the active-rule read feeding the engine (real Postgres, RLS)', () => {
  const validate = async (attributes: Record<string, unknown>, orgId = ORG) => as(async () => {
    const rules = await complianceRuleService.findActiveByOrgAndTarget(orgId, 'pipeline');
    return (await evaluateEntity({ target: 'pipeline', rules, attributes, orgId })).result;
  }, orgId);

  it('blocks on an active error rule and passes a compliant entity', async () => {
    await as(() => complianceRuleService.create(ruleInput() as never, USER));
    const bad = await validate({ project: 'api' });
    expect(bad.blocked).toBe(true);
    expect(bad.violations.map((v) => v.ruleName)).toEqual(['project-must-be-web']);
    expect((await validate({ project: 'web' })).blocked).toBe(false);
  });

  it('a warning rule warns, it does not block', async () => {
    await as(() => complianceRuleService.create(ruleInput({ severity: 'warning' }) as never, USER));
    const r = await validate({ project: 'api' });
    expect(r.blocked).toBe(false);
    expect(r.warnings).toHaveLength(1);
  });

  it('a deleted rule stops enforcing (the rules cache is invalidated)', async () => {
    const created = await as(() => complianceRuleService.create(ruleInput() as never, USER));
    expect((await validate({ project: 'api' })).blocked).toBe(true);
    await as(() => complianceRuleService.delete(created.id, ORG, USER));
    await new Promise((r) => setTimeout(r, 50));
    expect((await validate({ project: 'api' })).blocked).toBe(false);
  });

  it('another org\'s rules do not apply', async () => {
    await as(() => complianceRuleService.create(ruleInput() as never, USER));
    expect((await validate({ project: 'api' }, OTHER)).blocked).toBe(false);
  });
});
