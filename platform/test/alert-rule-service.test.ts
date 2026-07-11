// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 *  Unit tests for the alert rule validator + materializer.
 * CRUD methods are exercised indirectly via the platform e2e suite; this
 * file focuses on the load-bearing pure logic (tenancy gate + YAML render).
 */

import { jest, describe, it, expect } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => ({
  schema: { orgAlertRule: {} },
  withTenantTx: jest.fn(),
  runWithTenantContext: jest.fn(),
}));

const { renderRulesYaml, validateRule } = await import('../src/services/alert-rule-service.js');


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

  it('accepts a regex org_id selector', () => {
    expect(validateRule('org-acme', {
      name: 'HighErrors',
      expr: 'sum(rate(http_requests_total{org_id=~"org-acme",status_code=~"5.."}[5m])) > 5',
      summary: 'errors high',
    })).toEqual({ ok: true });
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
    summary: 'Error rate is {{ $value }} for org-acme',
    description: 'See runbook',
    enabled: true,
    deletedAt: null,
    deletedBy: null,
  };

  it('renders an empty groups list when there are no rules', () => {
    const yaml = renderRulesYaml([]);
    expect(yaml).toContain('groups: []');
  });

  it('renders a single rule with org_id label and severity', () => {
    const yaml = renderRulesYaml([baseRule]);
    expect(yaml).toContain('alert: OrgRule_org_acme_HighErrors');
    expect(yaml).toContain('for: 5m');
    expect(yaml).toContain('severity: warning');
    expect(yaml).toContain("org_id: 'org-acme'");
    expect(yaml).toContain('tenancy: org');
    expect(yaml).toContain("summary: 'Error rate is {{ $value }} for org-acme'");
    expect(yaml).toContain("description: 'See runbook'");
  });

  it('sanitizes alert names so two orgs with the same rule name do not collide', () => {
    const a = { ...baseRule, orgId: 'org-acme', name: 'Same' };
    const b = { ...baseRule, orgId: 'org-other', name: 'Same' };
    const yaml = renderRulesYaml([a, b]);
    expect(yaml).toContain('OrgRule_org_acme_Same');
    expect(yaml).toContain('OrgRule_org_other_Same');
  });

  it('escapes single quotes in summary / description (YAML quoting)', () => {
    const yaml = renderRulesYaml([{
      ...baseRule, summary: "it's broken", description: "don't panic",
    }]);
    expect(yaml).toContain("summary: 'it''s broken'");
    expect(yaml).toContain("description: 'don''t panic'");
  });

  it('omits the description field when empty', () => {
    const yaml = renderRulesYaml([{ ...baseRule, description: '' }]);
    expect(yaml).not.toContain('description:');
  });

  it('renders multi-line expr as a YAML literal block', () => {
    const yaml = renderRulesYaml([{
      ...baseRule,
      expr: 'sum(rate(http_requests_total{org_id="org-acme"}[5m]))\n / 60',
    }]);
    expect(yaml).toContain('expr: |');
    expect(yaml).toContain(' sum(rate(http_requests_total{org_id="org-acme"}[5m]))');
    expect(yaml).toContain(' / 60');
  });
});
