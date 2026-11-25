// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * ONE idempotent registry upsert, over a REAL Postgres (PGlite + the shipped
 * init script, as the app role under RLS).
 *
 * A pipeline deployed through a runner can register three ways at once: the
 * deploy job's registry post, the platform's `deployed` fallback, and the
 * first-event self-registration of its first CodePipeline event. All three go
 * through `registerDeployment` keyed on the pipeline id: whatever the order,
 * exactly one row, the deploy path's runner link set, and no error surfaced.
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { defaultPipelineName, pipelineStackName } from '@pipeline-builder/api-core';
import { bootTenantDb, type TenantTestDb } from '@pipeline-builder/pipeline-data/testing';

process.env.JWT_SECRET ||= 'registry-deploy-race-test-secret';

const { pipelineRegistryService } = await import('../src/services/pipeline-registry-service.js');

let tdb: TenantTestDb;
type PGlite = TenantTestDb['pglite'];
const owner = <T>(fn: (q: PGlite) => Promise<T>) => tdb.asOwner(fn);

const ORG = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = 'cccccccccccccccccccccccc';
/** The names a CLI deploy (deployedPipelineNames) records for the pipeline created with project `p`. */
const namesOf = (p: string) => ({ pipelineName: defaultPipelineName('Acme', p), stackName: pipelineStackName(p, 'Acme') });
const projectOf = new Map<string, string>();

async function pipeline(orgId = ORG): Promise<string> {
  const id = randomUUID();
  const project = `Shop${id.slice(0, 8)}`;
  projectOf.set(id, project);
  await owner((q) => q.query(
    'INSERT INTO pipelines (id, project, organization, org_id, pipeline_name, props) VALUES ($1, $2, \'acme\', $3, NULL, $4::jsonb)',
    [id, project.toLowerCase(), orgId, JSON.stringify({ project, organization: 'Acme' })],
  ));
  return id;
}

async function runner(orgId = ORG): Promise<string> {
  const r = await owner((q) => q.query<{ id: string }>(
    "INSERT INTO pipeline_runners (org_id, label, function_url, status) VALUES ($1, 'acct', 'https://abc.lambda-url.us-east-1.on.aws/', 'active') RETURNING id", [orgId]));
  return r.rows[0]!.id;
}

const rows = (pipelineId: string) => owner((q) => q.query<{ org_id: string; pipeline_name: string; stack_name: string; region: string | null; runner_id: string | null; runner_link_status: string }>(
  'SELECT org_id, pipeline_name, stack_name, region, runner_id, runner_link_status FROM pipeline_registry WHERE pipeline_id = $1', [pipelineId],
)).then((r) => r.rows);

const deployRegistration = (pipelineId: string, runnerId: string) => pipelineRegistryService.registerDeployment({
  pipelineId, orgId: ORG, ...namesOf(projectOf.get(pipelineId)!), region: 'us-east-1', project: projectOf.get(pipelineId)!.toLowerCase(), organization: 'acme', runnerId,
});
const firstEvent = (pipelineId: string) => pipelineRegistryService.registerFromFirstEvent([{ pipelineId, region: 'us-east-1' }], [ORG]);

beforeAll(async () => { tdb = await bootTenantDb(); }, 120_000);
afterAll(async () => { await tdb?.close(); });

describe('registerDeployment — the one upsert the deploy path and first-event registration share', () => {
  it('inserts the row with the runner link when none exists, and is idempotent', async () => {
    const [id, r] = [await pipeline(), await runner()];
    await expect(deployRegistration(id, r)).resolves.toMatchObject({ inserted: true, linked: true });
    await expect(deployRegistration(id, r)).resolves.toMatchObject({ inserted: false, linked: true });
    const names = namesOf(projectOf.get(id)!);
    expect(await rows(id)).toEqual([{ org_id: ORG, pipeline_name: names.pipelineName, stack_name: names.stackName, region: 'us-east-1', runner_id: r, runner_link_status: 'linked' }]);
  });

  it('a first event AFTER the deploy registered leaves the row (and its link) exactly as it is', async () => {
    const [id, r] = [await pipeline(), await runner()];
    await deployRegistration(id, r);
    await expect(firstEvent(id)).resolves.toMatchObject({ registered: [id], inserted: [] });
    expect(await rows(id)).toEqual([expect.objectContaining({ runner_id: r, runner_link_status: 'linked' })]);
  });

  it('the deploy registration AFTER a first event links the row the event inserted', async () => {
    const [id, r] = [await pipeline(), await runner()];
    await expect(firstEvent(id)).resolves.toMatchObject({ registered: [id] });
    await expect(deployRegistration(id, r)).resolves.toMatchObject({ inserted: false, linked: true });
    expect(await rows(id)).toEqual([expect.objectContaining({ pipeline_name: namesOf(projectOf.get(id)!).pipelineName, runner_id: r, runner_link_status: 'linked' })]);
  });

  it('RACE: the deploy job, the deployed fallback and the first event at once — one row, link set, no error', async () => {
    for (let i = 0; i < 5; i++) {
      const [id, r] = [await pipeline(), await runner()];
      const results = await Promise.allSettled(i % 2 === 0
        ? [deployRegistration(id, r), firstEvent(id), deployRegistration(id, r)]
        : [firstEvent(id), deployRegistration(id, r), firstEvent(id)]);
      expect(results.filter((x) => x.status === 'rejected')).toEqual([]);
      const got = await rows(id);
      expect(got).toHaveLength(1);
      expect(got[0]).toMatchObject({ org_id: ORG, runner_id: r, runner_link_status: 'linked' });
    }
  });

  it('refuses a pipeline the org does not own, and a row registered to another org', async () => {
    const foreign = await pipeline(OTHER);
    await expect(pipelineRegistryService.registerDeployment({ pipelineId: foreign, orgId: ORG, ...namesOf('x'), region: 'us-east-1' }))
      .rejects.toThrow('PR_PIPELINE_NOT_OWNED');
    expect(await rows(foreign)).toEqual([]);
  });
});
