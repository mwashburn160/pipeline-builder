// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 *  Unit tests for the alert rule validator + materializer.
 * CRUD methods are exercised indirectly via the platform e2e suite; this
 * file focuses on the load-bearing pure logic (tenancy gate + YAML render).
 */

import { jest, describe, it, expect } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  softDeleteRetentionMs: () => 0,
  schema: { orgAlertRule: {} },
  withTenantTx: jest.fn(),
  runWithTenantContext: jest.fn(),
}));

const { renderRulesYaml, validateRule } = await import('../src/services/alert-rule-service.js');
const { default: YAML } = await import('yaml');


describe('validateRule  tenancy gate', () => {
  it('rejects an expression missing the org_id matcher', () => {
    const result = validateRule('org-acme', {
      name: 'CrossTenantLeak',
      expr: 'sum(rate(http_requests_total[5m])) > 100',
      summary: 'fires on every org',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('org_id="org-acme"');
  });

  it('accepts an exact-match org_id selector', () => {
    expect(validateRule('org-acme', {
      name: 'HighErrors',
      expr: 'sum(rate(http_requests_total{org_id="org-acme",status_code=~"5.."}[5m])) > 5',
      summary: 'errors high',
    })).toEqual({ ok: true });
  });

  it('rejects a regex-only org_id selector (only the exact equality pins a rule)', () => {
    expect(validateRule('org-acme', {
      name: 'HighErrors',
      expr: 'sum(rate(http_requests_total{org_id=~"org-acme",status_code=~"5.."}[5m])) > 5',
      summary: 'errors high',
    }).ok).toBe(false);
  });

  it('rejects an expression that matches a DIFFERENT org_id (substring check is exact)', () => {
    const result = validateRule('org-acme', {
      name: 'CrossTenantAttempt',
      expr: 'sum(rate(http_requests_total{org_id="org-other"}[5m])) > 5',
      summary: 'wrong org',
    });
    expect(result.ok).toBe(false);
  });
});

describe('validateRule  field validation', () => {
  const valid = (overrides = {}) => ({
    name: 'ValidName',
    expr: 'foo{org_id="org-a"} > 1',
    summary: 'something',
    ...overrides,
  });

  it('rejects empty name', () => {
    expect(validateRule('org-a', valid({ name: ' ' }))).toEqual({ ok: false, message: 'name is required' });
  });

  it('rejects oversized name', () => {
    expect(validateRule('org-a', valid({ name: 'x'.repeat(101) }))).toEqual({
      ok: false, message: 'name must be <= 100 chars',
    });
  });

  it('rejects name with disallowed characters', () => {
    expect(validateRule('org-a', valid({ name: 'no/slashes' }))).toEqual({
      ok: false, message: expect.stringContaining('name may contain'),
    });
  });

  it('rejects malformed forDuration', () => {
    expect(validateRule('org-a', valid({ forDuration: '5 minutes' as never }))).toEqual({
      ok: false, message: expect.stringContaining('Prometheus duration syntax'),
    });
  });

  it('accepts compound Prom duration', () => {
    expect(validateRule('org-a', valid({ forDuration: '1h30m' }))).toEqual({ ok: true });
  });

  it('rejects unknown severity', () => {
    expect(validateRule('org-a', valid({ severity: 'page' as never }))).toEqual({
      ok: false, message: expect.stringContaining('severity must be'),
    });
  });
});

describe('validateRule  annotation template injection', () => {
  const valid = (overrides = {}) => ({
    name: 'ValidName',
    expr: 'foo{org_id="org-a"} > 1',
    summary: 'something',
    ...overrides,
  });

  it.each([
    '{{ query "sum(http_requests_total)" }}',
    'value {{ $value }}',
    'closing only }}',
    '{{',
  ])('rejects template syntax in summary: %s', (summary) => {
    const r = validateRule('org-a', valid({ summary }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/template syntax/);
  });

  it('rejects template syntax in description', () => {
    const r = validateRule('org-a', valid({ description: 'x {{ range query "up" }}{{ .Labels }}{{ end }}' }));
    expect(r.ok).toBe(false);
  });

  it('accepts plain braces that are not template delimiters', () => {
    expect(validateRule('org-a', valid({ summary: 'set {a} is empty', description: 'json: {"k": 1}' })))
      .toEqual({ ok: true });
  });

  it('rejects an oversized description', () => {
    expect(validateRule('org-a', valid({ description: 'x'.repeat(2001) }))).toEqual({
      ok: false, message: 'description must be <= 2000 chars',
    });
  });
});

describe('renderRulesYaml', () => {
  const baseRule = {
    id: 'r1',
    orgId: 'org-acme',
    createdBy: 'u',
    createdAt: new Date(0),
    updatedBy: 'u',
    updatedAt: new Date(0),
    name: 'HighErrors',
    expr: 'sum(rate(http_requests_total{org_id="org-acme",status_code=~"5.."}[5m])) > 5',
    forDuration: '5m',
    severity: 'warning' as const,
    summary: 'Error rate is high for org-acme',
    description: 'See runbook',
    enabled: true,
    deletedAt: null,
    deletedBy: null,
    purgeAfter: null,
  };

  const firstRule = (yaml: string) => (YAML.parse(yaml) as {
    groups: Array<{ name: string; rules: Array<Record<string, any>> }>;
  }).groups[0].rules[0];

  it('renders an empty groups list when there are no rules', () => {
    expect(YAML.parse(renderRulesYaml([]))).toEqual({ groups: [] });
  });

  it('renders valid YAML with the org_id label, severity and annotations', () => {
    const yaml = renderRulesYaml([baseRule]);
    const doc = YAML.parse(yaml);
    expect(doc.groups).toHaveLength(1);
    expect(doc.groups[0].name).toBe('org-authored');
    expect(firstRule(yaml)).toEqual({
      alert: 'OrgRule_org_acme_HighErrors',
      expr: baseRule.expr,
      for: '5m',
      labels: { severity: 'warning', component: 'org-authored', tenancy: 'org', org_id: 'org-acme' },
      annotations: { summary: 'Error rate is high for org-acme', description: 'See runbook' },
    });
  });

  it('sanitizes alert names so two orgs with the same rule name do not collide', () => {
    const a = { ...baseRule, orgId: 'org-acme', name: 'Same' };
    const b = { ...baseRule, orgId: 'org-other', name: 'Same' };
    const rules = YAML.parse(renderRulesYaml([a, b])).groups[0].rules;
    expect(rules.map((r: { alert: string }) => r.alert)).toEqual(['OrgRule_org_acme_Same', 'OrgRule_org_other_Same']);
  });

  it('round-trips quotes, colons and newlines in summary / description', () => {
    const rule = firstRule(renderRulesYaml([{
      ...baseRule, summary: "it's broken: \"really\"", description: "don't panic\n- key: value",
    }]));
    expect(rule.annotations).toEqual({ summary: "it's broken: \"really\"", description: "don't panic\n- key: value" });
  });

  it('omits the description field when empty', () => {
    const yaml = renderRulesYaml([{ ...baseRule, description: '' }]);
    expect(yaml).not.toContain('description:');
  });

  it('round-trips a multi-line expr', () => {
    const expr = 'sum(rate(http_requests_total{org_id="org-acme"}[5m]))\n / 60';
    expect(firstRule(renderRulesYaml([{ ...baseRule, expr }])).expr).toBe(expr);
  });

  it('neutralizes template delimiters that reach the renderer (literal text, no Go-template action)', () => {
    const rule = firstRule(renderRulesYaml([{ ...baseRule, summary: '{{ query "up" }}' }]));
    // Each delimiter becomes a raw-string action that prints the delimiter
    // itself, so Prometheus emits the text verbatim instead of running `query`.
    expect(rule.annotations.summary).toBe('{{`{{`}} query "up" {{`}}`}}');
  });
});
