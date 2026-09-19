// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Parent-propagated compliance rules in a team: the enforced view badges them
 * "Inherited from {parent}", and RuleList offers no edit/delete/toggle for them
 * (the API refuses team-side mutations of a parent's rule with a 403).
 */

import { render, screen } from '@testing-library/react';
import EnforcedRulesView from '../src/components/compliance/EnforcedRulesView';
import RuleList from '../src/components/compliance/RuleList';
import type { ComplianceRule } from '../src/types/compliance';

jest.mock('@/components/RecentlyDeletedPanel', () => ({
  __esModule: true,
  RecentlyDeletedPanel: () => null,
}));

const getEnforcedRules = jest.fn();
const getComplianceRules = jest.fn();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getEnforcedRules: (...a: unknown[]) => getEnforcedRules(...a),
    getComplianceRules: (...a: unknown[]) => getComplianceRules(...a),
    createComplianceRule: jest.fn(),
    updateComplianceRule: jest.fn(),
    deleteComplianceRule: jest.fn(),
  },
}));

const base = {
  priority: 0, target: 'plugin', severity: 'warning', tags: [], scope: 'org', suppressNotification: false,
  isActive: true, createdAt: '2026-01-01', updatedAt: '2026-01-01', createdBy: 'u1',
};
const own = { ...base, id: 'own', orgId: 'team-1', name: 'Team own rule' } as unknown as ComplianceRule;
const inherited = {
  ...base, id: 'inh', orgId: 'root-1', name: 'Parent rule',
  inherited: true, sourceOrgId: 'root-1', sourceOrgName: 'Acme',
} as unknown as ComplianceRule;

beforeEach(() => jest.clearAllMocks());

describe('EnforcedRulesView', () => {
  it('badges an inherited rule with its source org name, and only that rule', async () => {
    getEnforcedRules.mockResolvedValue({ success: true, data: { rules: [own, inherited], total: 2 } });
    render(<EnforcedRulesView />);

    expect(await screen.findByText('Parent rule')).toBeInTheDocument();
    expect(screen.getAllByText('Inherited from Acme')).toHaveLength(1);
  });

  it('falls back to the source org id when the name is unresolved', async () => {
    getEnforcedRules.mockResolvedValue({
      success: true,
      data: { rules: [{ ...inherited, sourceOrgName: undefined }], total: 1 },
    });
    render(<EnforcedRulesView />);

    expect(await screen.findByText('Inherited from root-1')).toBeInTheDocument();
  });
});

describe('RuleList', () => {
  it('offers no edit/delete/toggle for an inherited rule, but does for an owned one', async () => {
    getComplianceRules.mockResolvedValue({
      success: true,
      data: { rules: [own, inherited], pagination: { total: 2, limit: 20, offset: 0 } },
    });
    render(<RuleList onEdit={jest.fn()} />);

    expect(await screen.findByText('Parent rule')).toBeInTheDocument();
    expect(screen.getByText('Inherited from Acme')).toBeInTheDocument();
    // Exactly one of each mutation control — the owned rule's.
    expect(screen.getAllByRole('button', { name: 'Edit rule' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Delete rule' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /(de)?activate rule/i })).toHaveLength(1);
  });
});
