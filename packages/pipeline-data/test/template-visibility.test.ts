// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect } from '@jest/globals';
import { and } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

const { buildPipelineTemplateConditions } = await import('../src/api/query-builders.js');

const SYSTEM_ORG = '000000000000000000000001';
const dialect = new PgDialect();

/** Render the built conditions to `{ sql, params }` so the tests assert on the
 *  actual predicate rather than on how many SQL fragments it happens to be. */
function render(filter: Record<string, unknown>, orgId?: string, parentOrgId?: string) {
  return dialect.sqlToQuery(and(...buildPipelineTemplateConditions(filter, orgId, parentOrgId))!);
}

describe('pipeline-template visibility ladder', () => {
  describe('read predicate', () => {
    it('shows own-org rows plus the system org public catalog', () => {
      const { sql, params } = render({}, 'org-1');
      expect(params).toContain('org-1');
      expect(params).toContain(SYSTEM_ORG);
      // The private rung is expressed as "not private OR mine".
      expect(params).toContain('private');
      expect(sql).toContain('<>');
    });

    it('binds the viewer so own private drafts stay visible', () => {
      const { params } = render({ viewerUserId: 'user-1' }, 'org-1');
      expect(params).toContain('user-1');
    });

    it('fails closed on the private rung when no viewer is supplied', () => {
      // Without a viewer the "mine" leg must collapse to an impossible predicate
      // rather than matching every row — a missing viewer is never a wildcard.
      const { sql, params } = render({}, 'org-1');
      expect(sql).toContain('false');
      expect(params).not.toContain('user-1');
    });

    it('lifts the private rung for a superadmin', () => {
      // A superadmin administers the whole catalog, so the own-org leg is a bare
      // org match with no visibility narrowing (and no `false` fallback).
      const { sql } = render({ viewerIsSuperAdmin: true }, 'org-1');
      expect(sql).not.toContain('false');
    });

    it('widens to the parent org public rows for a team', () => {
      expect(render({}, 'team-1', 'parent-1').params).toContain('parent-1');
      expect(render({}, 'team-1').params).not.toContain('parent-1');
    });

    it('restricts an anonymous caller to the system org public catalog', () => {
      const { params } = render({});
      expect(params).toContain(SYSTEM_ORG);
      expect(params).toContain('public');
      expect(params).not.toContain('org-1');
    });

    it('matches nothing when an anonymous caller asks for a non-public rung', () => {
      expect(render({ visibility: 'private' }).sql).toContain('false');
    });
  });

  describe('visibility filter', () => {
    it('narrows within the visible set rather than widening it', () => {
      const { sql, params } = render({ visibility: 'org', viewerUserId: 'user-1' }, 'org-1');
      // Still carries the full access clause (own org + system public)...
      expect(params).toContain(SYSTEM_ORG);
      // ...AND the extra rung equality on top.
      expect(params.filter((p) => p === 'org')).toHaveLength(1);
      expect(sql).toContain('and');
    });

    it('keeps the system-org catalog reachable under an explicit public filter', () => {
      // Standing rule: orgId='system' content stays visible from any org, so a
      // `?visibility=public` narrowing must NOT collapse to own-org rows only.
      expect(render({ visibility: 'public' }, 'org-1').params).toContain(SYSTEM_ORG);
    });
  });

  describe('other filters', () => {
    it('defaults to active rows only', () => {
      expect(render({}, 'org-1').params).toContain(true);
    });

    it('adds a predicate per supplied filter', () => {
      const base = buildPipelineTemplateConditions({}, 'org-1').length;
      expect(buildPipelineTemplateConditions({ name: 'node' }, 'org-1').length).toBeGreaterThan(base);
      expect(buildPipelineTemplateConditions({ category: 'backend' }, 'org-1').length).toBeGreaterThan(base);
      expect(buildPipelineTemplateConditions({ keyword: 'java' }, 'org-1').length).toBeGreaterThan(base);
      expect(buildPipelineTemplateConditions({ lifecycle: 'production' }, 'org-1').length).toBeGreaterThan(base);
    });
  });
});
