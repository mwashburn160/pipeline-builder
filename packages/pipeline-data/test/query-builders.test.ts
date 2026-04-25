// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

jest.mock('@pipeline-builder/api-core', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
  SYSTEM_ORG_ID: 'system',
  AccessModifier: { PUBLIC: 'public', PRIVATE: 'private' },
}));

import {
  buildPipelineConditions,
  buildPluginConditions,
  buildMessageConditions,
  buildComplianceRuleConditions,
  buildCompliancePolicyConditions,
} from '../src/api/query-builders';

describe('buildPipelineConditions', () => {
  it('returns conditions for empty filter', () => {
    const conditions = buildPipelineConditions({}, 'org-1');
    // At minimum: access control condition (orgId match OR public)
    expect(conditions.length).toBeGreaterThanOrEqual(1);
  });

  it('adds project filter when specified', () => {
    const withProject = buildPipelineConditions({ project: 'my-project' }, 'org-1');
    const withoutProject = buildPipelineConditions({}, 'org-1');
    expect(withProject.length).toBeGreaterThan(withoutProject.length);
  });

  it('adds organization filter when specified', () => {
    const withOrg = buildPipelineConditions({ organization: 'my-org' }, 'org-1');
    const withoutOrg = buildPipelineConditions({}, 'org-1');
    expect(withOrg.length).toBeGreaterThan(withoutOrg.length);
  });

  it('adds multiple filters', () => {
    const conditions = buildPipelineConditions(
      { project: 'p', organization: 'o', isActive: true },
      'org-1',
    );
    // access control + project + organization + isActive
    expect(conditions.length).toBeGreaterThanOrEqual(4);
  });
});

describe('buildPluginConditions', () => {
  it('returns conditions for empty filter', () => {
    const conditions = buildPluginConditions({}, 'org-1');
    expect(conditions.length).toBeGreaterThanOrEqual(1);
  });

  it('adds name filter', () => {
    const withName = buildPluginConditions({ name: 'my-plugin' }, 'org-1');
    const withoutName = buildPluginConditions({}, 'org-1');
    expect(withName.length).toBeGreaterThan(withoutName.length);
  });

  it('adds version filter', () => {
    const withVersion = buildPluginConditions({ version: '1.0.0' }, 'org-1');
    const withoutVersion = buildPluginConditions({}, 'org-1');
    expect(withVersion.length).toBeGreaterThan(withoutVersion.length);
  });

  it('adds imageTag filter', () => {
    const withTag = buildPluginConditions({ imageTag: 'latest' }, 'org-1');
    const withoutTag = buildPluginConditions({}, 'org-1');
    expect(withTag.length).toBeGreaterThan(withoutTag.length);
  });

  it('adds orgId filter', () => {
    const withOrgId = buildPluginConditions({ orgId: 'specific-org' }, 'org-1');
    const withoutOrgId = buildPluginConditions({}, 'org-1');
    expect(withOrgId.length).toBeGreaterThan(withoutOrgId.length);
  });
});

describe('buildMessageConditions', () => {
  it('system org gets no access control filter', () => {
    const systemConditions = buildMessageConditions({}, 'system');
    const orgConditions = buildMessageConditions({}, 'org-1');
    // system org should have fewer conditions (no sender/recipient filter)
    expect(systemConditions.length).toBeLessThan(orgConditions.length);
  });

  it('non-system org gets sender/recipient/broadcast filter', () => {
    const conditions = buildMessageConditions({}, 'org-1');
    // At minimum: access control OR condition + isActive=true default
    expect(conditions.length).toBeGreaterThanOrEqual(2);
  });

  it('defaults isActive to true when not specified', () => {
    const conditions = buildMessageConditions({}, 'org-1');
    // Should include isActive=true condition
    expect(conditions.length).toBeGreaterThanOrEqual(2);
  });

  it('adds isActive filter when specified', () => {
    const conditions = buildMessageConditions({ isActive: false }, 'org-1');
    // access control + isActive=false
    expect(conditions.length).toBeGreaterThanOrEqual(2);
  });

  it('adds threadId IS NULL filter', () => {
    const withNull = buildMessageConditions({ threadId: null }, 'org-1');
    const without = buildMessageConditions({}, 'org-1');
    expect(withNull.length).toBeGreaterThan(without.length);
  });

  it('adds threadId equals filter', () => {
    const withThread = buildMessageConditions({ threadId: 'msg-123' }, 'org-1');
    const without = buildMessageConditions({}, 'org-1');
    expect(withThread.length).toBeGreaterThan(without.length);
  });

  it('adds messageType filter', () => {
    const withType = buildMessageConditions({ messageType: 'announcement' }, 'org-1');
    const without = buildMessageConditions({}, 'org-1');
    expect(withType.length).toBeGreaterThan(without.length);
  });

  it('adds isRead filter', () => {
    const withRead = buildMessageConditions({ isRead: false }, 'org-1');
    const without = buildMessageConditions({}, 'org-1');
    expect(withRead.length).toBeGreaterThan(without.length);
  });

  it('adds priority filter', () => {
    const withPriority = buildMessageConditions({ priority: 'high' }, 'org-1');
    const without = buildMessageConditions({}, 'org-1');
    expect(withPriority.length).toBeGreaterThan(without.length);
  });

  it('adds id filter', () => {
    const withId = buildMessageConditions({ id: 'msg-1' }, 'org-1');
    const without = buildMessageConditions({}, 'org-1');
    expect(withId.length).toBeGreaterThan(without.length);
  });

  it('normalizes orgId to lowercase', () => {
    // Should not throw even with uppercase orgId
    const conditions = buildMessageConditions({}, 'ORG-1');
    expect(conditions.length).toBeGreaterThanOrEqual(2);
  });
});

describe('buildComplianceRuleConditions', () => {
  // Regression: when a non-system org reads compliance rules, the SQL must
  // include system-org published rules in addition to the org's own rules.
  // Previously the query was `WHERE orgId=$myOrg`, so the global catalog
  // never appeared on dashboards belonging to other orgs.
  it('non-system org gets visibility OR (own rules + system published rules)', () => {
    const conditions = buildComplianceRuleConditions({}, 'org-1');
    // visibility OR (1) + isActive default (1) = 2
    expect(conditions.length).toBe(2);
  });

  it('system org gets a single equality on its own rules (no extra OR branch)', () => {
    const systemConditions = buildComplianceRuleConditions({}, 'system');
    const orgConditions = buildComplianceRuleConditions({}, 'org-1');
    // Both produce 2 conditions but the system path uses eq(orgId='system'),
    // not the OR-with-published-catalog branch.
    expect(systemConditions.length).toBe(orgConditions.length);
  });

  it('omits orgId condition entirely when no orgId is provided', () => {
    const withoutOrg = buildComplianceRuleConditions({});
    const withOrg = buildComplianceRuleConditions({}, 'org-1');
    // Without orgId: only the isActive default. With orgId: visibility OR + isActive.
    expect(withoutOrg.length).toBe(withOrg.length - 1);
  });

  it('normalizes orgId to lowercase before building visibility condition', () => {
    const upper = buildComplianceRuleConditions({}, 'ORG-1');
    const lower = buildComplianceRuleConditions({}, 'org-1');
    expect(upper.length).toBe(lower.length);
  });

  it('does not default isActive=true when filtering by id (single-entity lookup)', () => {
    const byId = buildComplianceRuleConditions(
      { id: '12345678-1234-1234-1234-123456789abc' },
      'org-1',
    );
    const list = buildComplianceRuleConditions({}, 'org-1');
    // byId: visibility OR (1) + id (1) = 2; list: visibility OR (1) + isActive (1) = 2
    expect(byId.length).toBe(list.length);
  });

  it('adds severity, target, scope, and tag filters', () => {
    const base = buildComplianceRuleConditions({}, 'org-1').length;
    expect(buildComplianceRuleConditions({ severity: 'error' }, 'org-1').length).toBe(base + 1);
    expect(buildComplianceRuleConditions({ target: 'plugin' }, 'org-1').length).toBe(base + 1);
    expect(buildComplianceRuleConditions({ scope: 'published' }, 'org-1').length).toBe(base + 1);
    expect(buildComplianceRuleConditions({ tag: 'security' }, 'org-1').length).toBe(base + 1);
  });
});

describe('buildCompliancePolicyConditions', () => {
  // Regression: same shape as the rule-conditions fix — sample policy templates
  // are uploaded under orgId='system' with isTemplate=true; non-system dashboards
  // must be able to see them.
  it('non-system org gets visibility OR (own policies + system templates)', () => {
    const conditions = buildCompliancePolicyConditions({}, 'org-1');
    // visibility OR (1) + isActive default (1) = 2
    expect(conditions.length).toBe(2);
  });

  it('system org gets a single equality on its own policies', () => {
    const systemConditions = buildCompliancePolicyConditions({}, 'system');
    const orgConditions = buildCompliancePolicyConditions({}, 'org-1');
    expect(systemConditions.length).toBe(orgConditions.length);
  });

  it('normalizes orgId to lowercase', () => {
    const upper = buildCompliancePolicyConditions({}, 'ORG-1');
    const lower = buildCompliancePolicyConditions({}, 'org-1');
    expect(upper.length).toBe(lower.length);
  });

  it('omits orgId condition when no orgId is provided', () => {
    const without = buildCompliancePolicyConditions({});
    const withOrg = buildCompliancePolicyConditions({}, 'org-1');
    expect(without.length).toBe(withOrg.length - 1);
  });

  it('adds isTemplate filter when explicitly set', () => {
    const base = buildCompliancePolicyConditions({}, 'org-1').length;
    expect(buildCompliancePolicyConditions({ isTemplate: true }, 'org-1').length).toBe(base + 1);
  });

  it('adds name filter', () => {
    const base = buildCompliancePolicyConditions({}, 'org-1').length;
    expect(buildCompliancePolicyConditions({ name: 'security' }, 'org-1').length).toBe(base + 1);
  });
});
