// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * services/model-probe.ts — the live "is ask-model answering?" check behind
 * `GET /ask-agent/availability?probe=true`.
 *
 * Pins: reachable only when the server answers AND serves an advertised model;
 * every failure shape reads as unreachable; one cached answer per window; and
 * concurrent callers share one request.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({}));

const { probeSelfHostedModel, resetModelProbeCache } = await import('../src/services/model-probe.js');

const ENV = { ...process.env };

const served = (...ids: string[]) => ({ ok: true, json: async () => ({ data: ids.map((id) => ({ id })) }) }) as unknown as Response;

beforeEach(() => {
  resetModelProbeCache();
  process.env.OPENAI_COMPATIBLE_BASE_URL = 'http://ask-model:11434/v1/';
  process.env.OPENAI_COMPATIBLE_MODELS = 'qwen2.5:7b-instruct-ctx8k|Qwen 2.5 7B Instruct';
  delete process.env.OPENAI_COMPATIBLE_API_KEY;
});

afterEach(() => {
  process.env = { ...ENV };
});

describe('probeSelfHostedModel', () => {
  it('is reachable when the server lists an advertised model', async () => {
    const fetchImpl = jest.fn(async () => served('llama3', 'qwen2.5:7b-instruct-ctx8k'));
    expect(await probeSelfHostedModel(fetchImpl as unknown as typeof fetch)).toEqual({ reachable: true });
    expect(fetchImpl).toHaveBeenCalledWith('http://ask-model:11434/v1/models', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('is unreachable when the server answers but has not pulled the advertised model', async () => {
    const fetchImpl = jest.fn(async () => served('llama3'));
    expect(await probeSelfHostedModel(fetchImpl as unknown as typeof fetch)).toEqual({ reachable: false });
  });

  it('is unreachable on a refused connection or timeout', async () => {
    const fetchImpl = jest.fn(async () => { throw new TypeError('fetch failed'); });
    expect(await probeSelfHostedModel(fetchImpl as unknown as typeof fetch)).toEqual({ reachable: false });
  });

  it('is unreachable on a non-2xx answer', async () => {
    const fetchImpl = jest.fn(async () => ({ ok: false, json: async () => ({}) }) as unknown as Response);
    expect(await probeSelfHostedModel(fetchImpl as unknown as typeof fetch)).toEqual({ reachable: false });
  });

  it('is unreachable without contacting anything when no local endpoint is configured', async () => {
    delete process.env.OPENAI_COMPATIBLE_BASE_URL;
    const fetchImpl = jest.fn(async () => served('qwen2.5:7b-instruct-ctx8k'));
    expect(await probeSelfHostedModel(fetchImpl as unknown as typeof fetch)).toEqual({ reachable: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends the configured key as a bearer token', async () => {
    process.env.OPENAI_COMPATIBLE_API_KEY = 'k';
    const fetchImpl = jest.fn(async (_url: string, _init: RequestInit) => served('qwen2.5:7b-instruct-ctx8k'));
    await probeSelfHostedModel(fetchImpl as unknown as typeof fetch);
    expect((fetchImpl.mock.calls[0]![1].headers as Record<string, string>).authorization).toBe('Bearer k');
  });

  it('reuses one answer within the cache window, and asks again after it', async () => {
    let t = 1_000_000;
    const now = () => t;
    const fetchImpl = jest.fn(async () => served('qwen2.5:7b-instruct-ctx8k'));
    await probeSelfHostedModel(fetchImpl as unknown as typeof fetch, now);
    t += 5_000;
    await probeSelfHostedModel(fetchImpl as unknown as typeof fetch, now);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    t += 20_000;
    await probeSelfHostedModel(fetchImpl as unknown as typeof fetch, now);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight request between concurrent callers', async () => {
    const fetchImpl = jest.fn(async () => served('qwen2.5:7b-instruct-ctx8k'));
    const [a, b] = await Promise.all([
      probeSelfHostedModel(fetchImpl as unknown as typeof fetch),
      probeSelfHostedModel(fetchImpl as unknown as typeof fetch),
    ]);
    expect(a).toEqual(b);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
