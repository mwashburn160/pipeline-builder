// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { render, screen, fireEvent } from '@testing-library/react';
import { BreakglassModal, BREAKGLASS_JUSTIFICATION_MIN } from '../src/components/users/BreakglassModal';

describe('BreakglassModal', () => {
  const setup = () => {
    const onContinue = jest.fn();
    render(<BreakglassModal targetLabel="user@acme.com" onContinue={onContinue} onClose={jest.fn()} />);
    return { onContinue, box: screen.getByRole('textbox'), next: () => screen.getByRole('button', { name: 'Continue' }) };
  };

  it('says what emergency access costs before the operator commits', () => {
    setup();
    expect(screen.getByText(/shown to the organization/i)).toBeInTheDocument();
    expect(screen.getByText(/notified immediately/i)).toBeInTheDocument();
    expect(screen.getByText(/second platform administrator/i)).toBeInTheDocument();
  });

  it('will not continue without a real justification', () => {
    const { box, next } = setup();
    expect(next()).toBeDisabled();

    fireEvent.change(box, { target: { value: 'x'.repeat(BREAKGLASS_JUSTIFICATION_MIN - 1) } });
    expect(next()).toBeDisabled();

    // Whitespace padding doesn't count.
    fireEvent.change(box, { target: { value: `   ${'x'.repeat(BREAKGLASS_JUSTIFICATION_MIN - 1)}   ` } });
    expect(next()).toBeDisabled();
  });

  it('continues with the trimmed justification once it is long enough', () => {
    const { box, next, onContinue } = setup();
    const text = 'INC-1234: pipelines failing, need their dashboard';
    fireEvent.change(box, { target: { value: `  ${text}  ` } });

    fireEvent.click(next());
    expect(onContinue).toHaveBeenCalledWith(text);
  });
});
