// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The visibility table cell names every rung. It used to test only
 * `=== 'public'`, so an `org` row read "Private" — telling the user a row the
 * whole organization can see was theirs alone.
 */

import { describe, it, expect } from '@jest/globals';
import { render } from '@testing-library/react';
import { AccessCell } from '../src/components/ui/AccessCell';
import { VISIBILITY_RUNGS } from '../src/components/ui/visibility-rungs';
import { visibilityHint, ECOSYSTEM_VISIBILITY_NOTE } from '../src/components/ui/VisibilitySelect';

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

describe('visibilityHint — the plugin directory is NOT on this ladder', () => {
  // Plugins are the one resource with a second, external "public": the
  // directory at /plugins. Every rung here stays inside the org hierarchy, so
  // "Public — shared with your org & its teams" reads as the way to publish
  // there when it is not. The note names the two flows that actually do.
  it('adds the directory note only when asked (plugins), for both permission states', () => {
    for (const canPublish of [true, false]) {
      expect(visibilityHint(canPublish, 'plugins:publish', true)).toContain(ECOSYSTEM_VISIBILITY_NOTE.trim());
      expect(visibilityHint(canPublish, 'pipelines:publish')).not.toContain('plugin directory');
    }
  });

  it('names both routes into the directory, so neither is a dead end', () => {
    expect(ECOSYSTEM_VISIBILITY_NOTE).toContain('/marketplace/register');
    expect(ECOSYSTEM_VISIBILITY_NOTE).toContain('/plugins/submit');
    expect(ECOSYSTEM_VISIBILITY_NOTE).toContain('community');
  });
});
