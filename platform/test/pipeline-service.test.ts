// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

jest.mock('../src/config', () => ({
  config: {
    services: {
      timeout: 5000,
      listPipelines: 'http://svc/list-pipelines',
      getPipeline: 'http://svc/get-pipeline',
      createPipeline: 'http://svc/create-pipeline',
    },
  },
}));

jest.mock('@pipeline-builder/api-core', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  })),
}));

import { pipelineService, PipelineServiceError } from '../src/services/pipeline-service';

describe('pipelineService', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('listPipelines', () => {
    it('should call list URL with query string', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ pipelines: [], pagination: { total: 0, offset: 0, limit: 20, hasMore: false } }),
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      await pipelineService.listPipelines(
        'org-1',
        { project: 'proj-a', isActive: true },
        { token: 'tok', userId: 'u1' },
      );

      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toContain('http://svc/list-pipelines?');
      expect(url).toContain('project=proj-a');
      expect(url).toContain('isActive=true');
    });

    it('should include auth headers', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ pipelines: [], pagination: { total: 0, offset: 0, limit: 20, hasMore: false } }),
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      await pipelineService.listPipelines('org-1', {}, { token: 'tok-xyz', userId: 'u1' });

      const opts = fetchMock.mock.calls[0][1] as RequestInit;
      const headers = opts.headers as Record<string, string>;
      expect(headers['x-org-id']).toBe('org-1');
      expect(headers['x-user-id']).toBe('u1');
      expect(headers['Authorization']).toBe('Bearer tok-xyz');
    });

    it('should throw PipelineServiceError on non-ok response', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ message: 'Not found', code: 'NOT_FOUND' }),
      }) as unknown as typeof fetch;

      await expect(
        pipelineService.listPipelines('org-1', {}, { token: 'tok' }),
      ).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
    });

    it('should reject when token is missing', async () => {
      await expect(
        pipelineService.listPipelines('org-1', {}, { token: '' }),
      ).rejects.toBeInstanceOf(PipelineServiceError);
    });
  });

  describe('getPipelineById', () => {
    it('should append id to URL', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id: 'p-1' }),
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      await pipelineService.getPipelineById('org-1', 'p-1', { token: 'tok' });

      expect(fetchMock.mock.calls[0][0]).toBe('http://svc/get-pipeline/p-1');
    });
  });

  describe('getPipeline', () => {
    it('should append filter as query string', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id: 'p-1' }),
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      await pipelineService.getPipeline(
        'org-1',
        { project: 'proj-a', organization: 'org-a' },
        { token: 'tok' },
      );

      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toContain('project=proj-a');
      expect(url).toContain('organization=org-a');
    });
  });

  describe('createPipeline', () => {
    it('should POST JSON payload', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id: 'p-new', message: 'created' }),
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      const data = {
        project: 'proj-a',
        organization: 'org-a',
        props: {
          project: 'proj-a',
          organization: 'org-a',
          synth: {},
        },
      };

      const result = await pipelineService.createPipeline('org-1', data, { token: 'tok' });

      const opts = fetchMock.mock.calls[0][1] as RequestInit;
      expect(opts.method).toBe('POST');
      expect(JSON.parse(opts.body as string)).toEqual(data);
      expect(result.id).toBe('p-new');
    });
  });

  describe('PipelineServiceError', () => {
    it('should be an instance of Error with metadata', () => {
      const err = new PipelineServiceError('boom', 502, 'UPSTREAM_ERR');
      expect(err).toBeInstanceOf(Error);
      expect(err.statusCode).toBe(502);
      expect(err.code).toBe('UPSTREAM_ERR');
      expect(err.name).toBe('PipelineServiceError');
    });
  });
});
