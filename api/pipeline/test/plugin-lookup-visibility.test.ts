// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The AI-generation plugin context (and the auto-create existence check) must
 * see what the CALLER can see on the visibility ladder — not just `public` rows.
 * Before the fix the predicate was hard-coded to `visibility = 'public'`, so an
 * org's own `org`-rung plugins (the default working state) and the caller's own
 * private drafts never reached the model, and the auto-create step re-created
 * placeholders for plugins that already existed in the org.
 *
 * No mocks: the REAL predicate (real pipeline-data query builder + tenant
 * context) is rendered to SQL by drizzle's Postgres dialect.
 */

import { describe, it, expect } from '@jest/globals';
import { runWithTenantContext } from '@pipeline-builder/pipeline-data';
import { and } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { availablePluginConditions } from '../src/services/plugin-lookup-service.js';

const SYSTEM_ORG_ID = '000000000000000000000001';
const dialect = new PgDialect();

function render(ctx: { orgId?: string; userId?: string; isSuperAdmin: boolean } | null, orgId: string) {
  const build = () => dialect.sqlToQuery(and(...availablePluginConditions(orgId))!);
  return ctx ? runWithTenantContext(ctx, build) : build();
}

describe('availablePluginConditions — visibility ladder', () => {
  it('includes own-org org/public rows and the viewer\'s own private drafts', () => {
    const { sql, params } = render({ orgId: 'org-a', userId: 'user-1', isSuperAdmin: false }, 'org-a');

    // Own org: everything except OTHER authors' private drafts.
    expect(sql).toContain('"plugins"."org_id" = $1 and ("plugins"."visibility" <> $2 or "plugins"."created_by" = $3)');
    expect(params.slice(0, 3)).toEqual(['org-a', 'private', 'user-1']);
    // Not restricted to public-only within the caller's own org.
    expect(sql).not.toMatch(/^\("plugins"\."visibility" = \$1/);
  });

  it('never includes system-org rows (Official plugins reach tenants as listings)', () => {
    // `public` on a system-org row does not reach other orgs; the Official
    // catalog resolves as installed listings.
    const { params } = render({ orgId: 'org-a', userId: 'user-1', isSuperAdmin: false }, 'org-a');
    expect(params).not.toContain(SYSTEM_ORG_ID);
    expect(params).toEqual(['org-a', 'private', 'user-1', true]);
  });

  it('keeps soft-deleted and inactive plugins out', () => {
    const { sql } = render({ orgId: 'org-a', userId: 'user-1', isSuperAdmin: false }, 'org-a');
    expect(sql).toContain('"plugins"."is_active" = ');
    expect(sql).toContain('"plugins"."deleted_at" is null');
  });

  it('fails closed on the private rung without a viewer (no tenant scope)', () => {
    const { sql } = render(null, 'org-a');
    // No viewer ⇒ the "own drafts" branch is `false`, never "every private row".
    expect(sql).toContain('("plugins"."visibility" <> $2 or false)');
  });
});
