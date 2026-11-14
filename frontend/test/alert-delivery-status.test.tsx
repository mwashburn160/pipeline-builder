// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The per-destination delivery line on the Alert destinations page: never
 * attempted, last delivered, or failing N in a row with the error class.
 */
import { describe, it, expect } from '@jest/globals';
import { render, screen } from '@testing-library/react';
import { AlertDeliveryStatus } from '../src/components/observability/AlertDeliveryStatus';
import type { AlertDestinationDelivery } from '../src/types/observability';

const base: AlertDestinationDelivery = {
  lastAttemptAt: '2026-11-13T10:00:00Z', lastOk: true, lastErrorKind: null,
  lastSuccessAt: '2026-11-13T10:00:00Z', lastFailureAt: null, consecutiveFailures: 0,
};

describe('AlertDeliveryStatus', () => {
  it('says never attempted when there is no status (null or absent)', () => {
    const { rerender } = render(<AlertDeliveryStatus delivery={null} />);
    expect(screen.getByText('Never attempted')).toBeInTheDocument();
    rerender(<AlertDeliveryStatus delivery={undefined} />);
    expect(screen.getByText('Never attempted')).toBeInTheDocument();
  });

  it('a healthy destination shows when it last delivered', () => {
    render(<AlertDeliveryStatus delivery={base} />);
    expect(screen.getByTestId('alert-delivery-ok')).toHaveTextContent(/^Last delivered/);
  });

  it('falls back to the attempt time when lastSuccessAt is missing', () => {
    render(<AlertDeliveryStatus delivery={{ ...base, lastSuccessAt: null }} />);
    expect(screen.getByTestId('alert-delivery-ok').textContent).not.toContain('—');
  });

  it('a failing destination names the streak and the error class, and when it last worked', () => {
    render(<AlertDeliveryStatus delivery={{ ...base, lastOk: false, lastErrorKind: 'rejected', consecutiveFailures: 4 }} />);
    const line = screen.getByTestId('alert-delivery-failing');
    expect(line).toHaveTextContent('Failing (4 in a row): rejected by the destination');
    expect(line).toHaveTextContent('last delivered');
  });

  it.each([
    ['timeout', 'timed out'],
    ['unreachable', 'unreachable'],
    ['unknown-channel', 'unknown channel'],
  ] as const)('labels %s', (kind, label) => {
    render(<AlertDeliveryStatus delivery={{ ...base, lastOk: false, lastErrorKind: kind, consecutiveFailures: 1 }} />);
    expect(screen.getByTestId('alert-delivery-failing')).toHaveTextContent(`Failing (1 in a row): ${label}`);
  });

  it('a failure with no class and no success ever says so', () => {
    render(<AlertDeliveryStatus delivery={{ ...base, lastOk: false, lastErrorKind: null, lastSuccessAt: null, consecutiveFailures: 2 }} />);
    const line = screen.getByTestId('alert-delivery-failing');
    expect(line).toHaveTextContent('Failing (2 in a row): failed');
    expect(line).toHaveTextContent('never delivered');
  });
});
