// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Clicking a histogram bar zooms to the lines that bar COUNTED. Loki's
 * `count_over_time([step])` stamped at T covers (T - step, T]; zooming to
 * [T, T + step] showed the NEXT bucket's lines instead.
 */

import { it, expect, jest } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent } from '@testing-library/react';
import { LogVolumeChart } from '../src/components/observability/LogVolumeChart';

it('zooms to [T - step, T]', () => {
  const onSelect = jest.fn<AnyFn>();
  render(
    <LogVolumeChart
      data={{ series: [{ labels: { level: 'error' }, values: [{ time: 1000, value: '3' }] }], step: '60s', window: { from: 0, to: 0, clamped: false } }}
      onSelectBucket={onSelect}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: /zoom to/i }));
  expect(onSelect).toHaveBeenCalledWith(1000 * 1000 - 60_000, 1000 * 1000);
});

it('says the volume failed rather than "no log volume"', () => {
  render(<LogVolumeChart error />);
  expect(screen.getByText(/could not be loaded/i)).toBeInTheDocument();
  expect(screen.queryByText(/no log volume/i)).not.toBeInTheDocument();
});
