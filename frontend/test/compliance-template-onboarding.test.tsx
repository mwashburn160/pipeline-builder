// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * TemplateOnboarding readOnly gate: ComplianceDashboard renders the templates
 * tab for users without `compliance:write`. Apply must be disabled (with the
 * read-only reason as its tooltip) and must never reach the API, even with
 * templates selected.
 */

import { it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import TemplateOnboarding, { APPLY_BLOCKED_REASON } from '../src/components/compliance/TemplateOnboarding';

const getRuleTemplates = jest.fn<AnyFn>();
const applyRuleTemplates = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getRuleTemplates: (...a: unknown[]) => getRuleTemplates(...a),
    applyRuleTemplates: (...a: unknown[]) => applyRuleTemplates(...a),
  },
}));

beforeEach(() => {
  jest.clearAllMocks();
  getRuleTemplates.mockResolvedValue({
    success: true,
    data: { templates: [{ id: 't1', name: 'Pin images', description: 'd', category: 'security', target: 'plugin', severity: 'error' }] },
  });
  applyRuleTemplates.mockResolvedValue({ success: true, data: { created: 1, skipped: [], ruleIds: ['r1'] } });
});

async function selectTemplate() {
  fireEvent.click(await screen.findByRole('button', { name: /pin images/i }));
  return screen.findByRole('button', { name: /apply 1 template/i });
}

it('disables Apply with the blocked reason and never calls the API when readOnly', async () => {
  render(<TemplateOnboarding readOnly />);
  const apply = await selectTemplate();
  expect(apply).toHaveAttribute('aria-disabled', 'true');
  expect(apply).toHaveAccessibleDescription(APPLY_BLOCKED_REASON);
  fireEvent.click(apply);
  expect(applyRuleTemplates).not.toHaveBeenCalled();
});

it('applies selected templates when writable', async () => {
  render(<TemplateOnboarding />);
  const apply = await selectTemplate();
  await waitFor(() => expect(apply).toBeEnabled());
  fireEvent.click(apply);
  expect(await screen.findByText('Templates applied')).toBeInTheDocument();
  expect(applyRuleTemplates).toHaveBeenCalledWith(['t1']);
});

it('lists the templates the server could not create, with its reason', async () => {
  applyRuleTemplates.mockResolvedValue({ success: true, data: { created: 0, skipped: [{ id: 't1', reason: 'A rule named "Pin images" already exists' }], ruleIds: [] } });
  render(<TemplateOnboarding />);
  const apply = await selectTemplate();
  await waitFor(() => expect(apply).toBeEnabled());
  fireEvent.click(apply);
  expect(await screen.findByText(/1 not created/)).toBeInTheDocument();
  expect(screen.getByText('Pin images: A rule named "Pin images" already exists')).toBeInTheDocument();
});

it('shows the server message when applying fails', async () => {
  applyRuleTemplates.mockRejectedValue(new Error('Quota exceeded for rules'));
  render(<TemplateOnboarding />);
  const apply = await selectTemplate();
  await waitFor(() => expect(apply).toBeEnabled());
  fireEvent.click(apply);
  expect(await screen.findByText('Quota exceeded for rules')).toBeInTheDocument();
});
