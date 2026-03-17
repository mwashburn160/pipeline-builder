import { evaluateRules, type EvaluableRule, type ActiveExemption } from '../src/engine/rule-engine';

function makeRule(overrides: Partial<EvaluableRule> = {}): EvaluableRule {
  return {
    id: 'rule-1',
    name: 'test-rule',
    policyId: null,
    priority: 0,
    target: 'plugin',
    severity: 'error',
    scope: 'org',
    suppressNotification: false,
    field: 'name',
    operator: 'eq',
    value: 'expected',
    conditions: null,
    conditionMode: null,
    effectiveFrom: null,
    effectiveUntil: null,
    ...overrides,
  };
}

// ============================================
// Basic evaluation
// ============================================

describe('evaluateRules', () => {
  it('returns passed=true when no rules', () => {
    const result = evaluateRules([], { name: 'test' });
    expect(result.passed).toBe(true);
    expect(result.blocked).toBe(false);
    expect(result.rulesEvaluated).toBe(0);
  });

  it('returns passed=true when rule passes', () => {
    const rules = [makeRule({ field: 'name', operator: 'eq', value: 'test' })];
    const result = evaluateRules(rules, { name: 'test' });
    expect(result.passed).toBe(true);
    expect(result.blocked).toBe(false);
    expect(result.violations).toHaveLength(0);
    expect(result.rulesEvaluated).toBe(1);
  });

  it('returns blocked=true when error rule fails', () => {
    const rules = [makeRule({ field: 'name', operator: 'eq', value: 'expected', severity: 'error' })];
    const result = evaluateRules(rules, { name: 'actual' });
    expect(result.passed).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].ruleName).toBe('test-rule');
  });

  it('returns blocked=true for critical severity', () => {
    const rules = [makeRule({ severity: 'critical', field: 'x', operator: 'eq', value: 'y' })];
    const result = evaluateRules(rules, { x: 'z' });
    expect(result.blocked).toBe(true);
  });

  it('returns warning without blocking', () => {
    const rules = [makeRule({ severity: 'warning', field: 'x', operator: 'eq', value: 'y' })];
    const result = evaluateRules(rules, { x: 'z' });
    expect(result.blocked).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.violations).toHaveLength(0);
  });

  // ============================================
  // Priority ordering
  // ============================================

  it('evaluates higher priority rules first', () => {
    const rules = [
      makeRule({ id: 'low', name: 'low-pri', priority: 1, field: 'x', operator: 'eq', value: 'pass' }),
      makeRule({ id: 'high', name: 'high-pri', priority: 10, field: 'y', operator: 'eq', value: 'fail' }),
    ];
    const result = evaluateRules(rules, { x: 'pass', y: 'actual' });
    expect(result.violations[0].ruleName).toBe('high-pri');
  });

  // ============================================
  // Effective dates
  // ============================================

  it('skips rules not yet effective', () => {
    const future = new Date(Date.now() + 86400000); // tomorrow
    const rules = [makeRule({ effectiveFrom: future, field: 'x', operator: 'eq', value: 'y' })];
    const result = evaluateRules(rules, { x: 'z' });
    expect(result.blocked).toBe(false);
    expect(result.rulesSkipped).toBe(1);
    expect(result.rulesEvaluated).toBe(0);
  });

  it('skips expired rules', () => {
    const past = new Date(Date.now() - 86400000); // yesterday
    const rules = [makeRule({ effectiveUntil: past, field: 'x', operator: 'eq', value: 'y' })];
    const result = evaluateRules(rules, { x: 'z' });
    expect(result.blocked).toBe(false);
    expect(result.rulesSkipped).toBe(1);
  });

  it('evaluates rules within effective window', () => {
    const past = new Date(Date.now() - 86400000);
    const future = new Date(Date.now() + 86400000);
    const rules = [makeRule({ effectiveFrom: past, effectiveUntil: future, field: 'x', operator: 'eq', value: 'y' })];
    const result = evaluateRules(rules, { x: 'z' });
    expect(result.blocked).toBe(true);
    expect(result.rulesEvaluated).toBe(1);
  });

  // ============================================
  // Exemptions
  // ============================================

  it('skips exempt rules', () => {
    const rules = [makeRule({ id: 'rule-1', field: 'x', operator: 'eq', value: 'y' })];
    const exemptions: ActiveExemption[] = [{ id: 'exempt-1', ruleId: 'rule-1' }];
    const result = evaluateRules(rules, { x: 'z' }, exemptions);
    expect(result.blocked).toBe(false);
    expect(result.rulesSkipped).toBe(1);
    expect(result.exemptionsApplied).toContain('exempt-1');
  });

  it('does not exempt global rules', () => {
    const rules = [makeRule({ id: 'rule-1', scope: 'global', field: 'x', operator: 'eq', value: 'y' })];
    const exemptions: ActiveExemption[] = [{ id: 'exempt-1', ruleId: 'rule-1' }];
    const result = evaluateRules(rules, { x: 'z' }, exemptions);
    expect(result.blocked).toBe(true);
    expect(result.exemptionsApplied).toHaveLength(0);
  });

  // ============================================
  // Cross-field conditions
  // ============================================

  it('evaluates cross-field conditions (all mode)', () => {
    const rules = [makeRule({
      conditions: [
        { field: 'pluginType', operator: 'eq', value: 'CodeBuildStep' },
        { field: 'timeout', operator: 'lte', value: 900 },
      ],
      conditionMode: 'all',
    })];
    // Both conditions pass
    const result = evaluateRules(rules, { pluginType: 'CodeBuildStep', timeout: 500 });
    expect(result.blocked).toBe(false);
  });

  it('blocks when cross-field condition fails (all mode)', () => {
    const rules = [makeRule({
      conditions: [
        { field: 'pluginType', operator: 'eq', value: 'CodeBuildStep' },
        { field: 'timeout', operator: 'lte', value: 900 },
      ],
      conditionMode: 'all',
    })];
    // timeout condition fails
    const result = evaluateRules(rules, { pluginType: 'CodeBuildStep', timeout: 1200 });
    expect(result.blocked).toBe(true);
  });

  it('passes when any condition passes (any mode)', () => {
    const rules = [makeRule({
      conditions: [
        { field: 'pluginType', operator: 'eq', value: 'CodeBuildStep' },
        { field: 'pluginType', operator: 'eq', value: 'ShellStep' },
      ],
      conditionMode: 'any',
    })];
    const result = evaluateRules(rules, { pluginType: 'ShellStep' });
    expect(result.blocked).toBe(false);
  });

  // ============================================
  // Dependent rules
  // ============================================

  it('skips dependent rule when dependency failed', () => {
    const rules = [
      makeRule({ id: 'rule-a', name: 'rule-a', priority: 10, field: 'x', operator: 'eq', value: 'fail-this' }),
      makeRule({
        id: 'rule-b',
        name: 'rule-b',
        priority: 5,
        conditions: [
          { dependsOnRule: 'rule-a' },
          { field: 'y', operator: 'eq', value: 'something' },
        ],
      }),
    ];
    // rule-a fails (x != 'fail-this'), so rule-b should be skipped
    const result = evaluateRules(rules, { x: 'actual', y: 'other' });
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].ruleName).toBe('rule-a');
    expect(result.rulesSkipped).toBe(1); // rule-b skipped
  });

  it('evaluates dependent rule when dependency passed', () => {
    const rules = [
      makeRule({ id: 'rule-a', name: 'rule-a', priority: 10, field: 'x', operator: 'eq', value: 'match' }),
      makeRule({
        id: 'rule-b',
        name: 'rule-b',
        priority: 5,
        conditions: [
          { dependsOnRule: 'rule-a' },
          { field: 'y', operator: 'eq', value: 'expected' },
        ],
      }),
    ];
    // rule-a passes, rule-b should evaluate and fail
    const result = evaluateRules(rules, { x: 'match', y: 'wrong' });
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].ruleName).toBe('rule-b');
  });

  // ============================================
  // Multiple rules
  // ============================================

  it('collects violations from multiple failing rules', () => {
    const rules = [
      makeRule({ id: 'r1', name: 'rule-1', field: 'a', operator: 'eq', value: 'x' }),
      makeRule({ id: 'r2', name: 'rule-2', field: 'b', operator: 'eq', value: 'y' }),
    ];
    const result = evaluateRules(rules, { a: 'wrong', b: 'wrong' });
    expect(result.violations).toHaveLength(2);
    expect(result.blocked).toBe(true);
  });

  it('mixes violations and warnings', () => {
    const rules = [
      makeRule({ id: 'r1', name: 'error-rule', severity: 'error', field: 'a', operator: 'eq', value: 'x' }),
      makeRule({ id: 'r2', name: 'warn-rule', severity: 'warning', field: 'b', operator: 'eq', value: 'y' }),
    ];
    const result = evaluateRules(rules, { a: 'wrong', b: 'wrong' });
    expect(result.violations).toHaveLength(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.blocked).toBe(true);
  });

  // ============================================
  // Rules with no conditions
  // ============================================

  it('passes when rule has no field or conditions', () => {
    const rules = [makeRule({ field: null, operator: null, conditions: null })];
    const result = evaluateRules(rules, { anything: 'value' });
    expect(result.passed).toBe(true);
    expect(result.blocked).toBe(false);
  });
});
