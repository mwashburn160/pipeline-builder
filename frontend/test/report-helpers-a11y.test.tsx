// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Accessibility + retention-warning behaviour of the shared report widgets:
 *  - the date inputs are labelled (aria-label, not just a `title` tooltip),
 *  - the over-cap warning links to the add-on that widens the window,
 *  - the Plugin Versions default-status dot is not colour-only.
 */

import { describe, it, expect } from '@jest/globals';
import { render, screen } from '@testing-library/react';
import { DateRangePicker } from '../src/components/reports/ReportHelpers';
import { PluginVersions } from '../src/components/reports/PluginVersions';

const noop = () => {};

describe('DateRangePicker', () => {
  it('labels both date inputs for assistive tech', () => {
    render(<DateRangePicker from="2026-01-01" to="2026-01-10" onFromChange={noop} onToChange={noop} />);
    expect(screen.getByLabelText('From date')).toHaveAttribute('type', 'date');
    expect(screen.getByLabelText('To date')).toHaveAttribute('type', 'date');
  });

  it('warns past the cap and links to the retention add-on when one is given', () => {
    render(
      <DateRangePicker
        from="2026-01-01" to="2026-03-01" onFromChange={noop} onToChange={noop}
        maxRangeDays={30} extendHref="/dashboard/billing?highlight=retention_pack"
      />,
    );
    expect(screen.getByText(/>30d — will be capped/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /extend retention/i }))
      .toHaveAttribute('href', '/dashboard/billing?highlight=retention_pack');
  });

  it('does not warn within the cap', () => {
    render(<DateRangePicker from="2026-01-01" to="2026-01-20" onFromChange={noop} onToChange={noop} maxRangeDays={30} extendHref="/x" />);
    expect(screen.queryByText(/will be capped/)).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});

describe('PluginVersions default-status dot', () => {
  it('carries a text label for each state, not just a colour', () => {
    render(
      <PluginVersions
        loading={false}
        pluginVersions={[
          { name: 'alpha', version_count: 1, latest_version: '1.0.0', has_default: true },
          { name: 'beta', version_count: 1, latest_version: '0.1.0', has_default: false },
        ]}
      />,
    );
    expect(screen.getByText('Default set')).toHaveClass('sr-only');
    expect(screen.getByText('No default set')).toHaveClass('sr-only');
  });
});
