// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pins the visibility ladder at BOTH layers it is declared: the drizzle schema
 * (which the app's WHERE clauses read) and the shipped `postgres-init.sql`
 * (whose CHECK is the last line of defence against a typo'd rung). They must
 * agree — a schema that says three rungs against a DDL that still enforces two
 * would fail every `org` write at runtime.
 *
 * Templates are the sample entity here, but every catalog table now shares the
 * same ladder, so the cross-table check below guards the whole set.
 */

import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { message } from '../src/database/schema/message.js';
import { pipelineTemplate } from '../src/database/schema/pipeline-template.js';
import { pipeline } from '../src/database/schema/pipeline.js';
import { plugin } from '../src/database/schema/plugin.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const DDL = readFileSync(resolve(REPO_ROOT, 'deploy/shared/postgres-init.sql'), 'utf8');

/** The `CREATE TABLE pipeline_templates (...)` body, so assertions can't be
 *  satisfied by an unrelated table that happens to have a `visibility` column. */
const TABLE_DDL = DDL.slice(
  DDL.indexOf('CREATE TABLE IF NOT EXISTS pipeline_templates'),
).split(');')[0];

describe('pipeline_templates schema', () => {
  const { columns, indexes } = getTableConfig(pipelineTemplate);
  const column = (name: string) => columns.find((c) => c.name === name);

  it('carries a three-rung visibility column, not the retired two-value field', () => {
    const visibility = column('visibility');
    expect(visibility).toBeDefined();
    expect(visibility!.notNull).toBe(true);
    expect(visibility!.default).toBe('private');
    // The retired two-value field must be gone — leaving both would let a read
    // and a write disagree about which one is authoritative.
    expect(column('access_modifier')).toBeUndefined();
  });

  it('indexes the columns the visibility predicate filters on', () => {
    const names = indexes.map((i) => i.config.name);
    expect(names).toContain('pipeline_template_org_visibility_active_idx');
    // Drives the "my private drafts" leg (org_id + created_by).
    expect(names).toContain('pipeline_template_created_by_idx');
    expect(names).not.toContain('pipeline_template_org_access_active_idx');
  });

  it('matches the shipped DDL: a CHECK constraint over exactly the three rungs', () => {
    expect(TABLE_DDL).toContain("visibility VARCHAR(10) NOT NULL DEFAULT 'private'");
    expect(TABLE_DDL).toContain("CHECK (visibility IN ('private', 'org', 'public'))");
    // No `access_modifier` COLUMN (the explanatory comment above it may name the
    // field it replaced, so match the declaration, not any mention of the word).
    expect(TABLE_DDL).not.toMatch(/^\s*access_modifier\s+VARCHAR/m);
  });

  it('matches the shipped DDL: the visibility indexes exist there too', () => {
    expect(DDL).toContain('pipeline_template_org_visibility_active_idx ON pipeline_templates(org_id, visibility, is_active)');
    expect(DDL).toContain('pipeline_template_created_by_idx ON pipeline_templates(org_id, created_by)');
  });
});

describe('visibility ladder is uniform across the catalog', () => {
  it.each([
    ['pipelines', pipeline],
    ['plugins', plugin],
    ['pipeline_templates', pipelineTemplate],
  ])('%s carries the same three-rung visibility column', (_name, table) => {
    const { columns } = getTableConfig(table);
    const visibility = columns.find((c) => c.name === 'visibility');
    expect(visibility).toBeDefined();
    expect(visibility!.notNull).toBe(true);
    expect(visibility!.default).toBe('private');
    // One model only — the retired two-value field must not linger anywhere.
    expect(columns.find((c) => c.name === 'access_modifier')).toBeUndefined();
  });

  it('messages carry NO sharing rung (bespoke sender/recipient predicate)', () => {
    const names = getTableConfig(message).columns.map((c) => c.name);
    expect(names).not.toContain('visibility');
    expect(names).not.toContain('access_modifier');
  });

  it('the shipped DDL enforces the same CHECK on every catalog table', () => {
    // Three tables × the identical three-rung constraint. A table that drifts to
    // a two-value CHECK would reject every `org` write at runtime.
    const checks = DDL.match(/CHECK \(visibility IN \('private', 'org', 'public'\)\)/g) ?? [];
    expect(checks.length).toBeGreaterThanOrEqual(3);
    expect(DDL).not.toMatch(/CHECK \(access_modifier/);
  });
});
