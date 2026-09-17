// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The visibility table cell names every rung. It used to test only
 * `=== 'public'`, so an `org` row read "Private" — telling the user a row the
 * whole organization can see was theirs alone.
 */

import { render } from '@testing-library/react';
import { AccessCell } from '../src/components/ui/AccessCell';
import { VISIBILITY_RUNGS } from '../src/components/ui/visibility-rungs';

describe('AccessCell', () => {
  it.each([
    ['private', 'Private'],
    ['org', 'Org'],
    ['public', 'Public'],
  ])('renders the %s rung as "%s"', (visibility, label) => {
    const { container } = render(<AccessCell visibility={visibility} />);
    expect(container).toHaveTextContent(new RegExp(`^${label}$`));
  });

  it('draws the three rungs distinctly (label and icon)', () => {
    const rendered = VISIBILITY_RUNGS.map((r) => render(<AccessCell visibility={r.value} />).container.innerHTML);
    expect(new Set(rendered).size).toBe(3);
    const icons = VISIBILITY_RUNGS.map((r) => render(<AccessCell visibility={r.value} />).container.querySelector('svg')?.getAttribute('class'));
    expect(icons.every(Boolean)).toBe(true);
    expect(new Set(icons).size).toBe(3);
  });
});
