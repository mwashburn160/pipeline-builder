// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for routes/pipeline-template-routes — catalog reads, authoring (token
 * and declared-vars validation, name collisions, the visibility ladder),
 * instantiate (graded plugin warnings, never a refusal), delete / restore /
 * purge.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const svc = {
  findPaginated: jest.fn<AnyFn>(),
  findDeleted: jest.fn<AnyFn>(),
  findById: jest.fn<AnyFn>(),
  findByNameInOrg: jest.fn<AnyFn>(),
  create: jest.fn<AnyFn>(),
  update: jest.fn<AnyFn>(),
  delete: jest.fn<AnyFn>(),
};
const mockRecordAudit = jest.fn<AnyFn>();
const mockCheckPlugins = jest.fn<AnyFn>();
const mockInstantiate = jest.fn<AnyFn>();
const mockValidateTemplates = jest.fn<AnyFn>();
const mockVisibilityWrite = jest.fn<AnyFn>(() => true);
const mockLoadAndRestore = jest.fn<AnyFn>();
const mockLoadAndPurge = jest.fn<AnyFn>();

jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  withRoute: (handler: any) => async (req: any, res: any) => {
    const ctx = { log: jest.fn<AnyFn>(), identity: { orgId: 'acme' }, requestId: 'req-1' };
    await handler({ req, res, ctx, orgId: 'acme', userId: 'user-1' });
  },
  createAuthenticatedWithOrgRoute: () => [],
}));
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  recordAudit: (...a: unknown[]) => mockRecordAudit(...a),
  getParam: (params: Record<string, string>, key: string) => params[key],
  // The template Zod schemas are stubbed in the pipeline mock; the body is the value.
  validateBody: (req: any) => (req.body?.invalid ? { ok: false, error: 'bad body' } : { ok: true, value: req.body }),
  validateQuery: (req: any) => (req.query?.invalid ? { ok: false, error: 'bad query' } : { ok: true, value: req.query }),
  requireVisibilityWriteAccess: (req: unknown, res: any, ...rest: unknown[]) => {
    const ok = mockVisibilityWrite(req, res, ...rest);
    if (!ok) res.status(403).json({ success: false });
    return ok;
  },
  loadAndRestore: (...a: unknown[]) => mockLoadAndRestore(...a),
  loadAndPurge: (...a: unknown[]) => mockLoadAndPurge(...a),
}));
jest.unstable_mockModule('../src/services/pipeline-template-service.js', () => ({ pipelineTemplateService: svc }));
jest.unstable_mockModule('../src/helpers/plugin-save-check.js', () => ({ checkPipelinePlugins: (...a: unknown[]) => mockCheckPlugins(...a) }));
jest.unstable_mockModule('../src/helpers/instantiate-template.js', () => ({ instantiateTemplateProps: (...a: unknown[]) => mockInstantiate(...a) }));
jest.unstable_mockModule('../src/helpers/pipeline-template-validator.js', () => ({ validatePipelineTemplates: (...a: unknown[]) => mockValidateTemplates(...a) }));

const { createPipelineTemplateRoutes } = await import('../src/routes/pipeline-template-routes.js');

const router = createPipelineTemplateRoutes() as any;
const handler = (method: string, path: string) => {
  const stack = router.stack.find((l: any) => l.route?.path === path && l.route.methods[method]).route.stack;
  return stack[stack.length - 1].handle;
};
const res = () => {
  const r: any = { status: jest.fn<AnyFn>(), json: jest.fn<AnyFn>(), setHeader: jest.fn<AnyFn>() };
  r.status.mockReturnValue(r);
  r.json.mockReturnValue(r);
  return r;
};
const body = (r: any) => r.json.mock.calls[0][0];
const req = (over: Record<string, unknown> = {}): any => ({ params: { id: 't-1' }, query: {}, body: {}, headers: {}, user: {}, ...over });

const template = { id: 't-1', orgId: 'acme', name: 'node-service', description: 'd', keywords: ['node'], category: 'general', visibility: 'org', createdBy: 'user-1', inputs: [{ name: 'repo' }], props: {} };

beforeEach(() => {
  jest.clearAllMocks();
  mockVisibilityWrite.mockReturnValue(true);
  svc.findById.mockResolvedValue(template);
  svc.findByNameInOrg.mockResolvedValue(null);
  svc.create.mockImplementation(async (v: any) => ({ id: 't-new', ...v }));
  svc.update.mockImplementation(async (id: string, v: any) => ({ ...template, id, ...v }));
  svc.delete.mockResolvedValue(template);
  mockCheckPlugins.mockResolvedValue({ refusals: [], warnings: [] });
  mockInstantiate.mockReturnValue({ project: 'p', synth: { plugin: { name: 'cdk-synth' } } });
});

describe('reads', () => {
  it('lists the catalog paginated, passing the parent org', async () => {
    svc.findPaginated.mockResolvedValue({ data: [template], total: 1, limit: 10, offset: 0, hasMore: false });
    const r = res();
    await handler('get', '/')(req({ query: { includeTotal: 'true' }, user: { parentOrganizationId: 'root' } }), r);
    expect(r.status).toHaveBeenCalledWith(200);
    expect(svc.findPaginated).toHaveBeenCalledWith(expect.anything(), 'acme', expect.objectContaining({ includeTotal: true }), 'root');
    const bad = res();
    await handler('get', '/')(req({ query: { invalid: '1' } }), bad);
    expect(bad.status).toHaveBeenCalledWith(400);
  });

  it('lists the deleted templates the viewer may see (another member\'s private draft hidden)', async () => {
    svc.findDeleted.mockResolvedValue([template, { ...template, id: 't-2', visibility: 'private', createdBy: 'someone-else' }, { ...template, id: 't-3', visibility: 'private', createdBy: 'user-1' }]);
    const r = res();
    await handler('get', '/deleted')(req(), r);
    expect(body(r).data.templates.map((t: any) => t.id)).toEqual(['t-1', 't-3']);
    const admin = res();
    await handler('get', '/deleted')(req({ user: { isSuperAdmin: true } }), admin);
    expect(body(admin).data.templates).toHaveLength(3);
  });

  it('gets one template or 404s', async () => {
    const r = res();
    await handler('get', '/:id')(req(), r);
    expect(body(r).data.template.id).toBe('t-1');
    svc.findById.mockResolvedValueOnce(null);
    const missing = res();
    await handler('get', '/:id')(req(), missing);
    expect(missing.status).toHaveBeenCalledWith(404);
  });
});

describe('POST /:id/instantiate', () => {
  it('renders the props and carries refusals and vulnerability grades as warnings — never a refusal', async () => {
    mockCheckPlugins.mockResolvedValueOnce({
      refusals: [
        { step: 'Build/lint', plugin: 'acme/lint', refusal: { code: 'PLUGIN_NOT_INSTALLED', message: 'install acme/lint' } },
        { step: 'Build/x', plugin: 'x', message: 'contract only' },
      ],
      warnings: [{ stepKey: 'synth', plugin: 'cdk-synth', code: 'VULN_FLAGGED', severity: 'error', message: 'flagged' }],
    });
    const r = res();
    await handler('post', '/:id/instantiate')(req({ body: { inputs: { repo: 'r' } } }), r);
    expect(r.status).toHaveBeenCalledWith(200);
    expect(body(r).data).toEqual({
      props: { project: 'p', synth: { plugin: { name: 'cdk-synth' } } },
      description: 'd',
      keywords: ['node'],
      pluginWarnings: [
        { stepKey: 'Build/lint', plugin: 'acme/lint', code: 'PLUGIN_NOT_INSTALLED', severity: 'error', message: 'install acme/lint' },
        { stepKey: 'synth', plugin: 'cdk-synth', code: 'VULN_FLAGGED', severity: 'error', message: 'flagged' },
      ],
    });
  });

  it('omits pluginWarnings when clean; 400s a bad body or a render error; 404s an unknown template', async () => {
    const clean = res();
    await handler('post', '/:id/instantiate')(req({ body: {} }), clean);
    expect(body(clean).data).not.toHaveProperty('pluginWarnings');

    const bad = res();
    await handler('post', '/:id/instantiate')(req({ body: { invalid: true } }), bad);
    expect(bad.status).toHaveBeenCalledWith(400);

    mockInstantiate.mockImplementationOnce(() => { throw new Error('missing input repo'); });
    const render = res();
    await handler('post', '/:id/instantiate')(req({ body: {} }), render);
    expect(render.status).toHaveBeenCalledWith(400);

    svc.findById.mockResolvedValueOnce(null);
    const missing = res();
    await handler('post', '/:id/instantiate')(req({ body: {} }), missing);
    expect(missing.status).toHaveBeenCalledWith(404);
  });
});

describe('POST / (author)', () => {
  const create = handler('post', '/');
  const valid = { name: 'svc', props: { project: '{{ vars.repo }}', vars: {}, metadata: {} }, inputs: [{ name: 'repo' }] };

  it('creates a private-by-default template owned by the creator, audited', async () => {
    const r = res();
    await create(req({ body: valid }), r);
    expect(r.status).toHaveBeenCalledWith(201);
    expect(svc.create).toHaveBeenCalledWith(expect.objectContaining({ orgId: 'acme', name: 'svc', visibility: 'private', ownerId: 'user-1', ownerType: 'user', category: 'general' }), 'user-1');
    expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'pipeline_template.create', targetId: 't-new' }));
  });

  it('refuses undeclared vars (a default or a props.vars key counts as declared)', async () => {
    const r = res();
    await create(req({ body: { ...valid, props: { project: '{{ vars.nope }}', metadata: { a: '{{ vars.ok | default: "x" }}' }, vars: { k: '{{ vars.k }}' } } } }), r);
    expect(r.status).toHaveBeenCalledWith(400);
    expect(body(r).message).toMatch(/undeclared vars: nope/);
    expect(svc.create).not.toHaveBeenCalled();
  });

  it('refuses invalid tokens, a bad body and a same-org name collision', async () => {
    mockValidateTemplates.mockImplementationOnce(() => { throw new Error('bad token'); });
    const tokens = res();
    await create(req({ body: valid }), tokens);
    expect(tokens.status).toHaveBeenCalledWith(400);

    const bad = res();
    await create(req({ body: { invalid: true } }), bad);
    expect(bad.status).toHaveBeenCalledWith(400);

    svc.findByNameInOrg.mockResolvedValueOnce(template);
    const dup = res();
    await create(req({ body: valid }), dup);
    expect(dup.status).toHaveBeenCalledWith(409);
  });
});

describe('PUT /:id', () => {
  const update = handler('put', '/:id');

  it('updates, re-checking declared vars against the STORED inputs on a props-only edit; owner change is admin-only', async () => {
    const r = res();
    await update(req({ body: { props: { project: '{{ vars.repo }}' }, ownerId: 'u-9', description: 'new' } }), r);
    expect(r.status).toHaveBeenCalledWith(200);
    expect(svc.update).toHaveBeenCalledWith('t-1', expect.not.objectContaining({ ownerId: 'u-9' }), 'acme', 'user-1');
    expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'pipeline_template.update' }));

    const admin = res();
    await update(req({ body: { ownerId: 'u-9', ownerType: 'user' }, user: { isAdmin: true } }), admin);
    expect(svc.update).toHaveBeenLastCalledWith('t-1', expect.objectContaining({ ownerId: 'u-9' }), 'acme', 'user-1');
  });

  it('refuses undeclared vars, invalid tokens and a bad body; stops on the visibility ladder; 404s', async () => {
    const undeclared = res();
    await update(req({ body: { props: { project: '{{ vars.nope }}' } } }), undeclared);
    expect(undeclared.status).toHaveBeenCalledWith(400);

    mockValidateTemplates.mockImplementationOnce(() => { throw new Error('bad token'); });
    const tokens = res();
    await update(req({ body: { props: {} } }), tokens);
    expect(tokens.status).toHaveBeenCalledWith(400);

    const bad = res();
    await update(req({ body: { invalid: true } }), bad);
    expect(bad.status).toHaveBeenCalledWith(400);

    mockVisibilityWrite.mockReturnValueOnce(false);
    const forbidden = res();
    await update(req({ body: { description: 'x' } }), forbidden);
    expect(forbidden.status).toHaveBeenCalledWith(403);

    svc.findById.mockResolvedValueOnce(null);
    const missing = res();
    await update(req({ body: {} }), missing);
    expect(missing.status).toHaveBeenCalledWith(404);

    svc.update.mockResolvedValueOnce(null);
    const gone = res();
    await update(req({ body: { description: 'x' } }), gone);
    expect(gone.status).toHaveBeenCalledWith(404);
  });
});

describe('DELETE /:id, restore, purge', () => {
  it('deletes (audited), stopping on the ladder and 404ing a miss', async () => {
    const r = res();
    await handler('delete', '/:id')(req(), r);
    expect(r.status).toHaveBeenCalledWith(200);
    expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'pipeline_template.delete', details: { name: 'node-service' } }));

    mockVisibilityWrite.mockReturnValueOnce(false);
    const forbidden = res();
    await handler('delete', '/:id')(req(), forbidden);
    expect(svc.delete).toHaveBeenCalledTimes(1);

    svc.delete.mockResolvedValueOnce(null);
    const gone = res();
    await handler('delete', '/:id')(req(), gone);
    expect(gone.status).toHaveBeenCalledWith(404);

    svc.findById.mockResolvedValueOnce(null);
    const missing = res();
    await handler('delete', '/:id')(req(), missing);
    expect(missing.status).toHaveBeenCalledWith(404);
  });

  it('restores and purges through the shared tombstone helpers, audited; stops when they answered', async () => {
    mockLoadAndRestore.mockResolvedValueOnce({ existing: template, restored: template });
    const restored = res();
    await handler('post', '/:id/restore')(req(), restored);
    expect(restored.status).toHaveBeenCalledWith(200);
    expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'pipeline_template.restore', affectedOrgId: 'acme' }));

    mockLoadAndPurge.mockResolvedValueOnce({ existing: template, purgedId: 't-1' });
    const purged = res();
    await handler('post', '/:id/purge')(req(), purged);
    expect(purged.status).toHaveBeenCalledWith(200);
    expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'pipeline_template.purge', targetId: 't-1' }));

    mockRecordAudit.mockClear();
    mockLoadAndRestore.mockResolvedValueOnce(null);
    mockLoadAndPurge.mockResolvedValueOnce(null);
    await handler('post', '/:id/restore')(req(), res());
    await handler('post', '/:id/purge')(req(), res());
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });
});
