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

/** Stub ApiClient that records the lookup filter each call was sent. */
function clientCapturing(body: unknown, sink: Array<Record<string, unknown>>): ApiClient {
  return { post: async (_url: string, payload: { filter: Record<string, unknown> }) => { sink.push(payload.filter); return body; } } as unknown as ApiClient;
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

  // Regression: the plugin `name` is a sibling of `filter` on the ref, but the
  // lookup matches on the filter. A name-less filter matches ANY plugin with
  // those attributes and the endpoint returns an arbitrary one — so the lookup
  // MUST always carry `ref.name`.
  it('always sends the plugin name in the lookup filter (even when the ref filter omits it)', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const client = clientCapturing({ data: { plugin: PLUGIN } }, sent);
    await resolvePluginsForProps(client, propsWithPlugin('cdk-synth', {
      version: '1.0.0', accessModifier: 'public', isActive: true, isDefault: true, // no `name`
    }));
    expect(sent).toHaveLength(1);
    expect(sent[0].name).toBe('cdk-synth');
    expect(sent[0].version).toBe('1.0.0');
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
