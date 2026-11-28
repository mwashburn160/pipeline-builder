// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Help content that scrolls sideways — data tables and code blocks — can be
 * reached and scrolled from the keyboard (axe scrollable-region-focusable,
 * WCAG 2.1.1): each scroller is a named, focusable region. And the code block
 * is drawn with the surface tokens, so its Copy button keeps its contrast
 * (it was the outline button's muted grey on a hard-coded near-black, 2.34:1).
 */

import { describe, it, expect } from '@jest/globals';
import { render, screen } from '@testing-library/react';
import { HelpCodeBlock } from '../src/components/help/HelpCodeBlock';
import { HelpTable } from '../src/components/help/HelpTable';
import { CodeBlock } from '../src/components/ui/CodeBlock';

describe('help scroll regions', () => {
  it('a help code block scrolls in a focusable, named region, on token surfaces', () => {
    const { container } = render(<HelpCodeBlock content="npm i -g @pipeline-builder/cli" language="bash" />);
    const region = screen.getByRole('region', { name: 'bash code' });
    expect(region.tagName).toBe('PRE');
    expect(region).toHaveAttribute('tabindex', '0');
    expect(container.innerHTML).not.toMatch(/\b(?:bg|text|border)-gray-\d/);
  });

  it('a help table scrolls in a focusable region named for its columns', () => {
    render(<HelpTable headers={['Variable', 'Default']} rows={[['PORT', '3000']]} />);
    const region = screen.getByRole('region', { name: 'Table: Variable, Default' });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(region).toContainElement(screen.getByRole('table'));
  });

  it('the shared code block does the same', () => {
    render(<CodeBlock code="curl https://example.test" language="http" />);
    expect(screen.getByRole('region', { name: 'http code' })).toHaveAttribute('tabindex', '0');
  });
});
