// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from '@jest/globals';
import type { ApiClient } from '../src/utils/api-client.js';
import { resolvePluginsForProps } from '../src/utils/plugin-resolver.js';

/** Minimal props with one stage-step plugin ref. */
function propsWithPlugin(name: string, filter?: Record<string, unknown>) {
  return { stages: [{ steps: [{ plugin: { name, ...(filter ? { filter } : {}) } }] }] };
}

/** Stub ApiClient whose POST returns a fixed body. */
function clientReturning(body: unknown): ApiClient {
  return { post: async () => body } as unknown as ApiClient;
}

const PLUGIN = { name: 'java-corretto', version: '1.0.0', commands: ['gradle clean build'] };

describe('resolvePluginsForProps — lookup response unwrapping', () => {
  // Regression: the platform's standard success envelope DOUBLE-nests the record
  // as `{ success, statusCode, data: { plugin } }`. Stopping at `res.data` (which
  // is `{ plugin: ... }`) left `.name` undefined, so EVERY plugin fell back to
  // deploy-time resolution and the buildspec shipped the fail-loud no-op instead
  // of the plugin's real commands — even with the plugin present in the catalog.
  it('unwraps the platform envelope { data: { plugin } }', async () => {
    const client = clientReturning({ success: true, statusCode: 200, data: { plugin: PLUGIN } });
    const resolved = await resolvePluginsForProps(client, propsWithPlugin('java-corretto'));
    expect((resolved['java-corretto-alias'] as { name?: string })?.name).toBe('java-corretto');
  });

  it('tolerates { plugin } (single nesting)', async () => {
    const client = clientReturning({ plugin: PLUGIN });
    const resolved = await resolvePluginsForProps(client, propsWithPlugin('java-corretto'));
    expect((resolved['java-corretto-alias'] as { name?: string })?.name).toBe('java-corretto');
  });

  it('tolerates { data: Plugin } (plugin directly under data)', async () => {
    const client = clientReturning({ data: PLUGIN });
    const resolved = await resolvePluginsForProps(client, propsWithPlugin('java-corretto'));
    expect((resolved['java-corretto-alias'] as { name?: string })?.name).toBe('java-corretto');
  });

  it('tolerates a bare Plugin body', async () => {
    const client = clientReturning(PLUGIN);
    const resolved = await resolvePluginsForProps(client, propsWithPlugin('java-corretto'));
    expect((resolved['java-corretto-alias'] as { name?: string })?.name).toBe('java-corretto');
  });

  it('does NOT resolve when the record is absent (no record → fall back)', async () => {
    const client = clientReturning({ success: true, statusCode: 200, data: { plugin: null } });
    const resolved = await resolvePluginsForProps(client, propsWithPlugin('missing-plugin'));
    expect(resolved['missing-plugin-alias']).toBeUndefined();
  });
});
