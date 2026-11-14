// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Table-driven: every filter field of the shared filter→SQL builders renders a
 * predicate on the RIGHT column with the RIGHT operator and value. A field that
 * silently renders nothing is a list filter that silently does nothing (the
 * `pipelineName` and `orgId` regressions in query-builders.test.ts), and one on
 * the wrong column filters the wrong rows. The fail-closed "no org ⇒ no rows"
 * branch is pinned for each tenant-scoped builder.
 */

import { jest, describe, it, expect } from '@jest/globals';
import { and, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

const qb = await import('../src/api/query-builders.js');
const { SYSTEM_ORG_ID } = await import('@pipeline-builder/api-core');

const dialect = new PgDialect();
const render = (conds: SQL[]) => dialect.sqlToQuery(and(...conds)!);

/** The predicate(s) a filter ADDS over the empty filter, rendered. */
function added(build: (f: Record<string, unknown>) => SQL[], filter: Record<string, unknown>): { sql: string; params: unknown[] } {
  const base = build({});
  const all = build(filter);
  expect(all.length).toBeGreaterThan(base.length);
  // Builders push in a fixed order after the common conditions, so the new
  // predicates are the ones not already present in the base rendering.
  const extra = all.filter((c) => !base.some((b) => dialect.sqlToQuery(b).sql === dialect.sqlToQuery(c).sql));
  return render(extra.length ? extra : all.slice(base.length));
}

// Every row has all four elements (`undefined` = no parameter to check): a
// shorter row makes `it.each` hand jest's `done` callback to the test instead.
type Case = [field: string, filter: Record<string, unknown>, sql: RegExp, param: unknown];

describe('buildPipelineTemplateConditions', () => {
  const build = (f: Record<string, unknown>) => qb.buildPipelineTemplateConditions(f, 'org-1');
  it.each<Case>([
    ['orgId', { orgId: 'ORG-2' }, /"pipeline_templates"\."org_id" = \$/, 'org-2'],
    ['name (contains, wildcards escaped)', { name: '50%_off' }, /"name" ilike \$/, '%50\\%\\_off%'],
    ['category (verbatim)', { category: 'Build' }, /"category" = \$/, 'Build'],
    ['keyword', { keyword: 'react' }, /"keywords"/, undefined],
    ['ownerId', { ownerId: 'team-a' }, /"owner_id" = \$/, 'team-a'],
    ['lifecycle', { lifecycle: 'deprecated' }, /"lifecycle" = \$/, 'deprecated'],
  ])('%s', (_field, filter, sqlRe, param) => {
    const out = added(build, filter);
    expect(out.sql).toMatch(sqlRe);
    if (param !== undefined) expect(out.params).toContain(param);
  });
});

describe('buildPluginConditions — the less-travelled filters', () => {
  const build = (f: Record<string, unknown>) => qb.buildPluginConditions(f, 'org-1');
  it.each<Case>([
    ['exact name', { name: 'Node', nameMatch: 'exact' }, /"plugins"\."name" = \$/, 'node'],
    ['excludeYanked', { excludeYanked: true }, /"yanked_at" is null and "plugins"\."lifecycle" <> 'yanked'/, undefined],
    ['excludeScanFlagged', { excludeScanFlagged: true }, /"scan_flagged_at" is null/, undefined],
    ['category', { category: 'security' }, /"category" = \$/, 'security'],
    ['ownerId', { ownerId: 'team-b' }, /"owner_id" = \$/, 'team-b'],
    ['lifecycle', { lifecycle: 'yanked' }, /"lifecycle" = \$/, 'yanked'],
  ])('%s', (_field, filter, sqlRe, param) => {
    const out = added(build, filter);
    expect(out.sql).toMatch(sqlRe);
    if (param !== undefined) expect(out.params).toContain(param);
  });

  it('a version RANGE also excludes yanked versions; an exact pin does not', () => {
    expect(render(build({ version: '^1.2.0' })).sql).toMatch(/yanked_at" is null/);
    expect(render(build({ version: '1.2.0' })).sql).not.toMatch(/yanked_at" is null/);
  });
});

describe('buildPipelineConditions — catalog filters', () => {
  const build = (f: Record<string, unknown>) => qb.buildPipelineConditions(f, 'org-1');
  it.each<Case>([
    ['keyword', { keyword: 'api' }, /"keywords"/, undefined],
    ['ownerId', { ownerId: 'team-c' }, /"owner_id" = \$/, 'team-c'],
    ['lifecycle', { lifecycle: 'production' }, /"lifecycle" = \$/, 'production'],
  ])('%s', (_field, filter, sqlRe, param) => {
    const out = added(build, filter);
    expect(out.sql).toMatch(sqlRe);
    if (param !== undefined) expect(out.params).toContain(param);
  });
});

describe('buildMessageConditions — explicit-null and value branches', () => {
  const build = (f: Record<string, unknown>) => qb.buildMessageConditions({ threadId: undefined, ...f }, 'org-1');
  it.each<Case>([
    ['threadId value', { threadId: '11111111-1111-4111-8111-111111111111' }, /"thread_id" = \$/, undefined],
    ['recipientUserId null = org-wide only', { recipientUserId: null }, /"recipient_user_id" is null/, undefined],
    ['recipientUserId value (case preserved)', { recipientUserId: 'User-A' }, /"recipient_user_id" = \$/, 'User-A'],
    ['channel null = org-to-org', { channel: null }, /"channel" is null/, undefined],
    ['channel value', { channel: 'Billing' }, /"channel" = \$/, 'billing'],
    ['messageType', { messageType: 'announcement' }, /"message_type" = \$/, 'announcement'],
    ['priority', { priority: 'high' }, /"priority" = \$/, 'high'],
    ['isRead true', { isRead: true }, /jsonb_exists\("messages"\."read_by", \$\d+\)/, undefined],
    ['isRead false', { isRead: false }, /not jsonb_exists/, undefined],
  ])('%s', (_field, filter, sqlRe, param) => {
    const out = render(build(filter));
    expect(out.sql).toMatch(sqlRe);
    if (param !== undefined) expect(out.params).toContain(param);
  });
});

describe('buildCompliancePolicyConditions', () => {
  it.each<Case>([
    ['id (single → default-active is skipped)', { id: '11111111-1111-4111-8111-111111111111' }, /"id" = \$/, undefined],
    ['name', { name: 'pci' }, /"name" ilike \$/, '%pci%'],
    ['isTemplate', { isTemplate: 'true' }, /"is_template" = \$/, true],
  ])('%s', (_field, filter, sqlRe, param) => {
    const out = render(qb.buildCompliancePolicyConditions(filter, 'org-1'));
    expect(out.sql).toMatch(sqlRe);
    if (param !== undefined) expect(out.params).toContain(param);
  });

  it('defaults to active-only for a list, but not for a lookup by id', () => {
    expect(render(qb.buildCompliancePolicyConditions({}, 'org-1')).sql).toMatch(/"is_active" = \$/);
    expect(render(qb.buildCompliancePolicyConditions({ id: '11111111-1111-4111-8111-111111111111' }, 'org-1')).sql).not.toMatch(/"is_active"/);
  });

  it('fails closed with no org', () => {
    expect(render(qb.buildCompliancePolicyConditions({}, undefined)).sql).toMatch(/false|1\s*=\s*0/i);
  });
});

describe('buildComplianceRuleConditions — filters', () => {
  it.each<Case>([
    ['policyId', { policyId: 'pol-1' }, /"policy_id" = \$/, 'pol-1'],
    ['target', { target: 'plugin' }, /"target" = \$/, 'plugin'],
    ['severity', { severity: 'critical' }, /"severity" = \$/, 'critical'],
    ['scope', { scope: 'org' }, /"scope" = \$/, 'org'],
    ['tag', { tag: 'pci' }, /"tags"/, undefined],
    ['name', { name: 'no-root' }, /"name" ilike \$/, '%no-root%'],
    ['isActive explicit false', { isActive: 'false' }, /"is_active" = \$/, false],
  ])('%s', (_field, filter, sqlRe, param) => {
    const out = render(qb.buildComplianceRuleConditions(filter, 'org-1'));
    expect(out.sql).toMatch(sqlRe);
    if (param !== undefined) expect(out.params).toContain(param);
  });

  it('the system org sees exactly its own rules (no published-catalog OR)', () => {
    const out = render(qb.buildComplianceRuleConditions({}, SYSTEM_ORG_ID as string));
    expect(out.sql).not.toMatch(/ or /i);
  });
});

describe('buildPublishedRuleCatalogConditions', () => {
  it('is always scope=published and active-only, and carries its filters', () => {
    const out = render(qb.buildPublishedRuleCatalogConditions({ name: 'x', target: 'pipeline', severity: 'warning', tag: 't' }));
    expect(out.params).toEqual(expect.arrayContaining(['published', '%x%', 'pipeline', 'warning', true]));
    expect(out.sql).toMatch(/"scope" = \$.*"name" ilike.*"target" = .*"severity" = .*"tags".*"is_active" = /);
  });

  it('honours an explicit isActive: false (still never keyed off id)', () => {
    expect(render(qb.buildPublishedRuleCatalogConditions({ isActive: false })).params).toContain(false);
  });
});

describe('the compliance list builders are org-scoped and fail closed', () => {
  const builders: Array<[string, (f: Record<string, unknown>, org?: string) => SQL[], Case[]]> = [
    ['exemptions', (f, o) => qb.buildComplianceExemptionConditions(f, o), [
      ['ruleId', { ruleId: 'r1' }, /"rule_id" = \$/, 'r1'],
      ['entityType', { entityType: 'plugin' }, /"entity_type" = \$/, 'plugin'],
      ['entityId', { entityId: 'e1' }, /"entity_id" = \$/, 'e1'],
      ['status', { status: 'approved' }, /"status" = \$/, 'approved'],
    ]],
    ['audit log', (f, o) => qb.buildComplianceAuditConditions(f, o), [
      ['target', { target: 'pipeline' }, /"target" = \$/, 'pipeline'],
      ['action', { action: 'block' }, /"action" = \$/, 'block'],
      ['result', { result: 'fail' }, /"result" = \$/, 'fail'],
      ['scanId', { scanId: 's1' }, /"scan_id" = \$/, 's1'],
      ['dateFrom', { dateFrom: '2026-01-01T00:00:00Z' }, /"created_at" >= \$/, undefined],
      ['dateTo', { dateTo: '2026-02-01T00:00:00Z' }, /"created_at" <= \$/, undefined],
    ]],
    ['scans', (f, o) => qb.buildComplianceScanConditions(f, o), [
      ['target', { target: 'plugin' }, /"target" = \$/, 'plugin'],
      ['status', { status: 'running' }, /"status" = \$/, 'running'],
      ['triggeredBy', { triggeredBy: 'manual' }, /"triggered_by" = \$/, 'manual'],
    ]],
  ];

  describe.each(builders)('%s', (_name, build, cases) => {
    it('scopes to the (lowercased) org', () => {
      const out = render(build({}, 'ORG-1'));
      expect(out.sql).toMatch(/"org_id" = \$/);
      expect(out.params).toContain('org-1');
    });

    it('with no org, matches nothing (never every tenant\'s rows)', () => {
      const out = render(build({}, undefined));
      expect(out.sql).not.toMatch(/"org_id"/);
      expect(out.sql).toMatch(/false|1\s*=\s*0/i);
    });

    it.each(cases)('%s', (_field, filter, sqlRe, param) => {
      const out = render(build(filter, 'org-1'));
      expect(out.sql).toMatch(sqlRe);
      if (param !== undefined) expect(out.params).toContain(param);
    });
  });
});
