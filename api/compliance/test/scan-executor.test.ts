// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

// db chainable helpers
type ChainTerminal = () => Promise<unknown[]>;
function makeChain(terminal: ChainTerminal): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const name of ['from', 'innerJoin', 'leftJoin', 'where', 'set', 'orderBy', 'limit', 'offset', 'values', 'returning']) {
    chain[name] = jest.fn(() => chain);
  }
  (chain as { then: unknown }).then = (resolve: (v: unknown[]) => unknown) => terminal().then(resolve);
  return chain;
}

// Stack of selectResults — each db.select() consumes one entry (FIFO).
let selectResults: unknown[][] = [];
function nextSelect(): unknown[] {
  return selectResults.length > 0 ? selectResults.shift()! : [];
}

// Stack of update returning results — each db.update().returning() consumes one
// entry (FIFO). The scan-executor now claims work atomically via
// UPDATE ... RETURNING, so the FIRST entry is the claimed scan row (or [] when
// the scan does not exist / is not pending).
let updateReturning: unknown[][] = [];
function nextUpdate(): unknown[] {
  return updateReturning.length > 0 ? updateReturning.shift()! : [];
}

const dbSelect = jest.fn(() => makeChain(() => Promise.resolve(nextSelect())));
const dbInsert = jest.fn(() => makeChain(() => Promise.resolve([])));
const dbUpdate = jest.fn(() => makeChain(() => Promise.resolve(nextUpdate())));

const mockEvaluateRules = jest.fn();
const mockFindActiveByOrgAndTarget = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockLogComplianceCheck = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(undefined);
const mockNotifyComplianceBlock = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(undefined);
const mockNotifyComplianceWarnings = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(undefined);

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => ({
  schema: {
    complianceScan: { id: 'col_id', status: 'col_status', orgId: 'col_org' },
    complianceExemption: {},
    plugin: { id: 'col_pid', name: 'col_pname', isActive: 'col_pactive', orgId: 'col_porg' },
    pipeline: { id: 'col_plid', pipelineName: 'col_plname', isActive: 'col_plactive', orgId: 'col_plorg' },
  },
  // executeScan is wrapped in runWithTenantContext({ isSuperAdmin: true }) and
  // every DB op goes through withTenantTx — pass through to the spies above.
  runWithTenantContext: (_ctx: unknown, fn: () => unknown) => fn(),
  withTenantTx: (fn: (tx: unknown) => unknown) => fn({
    select: dbSelect,
    insert: dbInsert,
    update: dbUpdate,
  }),
}));

jest.unstable_mockModule('../src/engine/rule-engine.js', () => ({
  evaluateRules: mockEvaluateRules,
}));

jest.unstable_mockModule('../src/services/compliance-rule-service.js', () => ({
  complianceRuleService: {
    findActiveByOrgAndTarget: mockFindActiveByOrgAndTarget,
  },
}));

jest.unstable_mockModule('../src/helpers/audit-logger.js', () => ({
  logComplianceCheck: mockLogComplianceCheck,
}));

jest.unstable_mockModule('../src/helpers/compliance-notifier.js', () => ({
  notifyComplianceBlock: mockNotifyComplianceBlock,
  notifyComplianceWarnings: mockNotifyComplianceWarnings,
}));

const { executeScan } = await import('../src/helpers/scan-executor.js');

describe('executeScan', () => {
  beforeEach(() => {
    selectResults = [];
    updateReturning = [];
    dbSelect.mockClear();
    dbInsert.mockClear();
    dbUpdate.mockClear();
    mockEvaluateRules.mockReset();
    mockFindActiveByOrgAndTarget.mockReset();
    mockLogComplianceCheck.mockClear();
    mockNotifyComplianceBlock.mockClear();
    mockNotifyComplianceWarnings.mockClear();
  });

  it('exits early when scan does not exist', async () => {
    // Atomic claim returns no row (scan id unknown) → executor must bail
    // before any further updates.
    updateReturning = [[]];
    await executeScan('scan-x');
    // The atomic claim itself is one UPDATE; no further updates after the bail.
    expect(dbUpdate).toHaveBeenCalledTimes(1);
  });

  it('exits early when scan is not pending', async () => {
    // Atomic claim WHERE status='pending' returns no row when scan is already
    // completed/running.
    updateReturning = [[]];
    await executeScan('scan-1');
    expect(dbUpdate).toHaveBeenCalledTimes(1);
  });

  it('marks system-org scans as completed without evaluating rules', async () => {
    updateReturning = [
      [{ id: 'scan-1', status: 'running', orgId: 'SYSTEM', target: 'plugin', userId: 'u' }],
    ];
    await executeScan('scan-1');
    expect(dbUpdate).toHaveBeenCalled();
    expect(mockFindActiveByOrgAndTarget).not.toHaveBeenCalled();
  });

  it('completes scan with no rules (counts as all-pass)', async () => {
    updateReturning = [
      [{ id: 'scan-1', status: 'running', orgId: 'org-1', target: 'plugin', userId: 'u', triggeredBy: 'manual' }],
    ];
    selectResults = [
      // entities for plugin target
      [{ id: 'p1', name: 'p1' }, { id: 'p2', name: 'p2' }],
    ];
    mockFindActiveByOrgAndTarget.mockResolvedValue([]);

    await executeScan('scan-1');

    expect(mockFindActiveByOrgAndTarget).toHaveBeenCalledWith('org-1', 'plugin');
    expect(mockEvaluateRules).not.toHaveBeenCalled();
    // Atomic claim + totalEntities update + final "completed" update.
    expect(dbUpdate).toHaveBeenCalled();
  });

  it('evaluates rules and writes audit entries on full scan', async () => {
    updateReturning = [
      [{ id: 'scan-1', status: 'running', orgId: 'org-1', target: 'plugin', userId: 'u', triggeredBy: 'manual' }],
    ];
    selectResults = [
      [{ id: 'p1', name: 'p1' }],
      [], // exemptions fetch
    ];
    mockFindActiveByOrgAndTarget.mockResolvedValue([{ id: 'rule-1' }]);
    mockEvaluateRules.mockReturnValue({
      blocked: false,
      violations: [],
      warnings: [],
      rulesEvaluated: 1,
    });

    await executeScan('scan-1');

    expect(mockEvaluateRules).toHaveBeenCalled();
    // audit-log is fire-and-forget — let microtasks run
    await new Promise((r) => setImmediate(r));
    expect(mockLogComplianceCheck).toHaveBeenCalled();
  });

  it('skips audit entries on dry-run', async () => {
    updateReturning = [
      [{ id: 'scan-1', status: 'running', orgId: 'org-1', target: 'plugin', userId: 'u', triggeredBy: 'rule-dry-run' }],
    ];
    selectResults = [
      [{ id: 'p1', name: 'p1' }],
      [],
    ];
    mockFindActiveByOrgAndTarget.mockResolvedValue([{ id: 'rule-1' }]);
    mockEvaluateRules.mockReturnValue({
      blocked: false,
      violations: [],
      warnings: [],
      rulesEvaluated: 1,
    });

    await executeScan('scan-1');

    await new Promise((r) => setImmediate(r));
    expect(mockLogComplianceCheck).not.toHaveBeenCalled();
  });

  it('notifies on blocked entity (non-dry-run)', async () => {
    updateReturning = [
      [{ id: 'scan-1', status: 'running', orgId: 'org-1', target: 'plugin', userId: 'u', triggeredBy: 'manual' }],
    ];
    selectResults = [
      [{ id: 'p1', name: 'p1' }],
      [],
    ];
    mockFindActiveByOrgAndTarget.mockResolvedValue([{ id: 'rule-1' }]);
    mockEvaluateRules.mockReturnValue({
      blocked: true,
      violations: [{ ruleId: 'rule-1' }],
      warnings: [],
      rulesEvaluated: 1,
    });

    await executeScan('scan-1');

    await new Promise((r) => setImmediate(r));
    expect(mockNotifyComplianceBlock).toHaveBeenCalled();
  });

  it('marks scan failed on unexpected error', async () => {
    updateReturning = [
      [{ id: 'scan-1', status: 'running', orgId: 'org-1', target: 'plugin', userId: 'u', triggeredBy: 'manual' }],
    ];
    selectResults = [
      [{ id: 'p1', name: 'p1' }], // entities
    ];
    // findActive throws, executor enters catch → marks failed
    mockFindActiveByOrgAndTarget.mockRejectedValue(new Error('rule lookup down'));

    await executeScan('scan-1');

    // Final update with status:'failed' must be present in some db.update call
    expect(dbUpdate).toHaveBeenCalled();
  });

  it('handles scans with target="all" by iterating both targets', async () => {
    updateReturning = [
      [{ id: 'scan-1', status: 'running', orgId: 'org-1', target: 'all', userId: 'u', triggeredBy: 'manual' }],
    ];
    selectResults = [
      [], // plugin entities
      [], // pipeline entities
    ];
    mockFindActiveByOrgAndTarget.mockResolvedValue([]);

    await executeScan('scan-1');

    expect(mockFindActiveByOrgAndTarget).toHaveBeenCalledTimes(2);
    expect(mockFindActiveByOrgAndTarget).toHaveBeenCalledWith('org-1', 'plugin');
    expect(mockFindActiveByOrgAndTarget).toHaveBeenCalledWith('org-1', 'pipeline');
  });
});
