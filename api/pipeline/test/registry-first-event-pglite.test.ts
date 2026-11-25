// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * First-event self-registration (reporting → pipeline), over a REAL Postgres
 * (PGlite + the shipped init script, as the app role under RLS), through the
 * real route handler.
 *
 * A pipeline created in the dashboard and deployed by anything but
 * `pipeline-manager pipeline deploy` never had a registry row, so every event
 * it sent was skipped. This route is what reporting's ingest calls on the first
 * such event. It pins: a live pipeline of an allowed org registers with the
 * names a CLI deploy records and the event's region, audited once as
 * `source: 'first-event'` by the system actor; another org's, a deleted or an
 * unknown pipeline never registers; an existing row is never overwritten; a
 * repeat (or concurrent) call inserts and audits once.
 */

import { randomUUID } from 'node:crypto';
import { jest, describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { defaultPipelineName, pipelineStackName } from '@pipeline-builder/api-core';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { routeHandler } from '@pipeline-builder/api-core/testing';
import { bootTenantDb, type TenantTestDb } from '@pipeline-builder/pipeline-data/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockAudit = jest.fn<AnyFn>();
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({ recordAudit: (...a: unknown[]) => mockAudit(...a) }));
const mockLink = jest.fn<AnyFn>(async () => undefined);
jest.unstable_mockModule('../src/runners/routing.js', () => ({ linkInBackground: (...a: unknown[]) => mockLink(...a) }));

process.env.JWT_SECRET ||= 'registry-first-event-test-secret';

const { createInternalRegistryRoutes } = await import('../src/routes/internal-registry-routes.js');
const { setRunnerDepsForTesting } = await import('../src/runners/deps.js');
setRunnerDepsForTesting({} as never);

let tdb: TenantTestDb;
type PGlite = TenantTestDb['pglite'];
const owner = <T>(fn: (q: PGlite) => Promise<T>) => tdb.asOwner(fn);

const ORG = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const TEAM = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const OTHER = 'cccccccccccccccccccccccc';

function makeRes() {
  const res: { statusCode?: number; body?: { data?: { registered?: string[] }; message?: string }; status: (n: number) => unknown; json: (b: unknown) => unknown; setHeader: () => void } = {
    status(n: number) { res.statusCode = n; return res; },
    json(b: unknown) { res.body = b as never; return res; },
    setHeader() { /* envelope headers are irrelevant here */ },
  };
  return res;
}

const handler = routeHandler(createInternalRegistryRoutes(), 'post', '/registry/first-event');
const register = async (body: unknown) => {
  const res = makeRes();
  await handler({ params: {}, headers: {}, body }, res);
  return res;
};

async function pipeline(orgId: string, opts: { project?: string; organization?: string; deleted?: boolean; props?: Record<string, unknown>; name?: string } = {}): Promise<string> {
  const id = randomUUID();
  await owner((q) => q.query(
    `INSERT INTO pipelines (id, project, organization, org_id, pipeline_name, props, deleted_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
    [id, opts.project ?? `proj-${id.slice(0, 8)}`, opts.organization ?? 'acme', orgId, opts.name ?? null, JSON.stringify(opts.props ?? {}), opts.deleted ? new Date() : null],
  ));
  return id;
}

const registryRows = (pipelineId: string) => owner((q) => q.query<{ org_id: string; pipeline_name: string; stack_name: string; region: string | null; project: string; organization: string }>(
  'SELECT org_id, pipeline_name, stack_name, region, project, organization FROM pipeline_registry WHERE pipeline_id = $1', [pipelineId],
)).then((r) => r.rows);

beforeAll(async () => {
  tdb = await bootTenantDb();
}, 120_000);

afterAll(async () => {
  await tdb?.close();
});

beforeEach(() => {
  mockAudit.mockClear();
  mockLink.mockClear();
});

describe('POST /pipelines/internal/registry/first-event', () => {
  it('registers a live pipeline of an allowed org with the names a CLI deploy records and the event region', async () => {
    const id = await pipeline(ORG, { project: 'spring_boot', organization: 'acme', props: { project: 'Spring-Boot', organization: 'Acme' } });
    const res = await register({ allowedOrgIds: [ORG], pipelines: [{ pipelineId: id, region: 'eu-west-1' }] });

    expect(res.statusCode).toBe(200);
    expect(res.body?.data?.registered).toEqual([id]);
    expect(await registryRows(id)).toEqual([{
      org_id: ORG,
      pipeline_name: defaultPipelineName('Acme', 'Spring-Boot'),
      stack_name: pipelineStackName('Spring-Boot', 'Acme'),
      region: 'eu-west-1',
      project: 'spring_boot',
      organization: 'acme',
    }]);
    expect(mockAudit).toHaveBeenCalledTimes(1);
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'pipeline.registry.register',
      actorId: 'system',
      orgId: ORG,
      targetType: 'pipeline',
      targetId: id,
      details: expect.objectContaining({ source: 'first-event', pipelineName: defaultPipelineName('Acme', 'Spring-Boot'), region: 'eu-west-1' }),
    }));
    // Linked like any registration: the org's runners are probed in the background.
    expect(mockLink).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ pipelineId: id, orgId: ORG }));
  });

  it('registers a team pipeline when the caller\'s roll-up includes the team', async () => {
    const id = await pipeline(TEAM);
    const res = await register({ allowedOrgIds: [ORG, TEAM], pipelines: [{ pipelineId: id }] });
    expect(res.body?.data?.registered).toEqual([id]);
    expect((await registryRows(id))[0]).toMatchObject({ org_id: TEAM, region: null });
  });

  it('never registers another org\'s, a soft-deleted or an unknown pipeline', async () => {
    const foreign = await pipeline(OTHER);
    const deleted = await pipeline(ORG, { deleted: true });
    const unknown = randomUUID();
    const res = await register({ allowedOrgIds: [ORG], pipelines: [{ pipelineId: foreign }, { pipelineId: deleted }, { pipelineId: unknown }] });

    expect(res.statusCode).toBe(200);
    expect(res.body?.data?.registered).toEqual([]);
    expect(await registryRows(foreign)).toEqual([]);
    expect(await registryRows(deleted)).toEqual([]);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('is idempotent: a repeat inserts and audits nothing, and still answers the pipeline as registered', async () => {
    const id = await pipeline(ORG);
    await register({ allowedOrgIds: [ORG], pipelines: [{ pipelineId: id, region: 'us-east-1' }] });
    mockAudit.mockClear();

    const again = await register({ allowedOrgIds: [ORG], pipelines: [{ pipelineId: id, region: 'us-west-2' }] });
    expect(again.body?.data?.registered).toEqual([id]);
    expect(mockAudit).not.toHaveBeenCalled();
    expect(await registryRows(id)).toHaveLength(1);
    expect((await registryRows(id))[0]!.region).toBe('us-east-1');
  });

  it('concurrent calls for the same pipeline insert once and audit once', async () => {
    const id = await pipeline(ORG);
    const body = { allowedOrgIds: [ORG], pipelines: [{ pipelineId: id, region: 'us-east-1' }] };
    const [a, b] = await Promise.all([register(body), register(body)]);
    expect(a.body?.data?.registered).toEqual([id]);
    expect(b.body?.data?.registered).toEqual([id]);
    expect(await registryRows(id)).toHaveLength(1);
    expect(mockAudit).toHaveBeenCalledTimes(1);
  });

  it('never overwrites an existing registration (a CLI deploy keeps its names and region)', async () => {
    const id = await pipeline(ORG);
    await owner((q) => q.query(
      'INSERT INTO pipeline_registry (pipeline_id, org_id, pipeline_name, region, stack_name) VALUES ($1, $2, \'cli-name\', \'ap-south-1\', \'cli-stack\')',
      [id, ORG],
    ));
    const res = await register({ allowedOrgIds: [ORG], pipelines: [{ pipelineId: id, region: 'us-east-1' }] });
    expect(res.body?.data?.registered).toEqual([id]);
    expect(await registryRows(id)).toEqual([expect.objectContaining({ pipeline_name: 'cli-name', region: 'ap-south-1', stack_name: 'cli-stack' })]);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('400s a malformed body and registers nothing', async () => {
    const id = await pipeline(ORG);
    const res = await register({ allowedOrgIds: [], pipelines: [{ pipelineId: id }] });
    expect(res.statusCode).toBe(400);
    expect(await registryRows(id)).toEqual([]);
  });
});
