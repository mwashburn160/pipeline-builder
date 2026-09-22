// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from '@jest/globals';
import type { ApiClient } from '../src/utils/api-client.js';
import { lookupWarningsOf, resolvePluginsForProps } from '../src/utils/plugin-resolver.js';

/** Minimal props with one stage-step plugin ref. */
function propsWithPlugin(name: string, filter?: Record<string, unknown>) {
  return { stages: [{ steps: [{ plugin: { name, ...(filter ? { filter } : {}) } }] }] };
}

/** Props with a synth plugin ref (the path the cdk-synth bug bit). */
function propsWithSynth(name: string, filter?: Record<string, unknown>) {
  return { synth: { plugin: { name, alias: 'BuildSynth', ...(filter ? { filter } : {}) } } };
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
      version: '1.0.0', visibility: 'public', isActive: true, isDefault: true, // no `name`
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

describe('resolvePluginsForProps — image signature verification', () => {
  /** Stub ApiClient whose POST rejects the way ApiClient does on an HTTP error. */
  function clientRejecting(status: number, data: unknown): ApiClient {
    return {
      post: async () => { throw Object.assign(new Error((data as { message?: string })?.message ?? 'failed'), { status, response: { status, data } }); },
    } as unknown as ApiClient;
  }

  // A plugin whose image signature doesn't verify must stop the synth — falling
  // back to deploy-time resolution would quietly turn it into an unresolved step.
  it('aborts on 409 IMAGE_VERIFICATION_FAILED instead of falling back', async () => {
    const client = clientRejecting(409, { success: false, code: 'IMAGE_VERIFICATION_FAILED', message: 'failed signature verification' });
    await expect(resolvePluginsForProps(client, propsWithPlugin('java-corretto')))
      .rejects.toThrow(/java-corretto" image failed signature verification/);
  });

  // A listing the org can't use (plugin ecosystem §3.2, §3.4) is not an outage
  // either: the synth stops with the refusal.
  it.each(['PLUGIN_NOT_INSTALLED', 'PLUGIN_BLOCKED_BY_POLICY', 'PLUGIN_UNAVAILABLE'])('aborts on %s', async (code) => {
    const client = clientRejecting(403, { success: false, code, message: 'acme/lint is not installed' });
    await expect(resolvePluginsForProps(client, { stages: [{ steps: [{ plugin: { publisher: 'acme', name: 'lint' } }] }] }))
      .rejects.toThrow(new RegExp(`"acme/lint" can't be used \\(${code}\\)`));
  });

  it('still falls back (non-fatal) on an ordinary lookup failure', async () => {
    const client = clientRejecting(503, { success: false, code: 'SERVICE_UNAVAILABLE', message: 'down' });
    await expect(resolvePluginsForProps(client, propsWithPlugin('java-corretto'))).resolves.toEqual({});
  });
});

describe('resolvePluginsForProps — lookup filter carries the plugin name', () => {
  // A name-less filter matches ANY plugin with those attributes; the endpoint
  // returns an arbitrary one (seen: dockerfile-multi-provider). So every lookup
  // MUST be pinned to the ref's plugin name. Bug symptom: cdk-synth resolved to
  // the AI Dockerfile generator and the synth stage ran the AI script.

  it('fills name from the ref when the filter omits it (preserving the rest)', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const client = clientCapturing({ data: { plugin: PLUGIN } }, sent);
    await resolvePluginsForProps(client, propsWithPlugin('checkstyle', {
      version: '1.0.0', visibility: 'public', isActive: true, isDefault: true,
    }));
    expect(sent[0]).toEqual({
      name: 'checkstyle', version: '1.0.0', visibility: 'public', isActive: true, isDefault: true,
    });
  });

  it('defaults to {name, isActive, isDefault} when there is no filter at all', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const client = clientCapturing({ data: { plugin: PLUGIN } }, sent);
    await resolvePluginsForProps(client, propsWithPlugin('jacoco'));
    expect(sent[0]).toEqual({ name: 'jacoco', isActive: true, isDefault: true });
  });

  it('pins the SYNTH lookup to cdk-synth (the exact bug) instead of a name-less match', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const client = clientCapturing({ data: { plugin: { name: 'cdk-synth' } } }, sent);
    await resolvePluginsForProps(client, propsWithSynth('cdk-synth', {
      version: '1.0.0', visibility: 'public', isActive: true, isDefault: true,
    }));
    expect(sent).toHaveLength(1);
    expect(sent[0].name).toBe('cdk-synth');
  });

  it('an explicit filter name takes precedence over the ref name (fill only when missing)', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const client = clientCapturing({ data: { plugin: PLUGIN } }, sent);
    await resolvePluginsForProps(client, propsWithPlugin('alias-name', { name: 'real-plugin', version: '2.0.0' }));
    expect(sent[0].name).toBe('real-plugin');
  });

  it('sends each plugin its own name when several refs are present', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const client = clientCapturing({ data: { plugin: PLUGIN } }, sent);
    await resolvePluginsForProps(client, {
      synth: { plugin: { name: 'cdk-synth', alias: 'BuildSynth' } },
      stages: [{
        steps: [
          { plugin: { name: 'java-corretto', filter: { isActive: true, isDefault: true } } },
          { plugin: { name: 'semgrep', filter: { isActive: true, isDefault: true } } },
        ],
      }],
    });
    expect(new Set(sent.map(f => f.name))).toEqual(new Set(['cdk-synth', 'java-corretto', 'semgrep']));
    expect(sent.every(f => typeof f.name === 'string' && f.name.length > 0)).toBe(true);
  });
});

/**
 * One alias, one plugin. Refs were deduplicated on the alias ALONE, so a second
 * plugin reusing an alias was dropped and its step silently ran the first
 * plugin's image and commands.
 */
describe('resolvePluginsForProps — alias collisions', () => {
  const twoSteps = (a: Record<string, unknown>, b: Record<string, unknown>) =>
    ({ stages: [{ steps: [{ plugin: a }, { plugin: b }] }] });

  it('refuses one alias used for two DIFFERENT plugins', async () => {
    const client = clientReturning({ data: { plugin: PLUGIN } });
    await expect(resolvePluginsForProps(client, twoSteps(
      { name: 'nodejs-build', alias: 'build' },
      { name: 'maven-build', alias: 'build' },
    ))).rejects.toThrow(/alias "build" is used for two different plugins/);
  });

  it('still de-duplicates the SAME plugin referenced twice under one alias', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const client = clientCapturing({ data: { plugin: PLUGIN } }, sent);
    await resolvePluginsForProps(client, twoSteps(
      { name: 'java-corretto', alias: 'build' },
      { name: 'java-corretto', alias: 'build' },
    ));
    expect(sent).toHaveLength(1);
  });

  it('is not fooled by an explicit filter name that resolves to the same plugin', async () => {
    // `filter.name` overrides the ref name by design, so both refs TARGET the
    // same plugin and are not a collision.
    const client = clientReturning({ data: { plugin: PLUGIN } });
    await expect(resolvePluginsForProps(client, twoSteps(
      { name: 'legacy-name', alias: 'build', filter: { name: 'java-corretto' } },
      { name: 'java-corretto', alias: 'build' },
    ))).resolves.toBeDefined();
  });
});

describe('lookupWarningsOf — lifecycle warnings synth prints (plugin-ecosystem W0.4)', () => {
  it('reads the messages beside the plugin in the lookup answer', () => {
    expect(lookupWarningsOf({
      plugin: PLUGIN,
      warnings: [
        { code: 'PLUGIN_DEPRECATED', message: 'Plugin java-corretto@1.0.0 is deprecated: Use 2.x.' },
        { code: 'PLUGIN_YANKED', message: '' },
        'junk',
      ],
    })).toEqual(['Plugin java-corretto@1.0.0 is deprecated: Use 2.x.']);
  });

  it('yields none for a missing or malformed warnings field', () => {
    expect(lookupWarningsOf({ plugin: PLUGIN })).toEqual([]);
    expect(lookupWarningsOf({ warnings: 'nope' })).toEqual([]);
    expect(lookupWarningsOf(undefined)).toEqual([]);
  });

  it('still resolves the plugin when the answer carries warnings', async () => {
    const client = clientReturning({ success: true, data: { plugin: PLUGIN, warnings: [{ code: 'PLUGIN_DEPRECATED', message: 'deprecated' }] } });
    const resolved = await resolvePluginsForProps(client, propsWithPlugin('java-corretto'));
    expect((resolved['java-corretto-alias'] as { name?: string })?.name).toBe('java-corretto');
  });
});

describe('resolvePluginsForProps — publisher references (§3.5)', () => {
  it('sends the publisher and keys the result by <publisher>-<name>-alias', async () => {
    const sink: Array<Record<string, unknown>> = [];
    const resolved = await resolvePluginsForProps(
      clientCapturing({ data: { plugin: { ...PLUGIN, name: 'lint', publisher: 'acme' } } }, sink),
      { stages: [{ steps: [{ plugin: { publisher: 'acme', name: 'lint', filter: { version: '^1.0.0' } } }] }] },
    );
    expect(sink).toEqual([{ name: 'lint', publisher: 'acme', version: '^1.0.0' }]);
    expect(Object.keys(resolved)).toEqual(['acme-lint-alias']);
  });

  it('treats the same name from two publishers as two plugins, and one alias for both as a collision', async () => {
    const both = { stages: [{ steps: [{ plugin: { name: 'lint' } }, { plugin: { publisher: 'acme', name: 'lint' } }] }] };
    const resolved = await resolvePluginsForProps(clientReturning({ data: { plugin: PLUGIN } }), both);
    expect(Object.keys(resolved).sort()).toEqual(['acme-lint-alias', 'lint-alias']);
    const clash = { stages: [{ steps: [{ plugin: { name: 'lint', alias: 'l' } }, { plugin: { publisher: 'acme', name: 'lint', alias: 'l' } }] }] };
    await expect(resolvePluginsForProps(clientReturning({ data: { plugin: PLUGIN } }), clash)).rejects.toThrow(/alias "l" is used for two different plugins/);
  });
});
