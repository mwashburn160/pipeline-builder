// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * `CrudService.setDefault` on a REAL Postgres (the shipped init script), over
 * the real `pipelines` table, with the pipeline slot `(project, organization)`
 * as the default scope.
 *
 * Pipeline create treats `(org, project, organization)` as the slot, while
 * promotion used to demote across `(org, project)` — so promoting one
 * organization's pipeline cleared every other organization's default in the
 * same project. What is pinned here is the SQL the fake-tx suite cannot see:
 * which rows the demotion actually touches.
 */

import type { PGlite } from '@electric-sql/pglite';
import { jest, describe, it, expect, beforeAll, beforeEach, afterAll } from '@jest/globals';
import type { SQL } from 'drizzle-orm';
import type { AnyColumn } from 'drizzle-orm/column';
import type { PgTable } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { apiCoreMock } from './helpers/mock-api-core.js';
import { bootInitDb } from '../src/testing/pglite-init.js';

let db: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let orm: any;

jest.unstable_mockModule('../src/database/postgres-connection.js', () => ({ db: {} }));
jest.unstable_mockModule('../src/database/tenancy.js', () => ({
  // The superuser connection: RLS is proven elsewhere; this suite is about the
  // demotion predicate.
  withTenantTx: (fn: (t: unknown) => unknown) => fn(orm),
  runWithTenantContext: <T>(_ctx: unknown, fn: () => T) => fn(),
  getTenantContext: () => undefined,
  tenantContext: { run: <T>(_ctx: unknown, fn: () => T) => fn(), getStore: () => undefined },
}));
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

const { CrudService } = await import('../src/api/crud-service.js');
const { schema } = await import('../src/database/drizzle-schema.js');

const ORG = '000000000000000000000a01';
const OTHER_ORG = '000000000000000000000b01';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
class SlotScopedService extends CrudService<any, any, any, any> {
  protected get schema(): PgTable { return schema.pipeline; }
  protected buildConditions(): SQL[] { return []; }
  protected getSortColumn(): AnyColumn | null { return null; }
  protected getProjectColumn(): AnyColumn { return schema.pipeline.project; }
  protected getDefaultScopeColumns(): AnyColumn[] { return [schema.pipeline.project, schema.pipeline.organization]; }
  protected getOrgColumn(): AnyColumn { return schema.pipeline.orgId; }
  protected get conflictTarget(): AnyColumn[] { return [schema.pipeline.project, schema.pipeline.organization, schema.pipeline.orgId]; }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
class ProjectScopedService extends CrudService<any, any, any, any> {
  protected get schema(): PgTable { return schema.pipeline; }
  protected buildConditions(): SQL[] { return []; }
  protected getSortColumn(): AnyColumn | null { return null; }
  protected getProjectColumn(): AnyColumn { return schema.pipeline.project; }
  protected getOrgColumn(): AnyColumn { return schema.pipeline.orgId; }
  protected get conflictTarget(): AnyColumn[] { return [schema.pipeline.project, schema.pipeline.organization, schema.pipeline.orgId]; }
}

async function insertPipeline(n: number, org: string, project: string, organization: string, isDefault: boolean): Promise<void> {
  await db.query(
    `INSERT INTO pipelines (id, org_id, project, organization, pipeline_name, is_default, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, 'u', 'u')`,
    [uuid(n), org, project, organization, `p${n}`, isDefault],
  );
}

async function defaults(): Promise<string[]> {
  const r = await db.query<{ id: string }>('SELECT id FROM pipelines WHERE is_default = true ORDER BY id');
  return r.rows.map((row) => row.id);
}

beforeAll(async () => {
  db = await bootInitDb();
  orm = drizzle(db, { schema });
}, 120_000);
afterAll(async () => { await db?.close(); });

beforeEach(async () => {
  await db.query('DELETE FROM pipelines');
  await insertPipeline(1, ORG, 'web', 'acme', false);
  await insertPipeline(2, ORG, 'web', 'globex', true); // same project, ANOTHER organization's slot
  await insertPipeline(3, ORG, 'api', 'acme', true); // another project
  await insertPipeline(4, OTHER_ORG, 'web', 'acme', true); // another tenant
});

describe('setDefault slot scope', () => {
  it('promoting one (project, organization) default leaves another organization\'s default alone', async () => {
    const promoted = await new SlotScopedService().setDefault(ORG, uuid(1), 'staff');
    expect(promoted.isDefault).toBe(true);
    expect(await defaults()).toEqual([uuid(1), uuid(2), uuid(3), uuid(4)]);
  });

  it('the base scope (project only) still demotes across the whole project within the org', async () => {
    await new ProjectScopedService().setDefault(ORG, uuid(1), 'staff');
    expect(await defaults()).toEqual([uuid(1), uuid(3), uuid(4)]);
  });

  it('an unknown id is NotFound and demotes nothing', async () => {
    await expect(new ProjectScopedService().setDefault(ORG, uuid(99), 'staff')).rejects.toThrow(/not found/);
    expect(await defaults()).toEqual([uuid(2), uuid(3), uuid(4)]);
  });

  it('a row in another org is NotFound — the org pin covers the target lookup', async () => {
    await expect(new ProjectScopedService().setDefault(ORG, uuid(4), 'staff')).rejects.toThrow(/not found/);
    expect(await defaults()).toEqual([uuid(2), uuid(3), uuid(4)]);
  });
});
