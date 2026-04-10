// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  PluginFilterSchema,
  PluginCreateSchema,
  PluginUpdateSchema,
  PluginUploadBodySchema,
} from '../src/validation/plugin-schemas';

describe('PluginFilterSchema', () => {
  it('accepts valid filter', () => {
    const result = PluginFilterSchema.safeParse({
      name: 'my-plugin',
      version: '1.0.0',
    });
    expect(result.success).toBe(true);
  });

  it('accepts empty filter (all optional)', () => {
    const result = PluginFilterSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('rejects empty name string', () => {
    const result = PluginFilterSchema.safeParse({ name: '' });
    expect(result.success).toBe(false);
  });

  it('accepts isActive and isDefault booleans', () => {
    const result = PluginFilterSchema.safeParse({ isActive: true, isDefault: false });
    expect(result.success).toBe(true);
  });
});

describe('PluginCreateSchema', () => {
  const validPlugin = {
    orgId: 'org-123',
    name: 'python-test',
    version: '1.0.0',
    imageTag: 'python-test:1.0.0',
  };

  it('accepts valid plugin create body', () => {
    const result = PluginCreateSchema.safeParse(validPlugin);
    expect(result.success).toBe(true);
  });

  it('requires orgId', () => {
    const { orgId: _, ...rest } = validPlugin;
    const result = PluginCreateSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('requires name', () => {
    const { name: _, ...rest } = validPlugin;
    const result = PluginCreateSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('requires version', () => {
    const { version: _, ...rest } = validPlugin;
    const result = PluginCreateSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('requires imageTag', () => {
    const { imageTag: _, ...rest } = validPlugin;
    const result = PluginCreateSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('accepts optional secrets array', () => {
    const result = PluginCreateSchema.safeParse({
      ...validPlugin,
      secrets: [
        { name: 'API_KEY', required: true, description: 'External API key' },
        { name: 'TOKEN', required: false },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('accepts optional failureBehavior enum', () => {
    expect(PluginCreateSchema.safeParse({ ...validPlugin, failureBehavior: 'fail' }).success).toBe(true);
    expect(PluginCreateSchema.safeParse({ ...validPlugin, failureBehavior: 'warn' }).success).toBe(true);
    expect(PluginCreateSchema.safeParse({ ...validPlugin, failureBehavior: 'ignore' }).success).toBe(true);
    expect(PluginCreateSchema.safeParse({ ...validPlugin, failureBehavior: 'invalid' }).success).toBe(false);
  });
});

describe('PluginUpdateSchema', () => {
  it('allows partial updates', () => {
    const result = PluginUpdateSchema.safeParse({ name: 'new-name' });
    expect(result.success).toBe(true);
  });

  it('accepts empty object (all fields optional)', () => {
    const result = PluginUpdateSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('validates nested fields', () => {
    const result = PluginUpdateSchema.safeParse({
      env: { NODE_ENV: 'production' },
      commands: ['npm test'],
      keywords: ['test', 'ci'],
    });
    expect(result.success).toBe(true);
  });
});

describe('PluginUploadBodySchema', () => {
  it('accepts valid accessModifier', () => {
    expect(PluginUploadBodySchema.safeParse({ accessModifier: 'private' }).success).toBe(true);
    expect(PluginUploadBodySchema.safeParse({ accessModifier: 'public' }).success).toBe(true);
  });

  it('rejects invalid accessModifier', () => {
    expect(PluginUploadBodySchema.safeParse({ accessModifier: 'internal' }).success).toBe(false);
  });

  it('accepts empty body (all optional)', () => {
    expect(PluginUploadBodySchema.safeParse({}).success).toBe(true);
  });
});
