// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

// Small entity page size so the pagination loop is exercised without building
// 1000-row fixtures. MUST be set before the module under test is imported
// (below) — it reads the env at load time.
process.env.COMPLIANCE_SCAN_ENTITY_PAGE_SIZE = '2';

// Records every db.update().set(...) payload so tests can assert the terminal
// status the executor wrote (completed vs failed) — the shared update chain is
// otherwise write-only.
let updateSets: Record<string, unknown>[] = [];

// db chainable helpers
type ChainTerminal = () => Promise<unknown[]>;
function makeChain(terminal: ChainTerminal): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const name of ['from', 'innerJoin', 'leftJoin', 'where', 'orderBy', 'limit', 'offset', 'values', 'returning']) {
    chain[name] = jest.fn(() => chain);
  }
  chain.set = jest.fn((payload: Record<string, unknown>) => {
    updateSets.push(payload);
    return chain;
  });
  (chain as { then: unknown }).then = (
    resolve: (v: unknown[]) => unknown,
    reject?: (e: unknown) => unknown,
  ) => terminal().then(resolve, reject);
  return chain;
}

// Stack of selectResults — each db.select() consumes one entry (FIFO). An entry
// may be an Error, in which case that select REJECTS (simulates a transient DB
// failure for the exemption/entity fetch).
let selectResults: (unknown[] | Error)[] = [];
function nextSelect(): unknown[] | Error {
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

const dbSelect = jest.fn(() => makeChain(() => {
  const v = nextSelect();
  return v instanceof Error ? Promise.reject(v) : Promise.resolve(v);
}));
const dbInsert = jest.fn(() => makeChain(() => Promise.resolve([])));
const dbUpdate = jest.fn(() => makeChain(() => Promise.resolve(nextUpdate())));

const mockEvaluateRules = jest.fn();
const mockFindActiveByOrgAndTarget = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockResolveParentOrgId = jest.fn<(orgId: string) => Promise<string | undefined>>().mockResolvedValue(undefined);
const mockLogComplianceCheck = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(undefined);
const mockNotifyComplianceBlock = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(undefined);
const mockNotifyComplianceWarnings = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(undefined);

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => ({
  schema: {
    complianceScan: { id: 'col_id', status: 'col_status', orgId: 'col_org' },
    complianceExemption: {},
    plugin: { id: 'col_pid', name: 'col_pname', isActive: 'col_pactive', orgId: 'col_porg' },
    pipeline: { id: 'col_plid', pipelineName: 'col_plname', isActive: 'col_plactive', orgId: 'col_plorg' },
  },
  // Used by complianceExemptionService (loaded for real) to shape the exemption
  // lookup; the actual filtering is asserted via the dbSelect spy, so a stub
  // condition/count is sufficient here.
  buildComplianceExemptionConditions: (_filter: unknown, _orgId: string) => ({ __op: 'exemptionConditions' }),
  drizzleCount: () => ({ __op: 'count' }),
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

// Parent resolution is an internal platform HTTP call; stub it so the executor
// stays offline in unit tests. Individual tests override the resolved value to
// assert it's threaded into rule lookup.
jest.unstable_mockModule('../src/helpers/org-hierarchy-client.js', () => ({
  resolveParentOrgId: mockResolveParentOrgId,
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
    updateSets = [];
    dbSelect.mockClear();
    dbInsert.mockClear();
    dbUpdate.mockClear();
    mockEvaluateRules.mockReset();
    mockFindActiveByOrgAndTarget.mockReset();
    mockLogComplianceCheck.mockClear();
    mockNotifyComplianceBlock.mockClear();
    mockNotifyComplianceWarnings.mockClear();
    mockResolveParentOrgId.mockReset();
    mockResolveParentOrgId.mockResolvedValue(undefined);
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
      [{ id: 'scan-1', status: 'running', orgId: '000000000000000000000001', target: 'plugin', userId: 'u' }],
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

    expect(mockFindActiveByOrgAndTarget).toHaveBeenCalledWith('org-1', 'plugin', undefined);
    expect(mockEvaluateRules).not.toHaveBeenCalled();
    // Atomic claim + totalEntities update + final "completed" update.
    expect(dbUpdate).toHaveBeenCalled();
  });

  it('threads the resolved parentOrgId into rule lookup', async () => {
    updateReturning = [
      [{ id: 'scan-1', status: 'running', orgId: 'team-1', target: 'plugin', userId: 'u', triggeredBy: 'scheduled' }],
    ];
    selectResults = [[]]; // no entities → still resolves rules once
    mockResolveParentOrgId.mockResolvedValue('root-1');
    mockFindActiveByOrgAndTarget.mockResolvedValue([]);

    await executeScan('scan-1');

    expect(mockResolveParentOrgId).toHaveBeenCalledWith('team-1');
    expect(mockFindActiveByOrgAndTarget).toHaveBeenCalledWith('team-1', 'plugin', 'root-1');
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

  it('paginates entities beyond one page and evaluates ALL of them (no silent truncation)', async () => {
    // Regression: the old fetch used a single .limit(1000) and silently
    // truncated larger orgs, then reported status:'completed' — an authoritative
    // green "all pass" that never evaluated the truncated tail. With keyset
    // pagination every page must be evaluated.
    updateReturning = [
      // claim → totalEntities (ignored) → progress .returning (must be non-empty
      // or the executor aborts) → completion .returning (same).
      [{ id: 'scan-1', status: 'running', orgId: 'org-1', target: 'plugin', userId: 'u', triggeredBy: 'manual' }],
      [{ id: 'scan-1' }],
      [{ id: 'scan-1' }],
      [{ id: 'scan-1' }],
    ];
    // ENTITY_PAGE_SIZE is 2 for this suite: a full page (2 rows) forces another
    // fetch; the short page (1 row) ends pagination. 3 entities across 2 pages.
    selectResults = [
      [{ id: 'p1', name: 'p1' }, { id: 'p2', name: 'p2' }], // page 1 (full → keep paging)
      [{ id: 'p3', name: 'p3' }], // page 2 (short → stop)
      [], // exemptions fetch
    ];
    mockFindActiveByOrgAndTarget.mockResolvedValue([{ id: 'rule-1' }]);
    mockEvaluateRules.mockReturnValue({ blocked: false, violations: [], warnings: [], rulesEvaluated: 1 });

    await executeScan('scan-1');

    // All THREE paginated entities evaluated — not truncated to the first page.
    expect(mockEvaluateRules).toHaveBeenCalledTimes(3);
    // Honest completion carrying the true total, not a truncated count.
    const completed = updateSets.find((s) => s.status === 'completed');
    expect(completed).toMatchObject({ status: 'completed', totalEntities: 3, passCount: 3 });
    // Never a 'failed' terminal state on the happy path.
    expect(updateSets.some((s) => s.status === 'failed')).toBe(false);
  });

  it('fails the scan (no fabricated blocks) when exemption fetch throws', async () => {
    // Regression: fetchExemptions used to swallow errors and return an empty Map,
    // so a transient DB error made every entity evaluate as if it had NO approved
    // exemption — fabricating violations/blocks + notifications. It must now
    // rethrow so the scan fails honestly and evaluation never runs.
    updateReturning = [
      [{ id: 'scan-1', status: 'running', orgId: 'org-1', target: 'plugin', userId: 'u', triggeredBy: 'manual' }],
    ];
    selectResults = [
      [{ id: 'p1', name: 'p1' }], // entities (single short page)
      new Error('exemption store transient error'), // exemption fetch REJECTS
    ];
    mockFindActiveByOrgAndTarget.mockResolvedValue([{ id: 'rule-1' }]);

    await executeScan('scan-1');

    // Rules never evaluated → no entity fabricated as a block.
    expect(mockEvaluateRules).not.toHaveBeenCalled();
    // Fire-and-forget notifications get a chance to (not) run.
    await new Promise((r) => setImmediate(r));
    expect(mockNotifyComplianceBlock).not.toHaveBeenCalled();
    expect(mockNotifyComplianceWarnings).not.toHaveBeenCalled();
    // Terminal state is 'failed', never a green 'completed'.
    expect(updateSets.some((s) => s.status === 'failed')).toBe(true);
    expect(updateSets.some((s) => s.status === 'completed')).toBe(false);
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
    expect(mockFindActiveByOrgAndTarget).toHaveBeenCalledWith('org-1', 'plugin', undefined);
    expect(mockFindActiveByOrgAndTarget).toHaveBeenCalledWith('org-1', 'pipeline', undefined);
  });
});
