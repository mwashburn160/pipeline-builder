// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * CrudService in-transaction hooks and optimistic concurrency on a REAL
 * Postgres (the shipped init script, PGlite), over the real `pipelines` table.
 *
 * Pinned here, and invisible to the fake-tx suite:
 *  - `onCreateInTx` / `onUpdateInTx` / `onDeleteInTx` run in the mutation's own
 *    transaction: their writes commit with it, and a throw rolls BOTH back;
 *  - `update(..., { expectedUpdatedAt })` writes only while `updated_at` still
 *    matches (at millisecond precision, though Postgres stores microseconds),
 *    and throws ConcurrencyConflictError (412) only when the row EXISTS but has
 *    moved on — a missing / foreign row is still `null`.
 */

import type { PGlite } from '@electric-sql/pglite';
import { jest, describe, it, expect, beforeAll, beforeEach, afterAll } from '@jest/globals';
import { sql, type SQL } from 'drizzle-orm';
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
  // A REAL transaction on the superuser connection: RLS is proven elsewhere;
  // this suite is about atomicity and the concurrency predicate.
  withTenantTx: (fn: (t: unknown) => unknown) => orm.transaction(fn),
  runWithTenantContext: <T>(_ctx: unknown, fn: () => T) => fn(),
  getTenantContext: () => undefined,
  tenantContext: { run: <T>(_ctx: unknown, fn: () => T) => fn(), getStore: () => undefined },
}));
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

const { CrudService } = await import('../src/api/crud-service.js');
const { schema } = await import('../src/database/drizzle-schema.js');
const { ConcurrencyConflictError, ValidationError } = await import('@pipeline-builder/api-core');

const ORG = '000000000000000000000a01';
const OTHER_ORG = '000000000000000000000b01';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** Which in-tx hook should throw (after writing its audit row), to prove rollback. */
let failIn: 'create' | 'update' | 'delete' | null = null;

/* eslint-disable @typescript-eslint/no-explicit-any */
class AuditedPipelineService extends CrudService<any, any, any, any> {
  protected get schema(): PgTable { return schema.pipeline; }
  protected buildConditions(): SQL[] { return []; }
  protected getSortColumn(): AnyColumn | null { return null; }
  protected getProjectColumn(): AnyColumn { return schema.pipeline.project; }
  protected getOrgColumn(): AnyColumn { return schema.pipeline.orgId; }
  protected get conflictTarget(): AnyColumn[] { return [schema.pipeline.project, schema.pipeline.organization, schema.pipeline.orgId]; }

  private async audit(op: string, entity: any, tx: any, ctx: { userId: string; operation: string }): Promise<void> {
    await tx.execute(sql`INSERT INTO crud_hook_audit (entity_id, op, operation, user_id) VALUES (${entity.id}, ${op}, ${ctx.operation}, ${ctx.userId})`);
    if (failIn === op) throw new Error(`${op} audit failed`);
  }
  protected async onCreateInTx(entity: any, tx: any, ctx: any): Promise<void> { await this.audit('create', entity, tx, ctx); }
  protected async onUpdateInTx(entity: any, tx: any, ctx: any): Promise<void> { await this.audit('update', entity, tx, ctx); }
  protected async onDeleteInTx(entity: any, tx: any, ctx: any): Promise<void> { await this.audit('delete', entity, tx, ctx); }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const svc = new AuditedPipelineService();

async function insertPipeline(n: number, org = ORG): Promise<void> {
  // `updated_at` from now(): MICROSECOND precision, as every real row has.
  await db.query(
    `INSERT INTO pipelines (id, org_id, project, organization, pipeline_name, created_by, updated_by)
     VALUES ($1, $2, $3, 'acme', $4, 'u', 'u')`,
    [uuid(n), org, `proj-${n}`, `p${n}`],
  );
}

async function auditRows(): Promise<string[]> {
  const r = await db.query<{ entity_id: string; op: string; operation: string; user_id: string }>(
    'SELECT entity_id, op, operation, user_id FROM crud_hook_audit ORDER BY seq');
  return r.rows.map((x) => `${x.op}/${x.operation}:${x.entity_id}:${x.user_id}`);
}

async function row(n: number): Promise<{ description: string | null; is_active: boolean; updated_at: Date } | undefined> {
  const r = await db.query<{ description: string | null; is_active: boolean; updated_at: Date }>(
    'SELECT description, is_active, updated_at FROM pipelines WHERE id = $1', [uuid(n)]);
  return r.rows[0];
}

beforeAll(async () => {
  db = await bootInitDb();
  orm = drizzle(db, { schema });
  await db.query('CREATE TABLE crud_hook_audit (seq serial PRIMARY KEY, entity_id uuid NOT NULL, op text NOT NULL, operation text NOT NULL, user_id text NOT NULL)');
}, 120_000);
afterAll(async () => { await db?.close(); });

beforeEach(async () => {
  failIn = null;
  await db.query('DELETE FROM crud_hook_audit');
  await db.query('DELETE FROM pipelines');
  await insertPipeline(1);
  await insertPipeline(2);
  await insertPipeline(3, OTHER_ORG);
});

describe('in-transaction hooks', () => {
  it('create / update / delete each write their audit row in the same transaction', async () => {
    const created = await svc.create({ orgId: ORG, project: 'new', organization: 'acme', pipelineName: 'n' }, 'alice');
    await svc.update(uuid(1), { description: 'edited' }, ORG, 'bob');
    await svc.delete(uuid(2), ORG, 'carol');
    expect(await auditRows()).toEqual([
      `create/create:${created.id}:alice`,
      `update/update:${uuid(1)}:bob`,
      `delete/delete:${uuid(2)}:carol`,
    ]);
  });

  it('a throwing onCreateInTx rolls the INSERT back too', async () => {
    failIn = 'create';
    await expect(svc.create({ orgId: ORG, project: 'new', organization: 'acme', pipelineName: 'n' }, 'alice')).rejects.toThrow('create audit failed');
    const r = await db.query("SELECT 1 FROM pipelines WHERE project = 'new'");
    expect(r.rows).toHaveLength(0);
    expect(await auditRows()).toEqual([]);
  });

  it('a throwing onUpdateInTx rolls the UPDATE back too', async () => {
    failIn = 'update';
    await expect(svc.update(uuid(1), { description: 'edited' }, ORG, 'bob')).rejects.toThrow('update audit failed');
    expect((await row(1))?.description).toBeNull();
    expect(await auditRows()).toEqual([]);
  });

  it('a throwing onDeleteInTx rolls the soft-delete back too', async () => {
    failIn = 'delete';
    await expect(svc.delete(uuid(1), ORG, 'carol')).rejects.toThrow('delete audit failed');
    expect((await row(1))?.is_active).toBe(true);
    expect(await auditRows()).toEqual([]);
  });

  it('updateMany and bulkDelete fire the hook once per affected row', async () => {
    await svc.updateMany({}, { description: 'bulk' }, ORG, 'dave');
    await svc.bulkDelete([uuid(1), uuid(2)], ORG, 'erin');
    const rows = await auditRows();
    expect(rows.filter((r) => r.startsWith('update/updateMany:')).sort()).toEqual([`update/updateMany:${uuid(1)}:dave`, `update/updateMany:${uuid(2)}:dave`]);
    expect(rows.filter((r) => r.startsWith('delete/bulkDelete:')).sort()).toEqual([`delete/bulkDelete:${uuid(1)}:erin`, `delete/bulkDelete:${uuid(2)}:erin`]);
  });

  it('a no-op mutation (no row matched) fires no hook', async () => {
    expect(await svc.update(uuid(3), { description: 'x' }, ORG, 'bob')).toBeNull(); // another org's row
    expect(await svc.delete(uuid(99), ORG, 'bob')).toBeNull();
    expect(await auditRows()).toEqual([]);
  });
});

describe('optimistic concurrency (expectedUpdatedAt)', () => {
  it('writes when updated_at still matches — at ms precision, as a Date or an ISO string', async () => {
    const before = (await row(1))!.updated_at; // pg returns a ms-precision Date of a µs value
    const updated = await svc.update(uuid(1), { description: 'v2' }, ORG, 'bob', { expectedUpdatedAt: before });
    expect(updated?.description).toBe('v2');
    // The returned row is the next precondition (the client's round-trip).
    const again = await svc.update(uuid(1), { description: 'v3' }, ORG, 'bob', { expectedUpdatedAt: new Date(updated!.updatedAt).toISOString() });
    expect(again?.description).toBe('v3');
  });

  it('throws ConcurrencyConflictError (412) when the row moved on, and writes nothing', async () => {
    const stale = (await row(1))!.updated_at;
    // The version token is a ms timestamp: two writes in the same millisecond are
    // indistinguishable (documented on UpdateOptions), so let the clock move.
    await new Promise((r) => setTimeout(r, 5));
    await svc.update(uuid(1), { description: 'someone else' }, ORG, 'mallory');
    const err = await svc.update(uuid(1), { description: 'mine' }, ORG, 'bob', { expectedUpdatedAt: stale }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConcurrencyConflictError);
    expect(err).toMatchObject({ statusCode: 412, code: 'PRECONDITION_FAILED' });
    expect((err as InstanceType<typeof ConcurrencyConflictError>).details).toMatchObject({ expectedUpdatedAt: stale.toISOString() });
    expect((await row(1))?.description).toBe('someone else');
    // The losing write fired no hook.
    expect((await auditRows()).filter((r) => r.includes(':bob'))).toEqual([]);
  });

  it('a missing or foreign row is still null (404), not a conflict', async () => {
    const ts = new Date();
    await expect(svc.update(uuid(99), { description: 'x' }, ORG, 'bob', { expectedUpdatedAt: ts })).resolves.toBeNull();
    await expect(svc.update(uuid(3), { description: 'x' }, ORG, 'bob', { expectedUpdatedAt: ts })).resolves.toBeNull();
  });

  it('an unparseable expectedUpdatedAt is a ValidationError, before any write', async () => {
    await expect(svc.update(uuid(1), { description: 'x' }, ORG, 'bob', { expectedUpdatedAt: 'yesterday-ish' })).rejects.toBeInstanceOf(ValidationError);
    expect((await row(1))?.description).toBeNull();
  });

  it('without the option, update is last-write-wins as before', async () => {
    await svc.update(uuid(1), { description: 'a' }, ORG, 'bob');
    await expect(svc.update(uuid(1), { description: 'b' }, ORG, 'bob')).resolves.toMatchObject({ description: 'b' });
  });
});
