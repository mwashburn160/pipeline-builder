// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';

type AnyFn = (...args: any[]) => any;

const mockWarn = jest.fn<AnyFn>();
jest.unstable_mockModule('@pipeline-builder/api-core', () => stubModule('@pipeline-builder/api-core', {
  createLogger: () => ({ info: () => {}, warn: mockWarn, debug: () => {}, error: () => {} }),
}));
// The SQL helpers are inert here: `elevated` answers the rows (or the failure) directly.
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  anyText: () => 'ids',
  executeRows: async () => [],
  isVersionRange: (v: string) => /[\^~*x<>| ]/.test(v),
  scopeOrgIds: () => ['org-a'],
}));
const mockElevated = jest.fn<AnyFn>();
jest.unstable_mockModule('../src/services/ecosystem/store.js', () => ({ elevated: mockElevated }));

const { pluginRowState } = await import('../src/services/plugin-row-state.js');

const scope = { orgId: 'org-a' } as never;

describe('pluginRowState', () => {
  beforeEach(() => { mockWarn.mockReset(); mockElevated.mockReset(); });

  it('classifies the rows', async () => {
    mockElevated.mockResolvedValueOnce([{ deleted: false, active: false, yanked: true }]);
    expect(await pluginRowState(scope, { name: 'p' })).toBe('yanked');
    mockElevated.mockResolvedValueOnce([]);
    expect(await pluginRowState(scope, { name: 'p' })).toBe('missing');
    expect(mockWarn).not.toHaveBeenCalled();
  });

  // A failed read used to answer `missing` silently: the 404 then told the
  // owner the plugin never existed while the database was the problem.
  it('logs a warning when the read fails, and answers missing', async () => {
    mockElevated.mockRejectedValueOnce(new Error('connection refused'));
    expect(await pluginRowState(scope, { name: 'p', version: '1.0.0' })).toBe('missing');
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('row state'), expect.objectContaining({ name: 'p', error: expect.stringContaining('connection refused') }));
  });
});
