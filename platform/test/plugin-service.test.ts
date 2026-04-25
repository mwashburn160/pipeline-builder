// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

jest.mock('../src/config', () => ({
  config: {
    services: {
      timeout: 5000,
      listPlugins: 'http://svc/list-plugins',
      getPlugin: 'http://svc/get-plugin',
      uploadPlugin: 'http://svc/upload-plugin',
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

import { pluginService, PluginServiceError } from '../src/services/plugin-service';

describe('pluginService', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('listPlugins', () => {
    it('should call list URL with query string', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ plugins: [], pagination: { total: 0, offset: 0, limit: 20, hasMore: false } }),
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      await pluginService.listPlugins(
        'org-1',
        { name: 'my-plugin', isDefault: true },
        { token: 'tok' },
      );

      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toContain('name=my-plugin');
      expect(url).toContain('isDefault=true');
    });

    it('should include auth headers', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ plugins: [], pagination: { total: 0, offset: 0, limit: 20, hasMore: false } }),
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      await pluginService.listPlugins('org-1', {}, { token: 'tok-xyz', userId: 'u1' });

      const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
      expect(headers['x-org-id']).toBe('org-1');
      expect(headers['Authorization']).toBe('Bearer tok-xyz');
    });

    it('should throw PluginServiceError on non-ok response', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: () => Promise.resolve({ message: 'Forbidden', code: 'FORBIDDEN' }),
      }) as unknown as typeof fetch;

      await expect(
        pluginService.listPlugins('org-1', {}, { token: 'tok' }),
      ).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
    });
  });

  describe('getPluginById', () => {
    it('should append id to URL', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id: 'pl-1' }),
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      await pluginService.getPluginById('org-1', 'pl-1', { token: 'tok' });
      expect(fetchMock.mock.calls[0][0]).toBe('http://svc/get-plugin/pl-1');
    });
  });

  describe('getPlugin', () => {
    it('should append filter as query string', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id: 'pl-1' }),
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      await pluginService.getPlugin(
        'org-1',
        { name: 'pkg', version: '1.0.0' },
        { token: 'tok' },
      );

      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toContain('name=pkg');
      expect(url).toContain('version=1.0.0');
    });
  });

  describe('uploadPlugin', () => {
    it('should POST multipart body', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id: 'pl-new', message: 'uploaded' }),
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      const result = await pluginService.uploadPlugin(
        'org-1',
        { file: Buffer.from('zip-data'), filename: 'plugin.zip', accessModifier: 'public' },
        { token: 'tok' },
      );

      const opts = fetchMock.mock.calls[0][1] as RequestInit;
      expect(opts.method).toBe('POST');
      expect((opts.headers as Record<string, string>)['Content-Type']).toMatch(/multipart\/form-data; boundary=/);
      const body = opts.body as Buffer;
      const text = body.toString('utf-8');
      expect(text).toContain('plugin.zip');
      expect(text).toContain('zip-data');
      expect(text).toContain('accessModifier');
      expect(text).toContain('public');
      expect(result.id).toBe('pl-new');
    });

    it('should reject with PluginServiceError when token missing', async () => {
      await expect(
        pluginService.uploadPlugin(
          'org-1',
          { file: Buffer.from('data'), filename: 'p.zip' },
          { token: '' },
        ),
      ).rejects.toBeInstanceOf(PluginServiceError);
    });

    it('should throw PluginServiceError on upstream error', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 413,
        json: () => Promise.resolve({ message: 'Too large', code: 'PAYLOAD_TOO_LARGE' }),
      }) as unknown as typeof fetch;

      await expect(
        pluginService.uploadPlugin(
          'org-1',
          { file: Buffer.from('big'), filename: 'big.zip' },
          { token: 'tok' },
        ),
      ).rejects.toMatchObject({ statusCode: 413, code: 'PAYLOAD_TOO_LARGE' });
    });
  });

  describe('PluginServiceError', () => {
    it('should be an instance of Error with metadata', () => {
      const err = new PluginServiceError('boom', 500, 'INTERNAL');
      expect(err).toBeInstanceOf(Error);
      expect(err.statusCode).toBe(500);
      expect(err.code).toBe('INTERNAL');
      expect(err.name).toBe('PluginServiceError');
    });
  });
});
