// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

const mockFindActiveByOrgAndTarget = jest.fn();
const mockEvaluateRules = jest.fn();
const mockLogComplianceCheck = jest.fn().mockResolvedValue(undefined);

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
  schema: {},
  db: {},
}));

jest.mock('../src/services/compliance-rule-service', () => ({
  complianceRuleService: {
    findActiveByOrgAndTarget: (...args: unknown[]) => mockFindActiveByOrgAndTarget(...args),
  },
}));

jest.mock('../src/engine/rule-engine', () => ({
  evaluateRules: (...args: unknown[]) => mockEvaluateRules(...args),
}));

jest.mock('../src/helpers/audit-logger', () => ({
  logComplianceCheck: (...args: unknown[]) => mockLogComplianceCheck(...args),
}));

import { evaluateEntityEvent } from '../src/helpers/entity-event-handler';

describe('evaluateEntityEvent', () => {
  beforeEach(() => {
    mockFindActiveByOrgAndTarget.mockReset();
    mockEvaluateRules.mockReset();
    mockLogComplianceCheck.mockClear();
    mockEvaluateRules.mockReturnValue({
      blocked: false,
      violations: [],
      warnings: [],
      rulesEvaluated: 0,
    });
  });

  it('returns evaluated:false for unknown target', async () => {
    const result = await evaluateEntityEvent({
      entityId: 'e1',
      orgId: 'org-1',
      target: 'user',
      eventType: 'created',
    });
    expect(result).toEqual({ evaluated: false, reason: 'non-compliance target' });
    expect(mockFindActiveByOrgAndTarget).not.toHaveBeenCalled();
  });

  it('returns evaluated:false when no active rules', async () => {
    mockFindActiveByOrgAndTarget.mockResolvedValue([]);

    const result = await evaluateEntityEvent({
      entityId: 'e1',
      orgId: 'org-1',
      target: 'plugin',
      eventType: 'created',
    });

    expect(result).toEqual({ evaluated: false, reason: 'no active rules' });
    expect(mockEvaluateRules).not.toHaveBeenCalled();
  });

  it('evaluates rules for plugin target', async () => {
    mockFindActiveByOrgAndTarget.mockResolvedValue([{ id: 'r1' }]);
    mockEvaluateRules.mockReturnValue({
      blocked: false,
      violations: [],
      warnings: [],
      rulesEvaluated: 1,
    });

    const result = await evaluateEntityEvent({
      entityId: 'e1',
      orgId: 'org-1',
      target: 'plugin',
      eventType: 'updated',
      attributes: { name: 'p' },
    });

    expect(mockFindActiveByOrgAndTarget).toHaveBeenCalledWith('org-1', 'plugin');
    expect(mockEvaluateRules).toHaveBeenCalledWith([{ id: 'r1' }], { name: 'p' }, []);
    expect(result.evaluated).toBe(true);
    expect(result.blocked).toBe(false);
    expect(result.violations).toBe(0);
    expect(result.warnings).toBe(0);
  });

  it('returns blocked=true with violation count', async () => {
    mockFindActiveByOrgAndTarget.mockResolvedValue([{ id: 'r1' }]);
    mockEvaluateRules.mockReturnValue({
      blocked: true,
      violations: [{ ruleId: 'r1' }, { ruleId: 'r2' }],
      warnings: [{ ruleId: 'r3' }],
      rulesEvaluated: 3,
    });

    const result = await evaluateEntityEvent({
      entityId: 'e1',
      orgId: 'org-1',
      target: 'pipeline',
      eventType: 'created',
      attributes: {},
    });

    expect(result.evaluated).toBe(true);
    expect(result.blocked).toBe(true);
    expect(result.violations).toBe(2);
    expect(result.warnings).toBe(1);
  });

  it('uses empty object when attributes missing', async () => {
    mockFindActiveByOrgAndTarget.mockResolvedValue([{ id: 'r1' }]);

    await evaluateEntityEvent({
      entityId: 'e1',
      orgId: 'org-1',
      target: 'plugin',
      eventType: 'deleted',
    });

    expect(mockEvaluateRules).toHaveBeenCalledWith([{ id: 'r1' }], {}, []);
  });

  it('returns evaluated:false when service throws', async () => {
    mockFindActiveByOrgAndTarget.mockRejectedValue(new Error('boom'));

    const result = await evaluateEntityEvent({
      entityId: 'e1',
      orgId: 'org-1',
      target: 'plugin',
      eventType: 'created',
    });

    expect(result).toEqual({ evaluated: false, reason: 'evaluation error' });
  });

  it('writes an audit entry for evaluated events', async () => {
    mockFindActiveByOrgAndTarget.mockResolvedValue([{ id: 'r1' }]);
    mockEvaluateRules.mockReturnValue({
      blocked: false,
      violations: [],
      warnings: [],
      rulesEvaluated: 1,
    });

    await evaluateEntityEvent({
      entityId: 'e1',
      orgId: 'org-1',
      target: 'plugin',
      eventType: 'created',
      userId: 'user-x',
    });

    // Audit logger is fire-and-forget — give the microtask queue a tick
    await new Promise((r) => setImmediate(r));
    expect(mockLogComplianceCheck).toHaveBeenCalled();
    const args = mockLogComplianceCheck.mock.calls[0];
    expect(args[0]).toBe('org-1');
    expect(args[1]).toBe('user-x');
    expect(args[2]).toBe('plugin');
    expect(args[3]).toBe('created');
    expect(args[4]).toBe('e1');
  });

  it('defaults userId to "system" when missing', async () => {
    mockFindActiveByOrgAndTarget.mockResolvedValue([{ id: 'r1' }]);
    mockEvaluateRules.mockReturnValue({
      blocked: false, violations: [], warnings: [], rulesEvaluated: 1,
    });

    await evaluateEntityEvent({
      entityId: 'e1',
      orgId: 'org-1',
      target: 'pipeline',
      eventType: 'updated',
    });

    await new Promise((r) => setImmediate(r));
    expect(mockLogComplianceCheck.mock.calls[0][1]).toBe('system');
  });
});
