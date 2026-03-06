import { generateImageTag, createBuildJobData } from '../src/helpers/plugin-helpers';

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
