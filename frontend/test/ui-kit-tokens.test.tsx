// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The UI kit is where a raw Tailwind palette class costs the most: every
 * consumer inherits it, and a light/dark class PAIR silently skips whatever
 * theme it forgot. These pin the kit's status surfaces onto the `--pb-*`
 * tokens, which re-resolve per theme from one place.
 *
 * `purple` / `indigo` (Badge, IconButton) and the categorical palettes stay raw
 * on purpose — the token set is brand plus success/warning/danger/info, and
 * there is nothing to point them at.
 */

import { describe, it, expect } from '@jest/globals';
import { render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Badge } from '../src/components/ui/Badge';
import { IconButton } from '../src/components/ui/IconButton';
import { PostureHeadline } from '../src/components/ui/PostureHeadline';
import { FilterBar } from '../src/components/ui/FilterBar';
import { Shield } from 'lucide-react';

const read = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8');

/** Any `bg-/text-/border-` class naming a Tailwind palette ramp that HAS a
 *  token equivalent — `purple`/`indigo` are deliberately absent (see above). */
const RAW_PALETTE = /\b(?:bg|text|border|ring|divide|placeholder)-(?:gray|slate|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|violet|fuchsia|pink|rose)-\d/;

describe('Badge', () => {
  it.each([
    ['green', 'bg-success-bg'],
    ['red', 'bg-danger-bg'],
    ['yellow', 'bg-warning-bg'],
    ['blue', 'bg-info-bg'],
    ['gray', 'bg-surface-muted'],
  ] as const)('%s rides the token, not a light/dark palette pair', (color, token) => {
    const { container } = render(<Badge color={color}>x</Badge>);
    const cls = container.firstElementChild!.className;
    expect(cls).toContain(token);
    expect(cls).not.toMatch(/dark:/);
  });

  it('keeps purple and indigo on the raw palette (no token exists)', () => {
    expect(render(<Badge color="purple">x</Badge>).container.firstElementChild!.className).toMatch(/purple-\d/);
    expect(render(<Badge color="indigo">x</Badge>).container.firstElementChild!.className).toMatch(/indigo-\d/);
  });
});

describe('IconButton', () => {
  it.each([
    ['primary', 'text-info'],
    ['danger', 'text-danger'],
    ['warn', 'text-warning'],
    ['success', 'text-success'],
  ] as const)('restTone=%s uses the status token', (tone, token) => {
    const { container } = render(
      <IconButton restTone={tone} aria-label="act"><Shield /></IconButton>,
    );
    expect(container.querySelector('button')!.className).toContain(token);
  });

  it('focuses with the brand ring token, not ring-blue-500', () => {
    const { container } = render(<IconButton aria-label="act"><Shield /></IconButton>);
    const cls = container.querySelector('button')!.className;
    expect(cls).toContain('focus-visible:ring-brand');
    expect(cls).not.toContain('ring-blue-500');
  });
});

describe('PostureHeadline', () => {
  it.each([
    ['red', 'bg-danger-bg'],
    ['yellow', 'bg-warning-bg'],
    ['green', 'bg-success-bg'],
    ['gray', 'bg-surface-muted'],
  ] as const)('tone=%s uses the status triple', (tone, token) => {
    const { container } = render(
      <PostureHeadline tone={tone} Icon={Shield} title="t" detail="d" />,
    );
    expect(container.innerHTML).toContain(token);
  });
});

describe('FilterBar', () => {
  it('tints the advanced toggle with the info tokens the audit page already used', () => {
    const { container } = render(
      <FilterBar
        searchValue=""
        onSearchChange={() => {}}
        showAdvanced={false}
        onToggleAdvanced={() => {}}
        advancedFilterCount={2}
        advancedContent={<div />}
      />,
    );
    const toggle = container.querySelector('button')!;
    expect(toggle.className).toContain('border-info-border');
    expect(toggle.className).toContain('bg-info-bg');
    expect(toggle.className).not.toContain('border-blue-300');
  });
});

describe('the kit is free of raw palette classes where a token exists', () => {
  it.each([
    'src/components/ui/Callout.tsx',
    'src/components/ui/Toast.tsx',
    'src/components/ui/ResourceList.tsx',
    'src/components/ui/PostureHeadline.tsx',
  ])('%s', (file) => {
    expect(read(file)).not.toMatch(RAW_PALETTE);
  });
});
