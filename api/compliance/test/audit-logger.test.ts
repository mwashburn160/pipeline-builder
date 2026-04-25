// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

const mockInsert = jest.fn();
const mockValues = jest.fn().mockResolvedValue(undefined);

jest.mock('@pipeline-builder/api-core', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

jest.mock('@pipeline-builder/pipeline-core', () => ({
  schema: {
    complianceAuditLog: { __table: 'complianceAuditLog' },
  },
  db: {
    insert: (...args: unknown[]) => {
      mockInsert(...args);
      return { values: mockValues };
    },
  },
}));

import { logComplianceCheck } from '../src/helpers/audit-logger';
import type { ValidationResult } from '../src/engine/rule-engine';

function makeResult(overrides: Partial<ValidationResult> = {}): ValidationResult {
  return {
    passed: true,
    blocked: false,
    violations: [],
    warnings: [],
    rulesEvaluated: 0,
    rulesSkipped: 0,
    exemptionsApplied: [],
    ...overrides,
  };
}

describe('logComplianceCheck', () => {
  beforeEach(() => {
    mockInsert.mockClear();
    mockValues.mockClear();
  });

  it('writes pass result when no violations or warnings', async () => {
    await logComplianceCheck('org-1', 'user-1', 'plugin', 'create', 'e1', 'entity-1', makeResult({ rulesEvaluated: 3 }));
    expect(mockInsert).toHaveBeenCalledTimes(1);
    const values = mockValues.mock.calls[0][0];
    expect(values.result).toBe('pass');
    expect(values.orgId).toBe('org-1');
    expect(values.userId).toBe('user-1');
    expect(values.target).toBe('plugin');
    expect(values.action).toBe('create');
    expect(values.entityId).toBe('e1');
    expect(values.entityName).toBe('entity-1');
    expect(values.ruleCount).toBe(3);
  });

  it('writes block result when blocked=true', async () => {
    await logComplianceCheck('org-1', 'user-1', 'pipeline', 'update', 'e1', 'p1', makeResult({
      blocked: true,
      violations: [{ ruleId: 'r1', ruleName: 'rn', message: 'm', severity: 'error' } as never],
    }));
    const values = mockValues.mock.calls[0][0];
    expect(values.result).toBe('block');
    expect(Array.isArray(values.violations)).toBe(true);
    expect(values.violations).toHaveLength(1);
  });

  it('writes warn result when warnings exist but not blocked', async () => {
    await logComplianceCheck('org-1', 'user-1', 'plugin', 'create', 'e1', 'n', makeResult({
      warnings: [{ ruleId: 'r1', ruleName: 'rn', message: 'w', severity: 'warning' } as never],
    }));
    const values = mockValues.mock.calls[0][0];
    expect(values.result).toBe('warn');
    expect(values.violations).toHaveLength(1);
  });

  it('handles undefined entityId/entityName as null', async () => {
    await logComplianceCheck('org-1', 'user-1', 'plugin', 'scan', undefined, undefined, makeResult());
    const values = mockValues.mock.calls[0][0];
    expect(values.entityId).toBeNull();
    expect(values.entityName).toBeNull();
  });

  it('passes scanId when provided', async () => {
    await logComplianceCheck('org-1', 'user-1', 'plugin', 'scan', 'e1', 'n', makeResult(), 'scan-123');
    const values = mockValues.mock.calls[0][0];
    expect(values.scanId).toBe('scan-123');
  });

  it('defaults scanId to null when omitted', async () => {
    await logComplianceCheck('org-1', 'user-1', 'plugin', 'scan', 'e1', 'n', makeResult());
    const values = mockValues.mock.calls[0][0];
    expect(values.scanId).toBeNull();
  });

  it('combines violations and warnings into single audit array', async () => {
    await logComplianceCheck('org-1', 'user-1', 'plugin', 'scan', 'e1', 'n', makeResult({
      blocked: true,
      violations: [{ ruleId: 'r1', ruleName: 'a', message: 'v', severity: 'error' } as never],
      warnings: [{ ruleId: 'r2', ruleName: 'b', message: 'w', severity: 'warning' } as never],
    }));
    const values = mockValues.mock.calls[0][0];
    expect(values.violations).toHaveLength(2);
  });
});
