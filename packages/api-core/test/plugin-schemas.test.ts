// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from '@jest/globals';

import {
  PluginFilterSchema,
  PluginCreateSchema,
  PluginUpdateSchema,
  PluginUploadBodySchema,
} from '../src/validation/plugin-schemas.js';

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

  it('accepts a publisher handle and refuses a malformed one', () => {
    expect(PluginFilterSchema.safeParse({ name: 'lint', publisher: 'acme-corp' }).success).toBe(true);
    expect(PluginFilterSchema.safeParse({ name: 'lint', publisher: 'Acme' }).success).toBe(false);
  });
});

describe('PluginCreateSchema', () => {
  const validPlugin = {
    orgId: 'org-123',
    name: 'python-test',
    version: '1.0.0',
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
  it('allows partial descriptive + operational updates', () => {
    const result = PluginUpdateSchema.safeParse({ summary: 'One line.', keywords: ['test', 'ci'], isActive: false, homepageUrl: null });
    expect(result.success).toBe(true);
  });

  it('accepts empty object (all fields optional)', () => {
    const result = PluginUpdateSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('refuses execution-contract keys and anything unknown (strict)', () => {
    for (const body of [{ name: 'new-name' }, { commands: ['npm test'] }, { env: { A: 'b' } }, { bogus: 1 }]) {
      expect(PluginUpdateSchema.safeParse(body).success).toBe(false);
    }
  });

  it('applies the shared catalog validator to descriptive fields', () => {
    expect(PluginUpdateSchema.safeParse({ license: 'WTFPL' }).success).toBe(false);
    expect(PluginUpdateSchema.safeParse({ category: 'security', documentationUrl: 'https://docs.acme.io' }).success).toBe(true);
  });
});

describe('PluginUploadBodySchema', () => {
  it('accepts valid visibility', () => {
    expect(PluginUploadBodySchema.safeParse({ visibility: 'private' }).success).toBe(true);
    expect(PluginUploadBodySchema.safeParse({ visibility: 'public' }).success).toBe(true);
  });

  it('rejects invalid visibility', () => {
    expect(PluginUploadBodySchema.safeParse({ visibility: 'internal' }).success).toBe(false);
  });

  it('accepts empty body (all optional)', () => {
    expect(PluginUploadBodySchema.safeParse({}).success).toBe(true);
  });

  it('accepts the catalog `metadata` part as JSON text', () => {
    expect(PluginUploadBodySchema.safeParse({ metadata: '{"summary":"x"}' }).success).toBe(true);
    expect(PluginUploadBodySchema.safeParse({ metadata: { summary: 'x' } }).success).toBe(false);
  });
});
