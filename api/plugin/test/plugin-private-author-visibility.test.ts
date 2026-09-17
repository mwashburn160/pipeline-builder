// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A private plugin must be visible to its author.
 *
 * The shared access-control builder matches the `private` rung only against the
 * viewer stamped from the tenant context. PluginService didn't stamp it, so the
 * private branch failed closed for everyone — authors couldn't read, update or
 * delete their own private plugins.
 *
 * No mocks: PluginService's real condition builder, rendered to SQL.
 */

import { describe, it, expect } from '@jest/globals';
import { runWithTenantContext } from '@pipeline-builder/pipeline-data';
import { and } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { PluginService } from '../src/services/plugin-service.js';

const dialect = new PgDialect();

class Probe extends PluginService {
  conditions(orgId: string) {
    return dialect.sqlToQuery(and(...this.buildConditions({}, orgId))!);
  }
}

describe('PluginService — private rung', () => {
  it("matches the author's own private rows", () => {
    const { sql, params } = runWithTenantContext(
      { orgId: 'org-a', userId: 'author-1', isSuperAdmin: false },
      () => new Probe().conditions('org-a'),
    );
    expect(sql).toContain('"plugins"."created_by" = ');
    expect(params).toContain('author-1');
  });

  it('fails closed without a viewer', () => {
    const { sql } = new Probe().conditions('org-a');
    expect(sql).not.toContain('"plugins"."created_by" = ');
  });
});
