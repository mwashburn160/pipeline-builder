// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * TemplateOnboarding readOnly gate: ComplianceDashboard renders the templates
 * tab for users without `compliance:write`. Apply must be disabled (with the
 * read-only reason as its tooltip) and must never reach the API, even with
 * templates selected.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import TemplateOnboarding, { APPLY_BLOCKED_REASON } from '../src/components/compliance/TemplateOnboarding';

const getRuleTemplates = jest.fn();
const applyRuleTemplates = jest.fn();
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
  applyRuleTemplates.mockResolvedValue({ success: true, data: { created: 1, skipped: 0 } });
});

async function selectTemplate() {
  fireEvent.click(await screen.findByRole('button', { name: /pin images/i }));
  return screen.findByRole('button', { name: /apply 1 template/i });
}

it('disables Apply with the blocked reason and never calls the API when readOnly', async () => {
  render(<TemplateOnboarding readOnly />);
  const apply = await selectTemplate();
  expect(apply).toBeDisabled();
  expect(apply).toHaveAttribute('title', APPLY_BLOCKED_REASON);
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
