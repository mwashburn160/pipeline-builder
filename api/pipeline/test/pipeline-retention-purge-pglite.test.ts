// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The retention sweep's pipeline purge, over a REAL Postgres (PGlite + the
 * shipped init script, as the app role under RLS).
 *
 * A manual purge of a pipeline with a registration is refused unless its stack
 * is removed through the linked runner (an undeploy) or the caller forces it,
 * and a purge during a deploy through a runner is refused outright. The sweep
 * has no person to make that call: it keeps such a tombstone (and retries it on
 * every tick) instead of silently orphaning the stack it deployed.
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { runWithTenantContext } from '@pipeline-builder/pipeline-data';
import { bootTenantDb, type TenantTestDb } from '@pipeline-builder/pipeline-data/testing';

process.env.JWT_SECRET ||= 'pipeline-retention-purge-test-secret';

const { pipelineService } = await import('../src/services/pipeline-service.js');

let tdb: TenantTestDb;
type PGlite = TenantTestDb['pglite'];
const owner = <T>(fn: (q: PGlite) => Promise<T>) => tdb.asOwner(fn);

const ORG = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const past = () => new Date(Date.now() - 60_000);

async function tombstone(): Promise<string> {
  const id = randomUUID();
  await owner((q) => q.query(
    `INSERT INTO pipelines (id, project, organization, org_id, pipeline_name, props, is_active, deleted_at, purge_after)
     VALUES ($1, $2, 'acme', $3, NULL, '{}'::jsonb, false, $4, $4)`,
    [id, `proj-${id.slice(0, 8)}`, ORG, past()],
  ));
  return id;
}

const exists = (id: string) => owner((q) => q.query('SELECT 1 FROM pipelines WHERE id = $1', [id])).then((r) => r.rows.length > 0);
const sweep = () => runWithTenantContext({ isSuperAdmin: true }, () => pipelineService.purgeExpired(new Date(), 500));

beforeAll(async () => { tdb = await bootTenantDb(); }, 120_000);
afterAll(async () => { await tdb?.close(); });

describe('pipelineService.purgeExpired (the retention sweep)', () => {
  it('purges a plain tombstone, but keeps one still registered as deployed or with a deploy through a runner in flight', async () => {
    const plain = await tombstone();
    const registered = await tombstone();
    await owner((q) => q.query(
      "INSERT INTO pipeline_registry (pipeline_id, org_id, pipeline_name, stack_name, region) VALUES ($1, $2, 'p', 'shop-acme', 'us-east-1')",
      [registered, ORG],
    ));
    const deploying = await tombstone();
    await owner((q) => q.query(
      "INSERT INTO pipeline_run_requests (org_id, pipeline_id, action, requested_by, expires_at, status) VALUES ($1, $2, 'deploy', 'u', now() + interval '1 hour', 'deploying')",
      [ORG, deploying],
    ));
    const deployedBefore = await tombstone();
    await owner((q) => q.query(
      "INSERT INTO pipeline_run_requests (org_id, pipeline_id, action, requested_by, expires_at, status) VALUES ($1, $2, 'deploy', 'u', now() + interval '1 hour', 'failed')",
      [ORG, deployedBefore],
    ));

    await sweep();

    expect(await exists(plain)).toBe(false);
    expect(await exists(registered)).toBe(true);
    expect(await exists(deploying)).toBe(true);
    // A finished (here failed) deploy holds nothing back.
    expect(await exists(deployedBefore)).toBe(false);
    // The registration it kept is intact (the stack's events still attribute).
    expect((await owner((q) => q.query('SELECT 1 FROM pipeline_registry WHERE pipeline_id = $1', [registered]))).rows).toHaveLength(1);
  });

  it('a manual purge by id is not held back by the registration (the route decides undeploy / force)', async () => {
    const registered = await tombstone();
    await owner((q) => q.query(
      "INSERT INTO pipeline_registry (pipeline_id, org_id, pipeline_name, stack_name, region) VALUES ($1, $2, 'p', 'shop-acme', 'us-east-1')",
      [registered, ORG],
    ));
    await expect(runWithTenantContext({ isSuperAdmin: true }, () => pipelineService.purgeById(registered))).resolves.toBe(registered);
    expect(await exists(registered)).toBe(false);
  });
});
