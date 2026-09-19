// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * URL contracts for the list reads this slice reshaped:
 *  - `listAllPipelines` drains `GET /pipelines` with the keyset cursor and a
 *    sparse fieldset, and refuses to return a partial set on a failed page;
 *  - the message lists send the server-side read/priority/channel filters;
 *  - the build-queue listings page with limit/offset;
 *  - the list fieldsets never ask for the heavy columns.
 */

import type { ApiCore } from '../src/lib/api/core';
import { pipelinesApi, PIPELINE_LIST_FIELDS } from '../src/lib/api/domains/pipelines';
import { messagesApi } from '../src/lib/api/domains/messages';
import { pluginsApi, PLUGIN_LIST_FIELDS } from '../src/lib/api/domains/plugins';
import { parseBulkPipelineSpecs } from '../src/components/pipeline/BulkImportPipelinesModal';

function fakeCore(responses: unknown[] = []) {
  const calls: string[] = [];
  const core = {
    request: jest.fn((path: string) => {
      calls.push(path);
      return Promise.resolve(responses.shift() ?? { success: true, data: {} });
    }),
  } as unknown as ApiCore;
  return { core, calls };
}

const query = (path: string) => new URLSearchParams(path.split('?')[1]);

describe('listAllPipelines', () => {
  it('follows nextCursor until hasMore is false, sending the fieldset every page', async () => {
    const { core, calls } = fakeCore([
      { success: true, data: { pipelines: [{ id: 'a' }, { id: 'b' }], pagination: { hasMore: true, nextCursor: 'c1' } } },
      { success: true, data: { pipelines: [{ id: 'c' }], pagination: { hasMore: false } } },
    ]);

    const rows = await pipelinesApi(core).listAllPipelines(['pipelineName'] as const, { ownerId: 'u1' });

    expect(rows.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(calls).toHaveLength(2);
    expect(query(calls[0]).get('fields')).toBe('pipelineName');
    expect(query(calls[0]).get('ownerId')).toBe('u1');
    expect(query(calls[0]).get('cursor')).toBeNull();
    expect(query(calls[1]).get('cursor')).toBe('c1');
  });

  it('throws on a failed page instead of returning a partial set', async () => {
    const { core } = fakeCore([
      { success: true, data: { pipelines: [{ id: 'a' }], pagination: { hasMore: true, nextCursor: 'c1' } } },
      { success: false, statusCode: 500, message: 'boom' },
    ]);
    await expect(pipelinesApi(core).listAllPipelines(['pipelineName'] as const)).rejects.toThrow('boom');
  });
});

describe('list fieldsets', () => {
  it('the pipelines list never requests `props`', () => {
    expect(PIPELINE_LIST_FIELDS).not.toContain('props' as never);
  });

  it('the plugins list never requests the build spec, but keeps what `uri` derives from', () => {
    for (const heavy of ['dockerfile', 'commands', 'installCommands', 'env', 'buildArgs', 'metadata', 'secrets']) {
      expect(PLUGIN_LIST_FIELDS).not.toContain(heavy as never);
    }
    expect(PLUGIN_LIST_FIELDS).toEqual(expect.arrayContaining(['orgId', 'name', 'version']));
  });
});

describe('message list filters', () => {
  it.each([
    ['getMessages', '/api/messages'],
    ['getAnnouncements', '/api/messages/announcements'],
    ['getConversations', '/api/messages/conversations'],
  ] as const)('%s sends isRead / priority / channel', async (method, path) => {
    const { core, calls } = fakeCore();
    await messagesApi(core)[method]({ isRead: false, priority: 'urgent', channel: 'support', limit: 25, offset: 0 });
    expect(calls[0].split('?')[0]).toBe(path);
    const q = query(calls[0]);
    expect(q.get('isRead')).toBe('false');
    expect(q.get('priority')).toBe('urgent');
    expect(q.get('channel')).toBe('support');
  });

  it('getMessage reads one message by (encoded) id', async () => {
    const { core, calls } = fakeCore();
    await messagesApi(core).getMessage('m 1');
    expect(calls[0]).toBe('/api/messages/m%201');
  });
});

describe('build-queue listings', () => {
  it('page with limit/offset', async () => {
    const { core, calls } = fakeCore();
    const api = pluginsApi(core);
    await api.getQueueFailed({ limit: 25, offset: 50 });
    await api.getQueueDlq({ limit: 10, offset: 0 });
    expect(calls[0]).toBe('/api/plugins/queue/failed?limit=25&offset=50');
    expect(calls[1]).toBe('/api/plugins/queue/dlq?limit=10&offset=0');
  });
});

describe('parseBulkPipelineSpecs', () => {
  it('accepts a bare array or a { pipelines } envelope', () => {
    const spec = { project: 'p', organization: 'o', props: {} };
    expect(parseBulkPipelineSpecs(JSON.stringify([spec]))).toEqual({ specs: [spec] });
    expect(parseBulkPipelineSpecs(JSON.stringify({ pipelines: [spec] }))).toEqual({ specs: [spec] });
  });

  it('rejects invalid JSON and empty sets with a message', () => {
    expect(parseBulkPipelineSpecs('{nope')).toEqual({ error: expect.stringMatching(/invalid json/i) });
    expect(parseBulkPipelineSpecs('[]')).toEqual({ error: expect.stringMatching(/non-empty/i) });
  });
});
