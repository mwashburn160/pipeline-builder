// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The record's name and the synth's agree. The synth names the stack and the
 * CodePipeline from the stored `props` (project, organization, pipelineName),
 * so a create body that names them differently must land in `props` too — else
 * the record names a pipeline that is never deployed. The same holds for an
 * update's `pipelineName`. Against a REAL Postgres (PGlite + the shipped init
 * script, as the app role under RLS); compliance and the resolution record are stubbed.
 */

import { jest, describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { bootTenantDb, type TenantTestDb } from '@pipeline-builder/pipeline-data/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({ recordAudit: () => {} }));
jest.unstable_mockModule('../src/helpers/plugin-contract-check.js', () => ({
  recordPipelineResolution: jest.fn(), resolveContractPlugin: jest.fn(), checkPluginContracts: jest.fn(), formatContractViolations: jest.fn(),
}));

const { createOnePipeline, preparePipelineCreate, alignPipelineUpdateIdentity } = await import('../src/helpers/pipeline-write.js');
const { runWithTenantContext } = await import('@pipeline-builder/pipeline-data');
const { defaultPipelineName } = await import('@pipeline-builder/api-core');

process.env.JWT_SECRET ||= 'pipeline-identity-test-secret';

let tdb: TenantTestDb;
const ROOT = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const USER = 'user-1';

const req = () => ({
  headers: {},
  query: {},
  user: { sub: USER, organizationId: ROOT, permissions: ['pipelines:write'], role: 'admin' },
  context: { identity: { orgId: ROOT, userId: USER } },
}) as never;

/** What the synth (pipeline-core PipelineConfiguration) names the CodePipeline from these props. */
const synthName = (p: Record<string, unknown>) => (p.pipelineName as string | undefined) ?? defaultPipelineName(p.organization as string, p.project as string);

async function create(body: Record<string, unknown>) {
  return runWithTenantContext({ orgId: ROOT, isSuperAdmin: false }, async () => {
    const prepared = preparePipelineCreate(req(), body as never);
    if ('error' in prepared) throw new Error(prepared.error);
    const outcome = await createOnePipeline(req(), body as never, prepared, { orgId: ROOT, userId: USER, serviceAuth: 'Bearer s' });
    if (outcome.status !== 'saved') throw new Error(outcome.status);
    return outcome.pipeline;
  });
}

beforeAll(async () => { tdb = await bootTenantDb(); }, 120_000);
afterAll(async () => { await tdb?.close(); });
beforeEach(async () => { await tdb.asOwner((q) => q.exec('DELETE FROM pipelines;')); });

describe('create: body identity reaches props', () => {
  it('body project / organization / pipelineName differing from props are written into props; the record name is the synth\'s', async () => {
    const props = { project: 'old-proj', organization: 'old-org', pipelineName: 'old-name', synth: { plugin: { name: 'cdk-synth' } } };
    const p = await create({ project: 'Shop', organization: 'Acme', pipelineName: 'shop-main', props });
    const stored = p.props as unknown as Record<string, unknown>;
    expect(stored).toMatchObject({ project: 'Shop', organization: 'Acme', pipelineName: 'shop-main', synth: { plugin: { name: 'cdk-synth' } } });
    expect(p.pipelineName).toBe(synthName(stored));
    expect(props.pipelineName).toBe('old-name'); // the caller's object is not mutated
  });

  it('no body pipelineName: a props pipelineName is the record\'s name', async () => {
    const p = await create({ project: 'shop', organization: 'acme', props: { project: 'shop', organization: 'acme', pipelineName: 'from-props' } });
    expect(p.pipelineName).toBe('from-props');
    expect(p.pipelineName).toBe(synthName(p.props as never));
  });

  it('no body override: props untouched', async () => {
    const props = { project: 'shop', organization: 'acme', synth: { plugin: { name: 'cdk-synth' } } };
    const p = await create({ project: 'shop', organization: 'acme', props });
    expect(p.props).toEqual(props);
    expect(p.pipelineName).toBe(synthName(p.props as never));
  });
});

describe('update: alignPipelineUpdateIdentity', () => {
  const existing = { pipelineName: 'shop-main', props: { project: 'shop', organization: 'acme', pipelineName: 'shop-main', stages: [] } };

  it('a rename alone writes the new name into the stored props', () => {
    const { data, fromStored } = alignPipelineUpdateIdentity({ pipelineName: 'renamed' }, existing);
    expect(data).toEqual({ pipelineName: 'renamed', props: { ...existing.props, pipelineName: 'renamed' } });
    expect(fromStored).toBe(true);
  });

  it('new props with a different name and a body name: the body name wins in both', () => {
    const { data, fromStored } = alignPipelineUpdateIdentity({ pipelineName: 'renamed', props: { project: 'shop', organization: 'acme', pipelineName: 'other' } }, existing);
    expect(data).toMatchObject({ pipelineName: 'renamed', props: { pipelineName: 'renamed' } });
    expect(fromStored).toBe(false);
  });

  it('new props without a name keep the record\'s name (the deployed pipeline is not renamed)', () => {
    const { data } = alignPipelineUpdateIdentity({ props: { project: 'shop', organization: 'acme' } }, existing);
    expect(data).toEqual({ pipelineName: 'shop-main', props: { project: 'shop', organization: 'acme', pipelineName: 'shop-main' } });
    expect(synthName(data.props as never)).toBe(data.pipelineName);
  });

  it('new props naming the pipeline rename the record to match', () => {
    const { data } = alignPipelineUpdateIdentity({ props: { project: 'shop', organization: 'acme', pipelineName: 'next' } }, existing);
    expect(data.pipelineName).toBe('next');
  });

  it('an update touching neither is untouched', () => {
    const update = { description: 'x' };
    expect(alignPipelineUpdateIdentity(update, existing)).toEqual({ data: update, fromStored: false });
  });
});
