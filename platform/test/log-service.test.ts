// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

jest.mock('../src/config', () => ({
  config: {
    loki: {
      url: 'http://loki.test:3100',
      timeout: 5000,
    },
    logs: {
      defaultLimit: 100,
      maxLimit: 1000,
      defaultLookbackMs: 3_600_000,
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

import { queryLogs, getServiceNames, getLogLevels } from '../src/services/log-service';

describe('log-service', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('queryLogs', () => {
    it('should issue a Loki request and return parsed entries', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            status: 'success',
            data: {
              resultType: 'streams',
              result: [
                {
                  stream: { service_name: 'pipeline' },
                  values: [
                    ['1700000000000000000', '{"msg":"hello","level":"info"}'],
                    ['1700000001000000000', 'plain-text-line'],
                  ],
                },
              ],
            },
          }),
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      const result = await queryLogs({ service: 'pipeline', limit: 50 });

      expect(result.entries).toHaveLength(2);
      expect(result.entries[0].parsed).toEqual({ msg: 'hello', level: 'info' });
      expect(result.entries[1].parsed).toEqual({ raw: 'plain-text-line' });
      expect(result.entries[0].labels).toEqual({ service_name: 'pipeline' });
      expect(result.stats.entriesReturned).toBe(2);
      expect(result.stats.query).toContain('service_name="pipeline"');
    });

    it('should build LogQL with orgId and level filters', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ status: 'success', data: { resultType: 'streams', result: [] } }),
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      const result = await queryLogs({ orgId: 'org-1', level: 'error' });

      expect(result.stats.query).toContain('orgId="org-1"');
      expect(result.stats.query).toContain('level="error"');
      expect(result.stats.query).toContain('| json');
    });

    it('should add line filter for free-text search', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ status: 'success', data: { resultType: 'streams', result: [] } }),
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      const result = await queryLogs({ search: 'failed login' });
      expect(result.stats.query).toContain('|= `failed login`');
    });

    it('should escape backticks in search', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ status: 'success', data: { resultType: 'streams', result: [] } }),
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      const result = await queryLogs({ search: 'evil`code' });
      expect(result.stats.query).not.toContain('evil`code');
      expect(result.stats.query).toContain('evilcode');
    });

    it('should clamp limit to max', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ status: 'success', data: { resultType: 'streams', result: [] } }),
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      await queryLogs({ limit: 99999 });
      const url = (fetchMock.mock.calls[0][0] as string).toString();
      expect(url).toContain('limit=1000');
    });

    it('should throw when Loki returns non-ok', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('upstream error'),
      }) as unknown as typeof fetch;

      await expect(queryLogs({})).rejects.toThrow(/Loki returned 500/);
    });

    it('should default direction to backward', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ status: 'success', data: { resultType: 'streams', result: [] } }),
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      await queryLogs({});
      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toContain('direction=backward');
    });
  });

  describe('getServiceNames', () => {
    it('should return service name labels', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ status: 'success', data: ['pipeline', 'plugin'] }),
      }) as unknown as typeof fetch;

      const result = await getServiceNames();
      expect(result).toEqual(['pipeline', 'plugin']);
    });

    it('should return empty array when data missing', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ status: 'success' }),
      }) as unknown as typeof fetch;

      const result = await getServiceNames();
      expect(result).toEqual([]);
    });
  });

  describe('getLogLevels', () => {
    it('should return log level labels', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ status: 'success', data: ['error', 'warn', 'info'] }),
      }) as unknown as typeof fetch;

      const result = await getLogLevels();
      expect(result).toEqual(['error', 'warn', 'info']);
    });
  });
});
