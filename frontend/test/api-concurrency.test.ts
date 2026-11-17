// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Optimistic concurrency on the wire: the update methods of the user-edited
 * records forward `expectedUpdatedAt` in the PUT body unchanged (and omit it
 * when the caller does — last write wins), and the 412 refusal is recognized by
 * `isConcurrencyConflict`.
 */

import { describe, expect, it, jest } from '@jest/globals';
import { ApiCore } from '@/lib/api/core';
import { complianceApi } from '@/lib/api/domains/compliance';
import { pipelineTemplatesApi } from '@/lib/api/domains/pipeline-templates';
import { pipelinesApi } from '@/lib/api/domains/pipelines';
import { pluginsApi } from '@/lib/api/domains/plugins';
import { ApiError } from '@/lib/api/errors';
import { CONCURRENCY_CONFLICT_MESSAGE, expectedUpdatedAtOf, isConcurrencyConflict } from '@/lib/api/concurrency';

type Call = { path: string; init?: RequestInit };

function fakeCore() {
  const calls: Call[] = [];
  const core = {
    request: jest.fn(async (path: string, init?: RequestInit) => { calls.push({ path, init }); return { success: true, data: {} }; }),
    proposedByHeader: ApiCore.prototype.proposedByHeader,
  };
  return { core: core as unknown as ApiCore, calls };
}

const AT = '2026-11-02T10:00:00.123Z';

const UPDATES: Array<{ name: string; path: string; call: (core: ApiCore, extra: Record<string, unknown>) => Promise<unknown> }> = [
  { name: 'updatePipeline', path: '/api/pipelines/p1', call: (c, x) => pipelinesApi(c).updatePipeline('p1', { pipelineName: 'n', ...x }) },
  { name: 'updatePlugin', path: '/api/plugins/pl1', call: (c, x) => pluginsApi(c).updatePlugin('pl1', { description: 'd', ...x }) },
  { name: 'updatePipelineTemplate', path: '/api/pipeline-templates/t1', call: (c, x) => pipelineTemplatesApi(c).updatePipelineTemplate('t1', { name: 't', ...x }) },
  { name: 'updateComplianceRule', path: '/api/compliance/rules/r1', call: (c, x) => complianceApi(c).updateComplianceRule('r1', { name: 'r', ...x }) },
  { name: 'updateCompliancePolicy', path: '/api/compliance/policies/cp1', call: (c, x) => complianceApi(c).updateCompliancePolicy('cp1', { name: 'p', ...x }) },
];

describe('update methods carry expectedUpdatedAt', () => {
  it.each(UPDATES)('$name forwards it in the PUT body', async ({ path, call }) => {
    const { core, calls } = fakeCore();
    await call(core, { expectedUpdatedAt: AT });
    expect(calls[0].path).toBe(path);
    expect(calls[0].init?.method).toBe('PUT');
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({ expectedUpdatedAt: AT });
  });

  it.each(UPDATES)('$name omits it when the caller does (last write wins)', async ({ call }) => {
    const { core, calls } = fakeCore();
    await call(core, {});
    expect(JSON.parse(String(calls[0].init?.body))).not.toHaveProperty('expectedUpdatedAt');
  });

  it('getComplianceRule reads one rule by id (the rule editor\'s reload after a conflict)', async () => {
    const { core, calls } = fakeCore();
    await complianceApi(core).getComplianceRule('r1');
    expect(calls.map((c) => c.path)).toEqual(['/api/compliance/rules/r1']);
  });
});

describe('isConcurrencyConflict', () => {
  it('is true for the 412 PRECONDITION_FAILED refusal', () => {
    expect(isConcurrencyConflict(new ApiError('x', 412, 'PRECONDITION_FAILED'))).toBe(true);
    expect(isConcurrencyConflict(new ApiError('x', 412))).toBe(true);
  });

  it('is false for anything else', () => {
    expect(isConcurrencyConflict(new ApiError('frozen', 409, 'PLUGIN_VERSION_FROZEN'))).toBe(false);
    expect(isConcurrencyConflict(new Error('412'))).toBe(false);
    expect(isConcurrencyConflict(null)).toBe(false);
  });

  it('has the user-facing message', () => {
    expect(CONCURRENCY_CONFLICT_MESSAGE).toBe('This was changed by someone else since you opened it. Reload to see the latest.');
  });
});

describe('expectedUpdatedAtOf', () => {
  it('returns the record’s updatedAt as read, a Date as ISO, and undefined when absent', () => {
    expect(expectedUpdatedAtOf({ updatedAt: AT })).toBe(AT);
    expect(expectedUpdatedAtOf({ updatedAt: new Date(AT) })).toBe(AT);
    expect(expectedUpdatedAtOf({ updatedAt: new Date('nope') })).toBeUndefined();
    expect(expectedUpdatedAtOf({ updatedAt: null })).toBeUndefined();
    expect(expectedUpdatedAtOf({})).toBeUndefined();
    expect(expectedUpdatedAtOf(null)).toBeUndefined();
  });
});
