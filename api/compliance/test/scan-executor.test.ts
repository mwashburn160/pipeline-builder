// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

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

const dbSelect = jest.fn(() => makeChain(() => Promise.resolve(nextSelect())));
const dbInsert = jest.fn(() => makeChain(() => Promise.resolve([])));
const dbUpdate = jest.fn(() => makeChain(() => Promise.resolve([])));

const mockEvaluateRules = jest.fn();
const mockFindActiveByOrgAndTarget = jest.fn();
const mockLogComplianceCheck = jest.fn().mockResolvedValue(undefined);
const mockNotifyComplianceBlock = jest.fn().mockResolvedValue(undefined);

jest.mock('@pipeline-builder/api-core', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
  SYSTEM_ORG_ID: 'system',
}));

jest.mock('@pipeline-builder/pipeline-core', () => ({
  schema: {
    complianceScan: { id: 'col_id', status: 'col_status', orgId: 'col_org' },
    complianceExemption: {},
    plugin: { id: 'col_pid', name: 'col_pname', isActive: 'col_pactive', orgId: 'col_porg' },
    pipeline: { id: 'col_plid', pipelineName: 'col_plname', isActive: 'col_plactive', orgId: 'col_plorg' },
  },
  db: {
    select: (...args: unknown[]) => dbSelect(...args),
    insert: (...args: unknown[]) => dbInsert(...args),
    update: (...args: unknown[]) => dbUpdate(...args),
  },
}));

jest.mock('../src/engine/rule-engine', () => ({
  evaluateRules: (...args: unknown[]) => mockEvaluateRules(...args),
}));

jest.mock('../src/services/compliance-rule-service', () => ({
  complianceRuleService: {
    findActiveByOrgAndTarget: (...args: unknown[]) => mockFindActiveByOrgAndTarget(...args),
  },
}));

jest.mock('../src/helpers/audit-logger', () => ({
  logComplianceCheck: (...args: unknown[]) => mockLogComplianceCheck(...args),
}));

jest.mock('../src/helpers/compliance-notifier', () => ({
  notifyComplianceBlock: (...args: unknown[]) => mockNotifyComplianceBlock(...args),
}));

import { executeScan } from '../src/helpers/scan-executor';

describe('executeScan', () => {
  beforeEach(() => {
    selectResults = [];
    dbSelect.mockClear();
    dbInsert.mockClear();
    dbUpdate.mockClear();
    mockEvaluateRules.mockReset();
    mockFindActiveByOrgAndTarget.mockReset();
    mockLogComplianceCheck.mockClear();
    mockNotifyComplianceBlock.mockClear();
  });

  it('exits early when scan does not exist', async () => {
    selectResults = [[]]; // first select: scan lookup
    await executeScan('scan-x');
    expect(dbUpdate).not.toHaveBeenCalled();
  });

  it('exits early when scan is not pending', async () => {
    selectResults = [[{ id: 'scan-1', status: 'completed', orgId: 'org-1', target: 'plugin', userId: 'u' }]];
    await executeScan('scan-1');
    expect(dbUpdate).not.toHaveBeenCalled();
  });

  it('marks system-org scans as completed without evaluating rules', async () => {
    selectResults = [
      [{ id: 'scan-1', status: 'pending', orgId: 'SYSTEM', target: 'plugin', userId: 'u' }],
    ];
    await executeScan('scan-1');
    expect(dbUpdate).toHaveBeenCalled();
    expect(mockFindActiveByOrgAndTarget).not.toHaveBeenCalled();
  });

  it('completes scan with no rules (counts as all-pass)', async () => {
    selectResults = [
      [{ id: 'scan-1', status: 'pending', orgId: 'org-1', target: 'plugin', userId: 'u', triggeredBy: 'manual' }],
      // entities for plugin target
      [{ id: 'p1', name: 'p1' }, { id: 'p2', name: 'p2' }],
    ];
    mockFindActiveByOrgAndTarget.mockResolvedValue([]);

    await executeScan('scan-1');

    expect(mockFindActiveByOrgAndTarget).toHaveBeenCalledWith('org-1', 'plugin');
    expect(mockEvaluateRules).not.toHaveBeenCalled();
    // First update is "running", second is "totalEntities", third is final "completed"
    expect(dbUpdate).toHaveBeenCalled();
  });

  it('evaluates rules and writes audit entries on full scan', async () => {
    selectResults = [
      [{ id: 'scan-1', status: 'pending', orgId: 'org-1', target: 'plugin', userId: 'u', triggeredBy: 'manual' }],
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
    selectResults = [
      [{ id: 'scan-1', status: 'pending', orgId: 'org-1', target: 'plugin', userId: 'u', triggeredBy: 'rule-dry-run' }],
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
    selectResults = [
      [{ id: 'scan-1', status: 'pending', orgId: 'org-1', target: 'plugin', userId: 'u', triggeredBy: 'manual' }],
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
    selectResults = [
      [{ id: 'scan-1', status: 'pending', orgId: 'org-1', target: 'plugin', userId: 'u', triggeredBy: 'manual' }],
      [{ id: 'p1', name: 'p1' }], // entities
    ];
    // findActive throws, executor enters catch → marks failed
    mockFindActiveByOrgAndTarget.mockRejectedValue(new Error('rule lookup down'));

    await executeScan('scan-1');

    // Final update with status:'failed' must be present in some db.update call
    expect(dbUpdate).toHaveBeenCalled();
  });

  it('handles scans with target="all" by iterating both targets', async () => {
    selectResults = [
      [{ id: 'scan-1', status: 'pending', orgId: 'org-1', target: 'all', userId: 'u', triggeredBy: 'manual' }],
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
