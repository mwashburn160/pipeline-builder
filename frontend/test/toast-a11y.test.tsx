// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Toast accessibility: severity should drive the ARIA live-region politeness.
 * error/warning interrupt a screen reader (role="alert" + aria-live="assertive");
 * success/info are announced politely (role="status" + aria-live="polite") so
 * they don't cut off whatever the user is currently reading.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { ToastProvider, useToast } from '../src/components/ui/Toast';

function Harness() {
  const toast = useToast();
  return (
    <div>
      <button onClick={() => toast.success('saved ok')}>fire-success</button>
      <button onClick={() => toast.info('heads up')}>fire-info</button>
      <button onClick={() => toast.error('it broke')}>fire-error</button>
      <button onClick={() => toast.warning('careful')}>fire-warning</button>
    </div>
  );
}

function renderHarness() {
  return render(
    <ToastProvider>
      <Harness />
    </ToastProvider>,
  );
}

describe('Toast a11y live-region politeness', () => {
  it('announces success politely (role=status, aria-live=polite)', async () => {
    renderHarness();
    fireEvent.click(screen.getByText('fire-success'));
    const el = await screen.findByRole('status');
    expect(el).toHaveTextContent('saved ok');
    expect(el).toHaveAttribute('aria-live', 'polite');
  });

  it('announces info politely (role=status, aria-live=polite)', async () => {
    renderHarness();
    fireEvent.click(screen.getByText('fire-info'));
    const el = await screen.findByRole('status');
    expect(el).toHaveTextContent('heads up');
    expect(el).toHaveAttribute('aria-live', 'polite');
  });

  it('announces errors assertively (role=alert, aria-live=assertive)', async () => {
    renderHarness();
    fireEvent.click(screen.getByText('fire-error'));
    const el = await screen.findByRole('alert');
    expect(el).toHaveTextContent('it broke');
    expect(el).toHaveAttribute('aria-live', 'assertive');
  });

  it('announces warnings assertively (role=alert, aria-live=assertive)', async () => {
    renderHarness();
    fireEvent.click(screen.getByText('fire-warning'));
    const el = await screen.findByRole('alert');
    expect(el).toHaveTextContent('careful');
    expect(el).toHaveAttribute('aria-live', 'assertive');
  });
});
