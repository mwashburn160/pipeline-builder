// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('../src/helpers/docker-build.js', () => ({}));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  normalizeArrayFields: jest.fn(<T extends Record<string, unknown>>(record: T, fields: (keyof T)[]) => {
    const result = { ...record };
    for (const field of fields) {
      if (!Array.isArray(result[field])) {
        (result as Record<string, unknown>)[field as string] = [];
      }
    }
    return result;
  }),
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => ({}));

const { createBuildJobData, pluginUri, shapePlugin } = await import('../src/helpers/plugin-helpers.js');

// Tests

describe('plugin-helpers', () => {
  describe('pluginUri', () => {
    it('uses `system/<name>:<version>` for system-org plugins', () => {
      expect(pluginUri({ orgId: '000000000000000000000001', name: 'cdk-synth', version: '1.0.0' }))
        .toBe('system/cdk-synth:1.0.0');
    });

    it('uses `org-<orgId>/<name>:<version>` for tenant-org plugins', () => {
      expect(pluginUri({ orgId: 'acme', name: 'nodejs-build', version: '2.3.1' }))
        .toBe('org-acme/nodejs-build:2.3.1');
    });
  });

  describe('shapePlugin', () => {
    it('attaches the computed uri', () => {
      const result = shapePlugin({ orgId: 'acme', name: 'foo', version: '1.0.0' });
      expect(result.uri).toBe('org-acme/foo:1.0.0');
    });

    it('preserves the original fields', () => {
      const input = { orgId: 'acme', name: 'foo', version: '1.0.0', extra: 42 };
      const result = shapePlugin(input);
      expect(result.orgId).toBe('acme');
      expect(result.name).toBe('foo');
      expect(result.version).toBe('1.0.0');
      expect((result as Record<string, unknown>).extra).toBe(42);
    });
  });

  describe('createBuildJobData', () => {
    it('should apply defaults for omitted pluginRecord fields', () => {
      const result = createBuildJobData({
        requestId: 'req-1',
        orgId: 'org-1',
        userId: 'user-1',
        buildRequest: {
          contextDir: '/tmp/ctx',
          dockerfile: 'Dockerfile',
          name: 'test',
          version: '1.0.0',

          orgId: 'org-1',
          buildType: 'build_image',
          registry: { host: 'reg', port: 5000, network: '', http: true },
        },
        pluginRecord: {
          orgId: 'org-1',
          name: 'test',
          version: '1.0.0',
          commands: ['echo hi'],

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
        buildRequest: {
          contextDir: '/tmp/ctx',
          dockerfile: 'Dockerfile',
          name: 'test',
          version: '1.0.0',

          orgId: 'org-1',
          buildType: 'build_image',
          registry: { host: 'reg', port: 5000, network: '', http: true },
        },
        pluginRecord: {
          orgId: 'org-1',
          name: 'test',
          version: '2.0.0',
          commands: ['npm run build'],

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
