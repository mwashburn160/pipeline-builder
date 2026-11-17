// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `checkExemptionRules` reads its rules through `findManyByIds`, which is
 * published-only by default (it runs under sysadmin scope). An exemption may
 * also name the org's OWN private rule, and must recognise its PARENT's
 * propagated rule to refuse it with a 403 — so the check asks for exactly those
 * two owners, and never for "any scope".
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const findManyByIds = jest.fn<(ids: string[], opts?: { alsoOwnedBy?: Array<string | undefined> }) => Promise<unknown[]>>(async () => []);
jest.unstable_mockModule('../src/services/compliance-rule-service.js', () => ({
  complianceRuleService: { findManyByIds: (...a: Parameters<typeof findManyByIds>) => findManyByIds(...a) },
}));

const { checkExemptionRules, INHERITED_RULE_EXEMPTION_MESSAGE } = await import('../src/helpers/exemption-rule-check.js');

const RULE = { id: 'r-1', orgId: 'org-a', scope: 'org', target: 'plugin', propagateToChildren: false };

beforeEach(() => { findManyByIds.mockReset(); findManyByIds.mockResolvedValue([]); });

describe('checkExemptionRules', () => {
  it('asks for published rules plus ONLY the caller org and its parent', async () => {
    await checkExemptionRules([{ ruleId: 'R-1', entityType: 'plugin' }], 'org-a', 'org-parent');
    expect(findManyByIds).toHaveBeenCalledWith(['r-1'], { alsoOwnedBy: ['org-a', 'org-parent'] });
  });

  it('accepts the org\'s own private rule', async () => {
    findManyByIds.mockResolvedValue([RULE]);
    expect(await checkExemptionRules([{ ruleId: 'r-1', entityType: 'plugin' }], 'org-a', undefined)).toBeNull();
  });

  it('refuses the parent\'s propagated rule with a 403', async () => {
    findManyByIds.mockResolvedValue([{ ...RULE, orgId: 'org-parent', propagateToChildren: true }]);
    expect(await checkExemptionRules([{ ruleId: 'r-1', entityType: 'plugin' }], 'org-a', 'org-parent'))
      .toEqual({ status: 403, message: INHERITED_RULE_EXEMPTION_MESSAGE });
  });

  it('treats a rule the lookup did not return (another tenant\'s private rule) as unknown', async () => {
    expect(await checkExemptionRules([{ ruleId: 'r-9', entityType: 'plugin' }], 'org-a', undefined))
      .toEqual({ status: 400, message: 'Unknown or inactive compliance rule: r-9' });
  });
});
