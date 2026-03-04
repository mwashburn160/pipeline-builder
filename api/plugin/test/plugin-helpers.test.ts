import { normalizePlugin, validateFilter, sendPluginNotFound, generateImageTag, createBuildJobData } from '../src/helpers/plugin-helpers';

// Mocks
jest.mock('uuid', () => ({
  v7: () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
}));

jest.mock('../src/helpers/docker-build', () => ({}));

jest.mock('@mwashburn160/api-core', () => ({
  normalizeArrayFields: jest.fn(<T extends Record<string, unknown>>(record: T, fields: (keyof T)[]) => {
    const result = { ...record };
    for (const field of fields) {
      if (!Array.isArray(result[field])) {
        (result as Record<string, unknown>)[field as string] = [];
      }
    }
    return result;
  }),
  sendEntityNotFound: jest.fn(),
  validateQuery: jest.fn((_req: any, _schema: any) => ({ ok: true, value: {} })),
  PluginFilterSchema: {},
}));

jest.mock('@mwashburn160/pipeline-core', () => ({
  CoreConstants: {
    PLUGIN_IMAGE_PREFIX: 'p-',
  },
  schema: {
    plugin: {
      id: 'id',
      name: 'name',
      version: 'version',
      createdAt: 'createdAt',
      updatedAt: 'updatedAt',
      isActive: 'isActive',
      isDefault: 'isDefault',
    },
  },
}));

jest.mock('drizzle-orm', () => ({
  asc: jest.fn(),
  desc: jest.fn(),
}));

// Tests

describe('plugin-helpers', () => {
  describe('normalizePlugin', () => {
    it('should return the record with array fields ensured', () => {
      const record = { id: '1', name: 'test', keywords: null, installCommands: undefined, commands: 'echo hi' };
      const result = normalizePlugin(record as any);

      expect(Array.isArray(result.keywords)).toBe(true);
      expect(Array.isArray(result.installCommands)).toBe(true);
      expect(Array.isArray(result.commands)).toBe(true);
    });

    it('should preserve existing arrays', () => {
      const record = { id: '1', keywords: ['a', 'b'], installCommands: ['npm i'], commands: ['build'] };
      const result = normalizePlugin(record as any);

      expect(result.keywords).toEqual(['a', 'b']);
      expect(result.installCommands).toEqual(['npm i']);
      expect(result.commands).toEqual(['build']);
    });

    it('should not modify non-array fields', () => {
      const record = { id: '1', name: 'test-plugin', version: '1.0.0', keywords: [], installCommands: [], commands: [] };
      const result = normalizePlugin(record as any);

      expect(result.id).toBe('1');
      expect(result.name).toBe('test-plugin');
      expect(result.version).toBe('1.0.0');
    });
  });

  describe('validateFilter', () => {
    it('should call validateQuery with the request and PluginFilterSchema', () => {
      const { validateQuery } = jest.requireMock('@mwashburn160/api-core');
      const req = { query: { name: 'my-plugin' } } as any;

      validateFilter(req);

      expect(validateQuery).toHaveBeenCalledWith(req, expect.anything());
    });

    it('should return ok result for valid input', () => {
      const { validateQuery } = jest.requireMock('@mwashburn160/api-core');
      validateQuery.mockReturnValueOnce({ ok: true, value: { name: 'test' } });

      const result = validateFilter({ query: { name: 'test' } } as any);
      expect(result.ok).toBe(true);
    });

    it('should return error for invalid input', () => {
      const { validateQuery } = jest.requireMock('@mwashburn160/api-core');
      validateQuery.mockReturnValueOnce({ ok: false, error: 'Invalid filter' });

      const result = validateFilter({ query: {} } as any);
      expect(result.ok).toBe(false);
    });
  });

  describe('sendPluginNotFound', () => {
    it('should send 404 response with plugin entity name', () => {
      const { sendEntityNotFound } = jest.requireMock('@mwashburn160/api-core');
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() } as any;

      sendPluginNotFound(res);

      expect(sendEntityNotFound).toHaveBeenCalledWith(res, 'Plugin');
    });
  });

  describe('generateImageTag', () => {
    it('should generate a lowercase tag with prefix and uuid suffix', () => {
      const tag = generateImageTag('My-Plugin');
      expect(tag).toBe('p-myplugin-aaaaaaaa');
    });

    it('should strip non-alphanumeric characters', () => {
      const tag = generateImageTag('test@plugin#v2');
      expect(tag).toBe('p-testpluginv2-aaaaaaaa');
    });
  });

  describe('createBuildJobData', () => {
    it('should apply defaults for omitted pluginRecord fields', () => {
      const result = createBuildJobData({
        requestId: 'req-1',
        orgId: 'org-1',
        userId: 'user-1',
        authToken: 'Bearer tok',
        buildRequest: {
          contextDir: '/tmp/ctx',
          dockerfile: 'Dockerfile',
          imageTag: 'p-test-1234',
          registry: { host: 'reg', port: 5000, user: 'u', token: 't', network: '' },
        },
        pluginRecord: {
          orgId: 'org-1',
          name: 'test',
          version: '1.0.0',
          commands: ['echo hi'],
          imageTag: 'p-test-1234',
          accessModifier: 'private',
        },
      });

      expect(result.pluginRecord.pluginType).toBe('CodeBuildStep');
      expect(result.pluginRecord.computeType).toBe('SMALL');
      expect(result.pluginRecord.failureBehavior).toBe('fail');
      expect(result.pluginRecord.keywords).toEqual([]);
      expect(result.pluginRecord.secrets).toEqual([]);
      expect(result.pluginRecord.description).toBeNull();
    });

    it('should preserve explicitly provided fields', () => {
      const result = createBuildJobData({
        requestId: 'req-1',
        orgId: 'org-1',
        userId: 'user-1',
        authToken: 'Bearer tok',
        buildRequest: {
          contextDir: '/tmp/ctx',
          dockerfile: 'Dockerfile',
          imageTag: 'p-test-1234',
          registry: { host: 'reg', port: 5000, user: 'u', token: 't', network: '' },
        },
        pluginRecord: {
          orgId: 'org-1',
          name: 'test',
          version: '2.0.0',
          commands: ['npm run build'],
          imageTag: 'p-test-1234',
          accessModifier: 'public',
          pluginType: 'ManualApprovalStep',
          computeType: 'LARGE',
          description: 'Custom desc',
        },
      });

      expect(result.pluginRecord.pluginType).toBe('ManualApprovalStep');
      expect(result.pluginRecord.computeType).toBe('LARGE');
      expect(result.pluginRecord.description).toBe('Custom desc');
    });
  });
});
