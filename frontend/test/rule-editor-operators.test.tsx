// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The rule editor offers every operator the compliance service accepts. The
 * curated Advanced pack ships `notEmpty` rules; an editor that didn't know the
 * operator rendered them as "Equals" with a value box, so they couldn't be
 * authored or edited faithfully.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { render, screen } from '@testing-library/react';
import RuleEditor from '@/components/compliance/RuleEditor';
import type { ComplianceRule } from '@/types/compliance';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/lib/api', () => ({ __esModule: true, default: {} }));

const rule = (over: Partial<ComplianceRule>): ComplianceRule => ({
  id: 'r1', orgId: 'org-1', name: 'Has summary', priority: 0, target: 'plugin', severity: 'error',
  tags: [], scope: 'org', suppressNotification: false, isActive: true,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', createdBy: 'u1',
  ...over,
});

describe('RuleEditor operators', () => {
  it('shows a notEmpty rule as "Not empty" with no value input', () => {
    render(<RuleEditor rule={rule({ field: 'summary', operator: 'notEmpty' })} onSave={() => {}} onCancel={() => {}} />);
    const select = screen.getByLabelText('Operator') as HTMLSelectElement;
    expect(select.value).toBe('notEmpty');
    expect(select.selectedOptions[0]?.textContent).toBe('Not empty');
    expect(screen.queryByLabelText('Value (JSON)')).toBeNull();
  });

  it('keeps the value input for comparison operators', () => {
    render(<RuleEditor rule={rule({ field: 'name', operator: 'eq', value: 'x' })} onSave={() => {}} onCancel={() => {}} />);
    expect(screen.getByLabelText('Value (JSON)')).toBeTruthy();
  });
});
