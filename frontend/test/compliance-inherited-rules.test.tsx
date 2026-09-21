// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Parent-propagated compliance rules in a team: the enforced view badges them
 * "Inherited from {parent}" by NAME (never by raw org id), and RuleList keeps
 * the edit/activate/delete controls visible but DISABLED, with the reason as
 * on-screen text — the API refuses team-side mutations of a parent's rule with
 * a 403, and a row whose actions simply vanish looks like a bug.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen } from '@testing-library/react';
import EnforcedRulesView from '../src/components/compliance/EnforcedRulesView';
import RuleList from '../src/components/compliance/RuleList';
import type { ComplianceRule } from '../src/types/compliance';

jest.mock('@/components/RecentlyDeletedPanel', () => ({
  __esModule: true,
  RecentlyDeletedPanel: () => null,
}));

const getEnforcedRules = jest.fn<AnyFn>();
const getComplianceRules = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getEnforcedRules: (...a: unknown[]) => getEnforcedRules(...a),
    getComplianceRules: (...a: unknown[]) => getComplianceRules(...a),
    createComplianceRule: jest.fn<AnyFn>(),
    updateComplianceRule: jest.fn<AnyFn>(),
    deleteComplianceRule: jest.fn<AnyFn>(),
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

beforeEach(() => { jest.clearAllMocks(); });

describe('EnforcedRulesView', () => {
  it('badges an inherited rule with its source org name, and only that rule', async () => {
    getEnforcedRules.mockResolvedValue({ success: true, data: { rules: [own, inherited], total: 2 } });
    render(<EnforcedRulesView />);

    expect(await screen.findByText('Parent rule')).toBeInTheDocument();
    expect(screen.getAllByText('Inherited from Acme')).toHaveLength(1);
  });

  it('says "the parent organization" — never the raw id — when the name is unresolved', async () => {
    getEnforcedRules.mockResolvedValue({
      success: true,
      data: { rules: [{ ...inherited, sourceOrgName: undefined }], total: 1 },
    });
    render(<EnforcedRulesView />);

    expect(await screen.findByText('Inherited from the parent organization')).toBeInTheDocument();
    expect(screen.queryByText(/root-1/)).not.toBeInTheDocument();
  });
});

describe('RuleList', () => {
  it('disables — rather than hides — the mutation controls on an inherited rule', async () => {
    getComplianceRules.mockResolvedValue({
      success: true,
      data: { rules: [own, inherited], pagination: { total: 2, limit: 20, offset: 0 } },
    });
    render(<RuleList onEdit={jest.fn<AnyFn>()} />);

    expect(await screen.findByText('Parent rule')).toBeInTheDocument();
    expect(screen.getByText('Inherited from Acme')).toBeInTheDocument();

    // Both rows keep every control; only the inherited row's are disabled.
    for (const name of ['Edit rule', 'Delete rule'] as const) {
      const [ownBtn, inheritedBtn] = screen.getAllByRole('button', { name });
      expect(ownBtn).toBeEnabled();
      expect(inheritedBtn).toBeDisabled();
    }
    const toggles = screen.getAllByRole('button', { name: /(de)?activate rule/i });
    expect(toggles).toHaveLength(2);
    expect(toggles[1]).toBeDisabled();
  });

  it('states the reason in visible text, wired to the disabled controls', async () => {
    getComplianceRules.mockResolvedValue({
      success: true,
      data: { rules: [inherited], pagination: { total: 1, limit: 20, offset: 0 } },
    });
    render(<RuleList onEdit={jest.fn<AnyFn>()} />);

    // Not a `title` tooltip: real text in the row, referenced by the controls.
    const reason = await screen.findByText('Set by Acme and applied to every team — change it there.');
    expect(reason).toHaveAttribute('id', 'inherited-reason-inh');
    expect(screen.getByRole('button', { name: 'Edit rule' })).toHaveAttribute('aria-describedby', 'inherited-reason-inh');
  });
});
