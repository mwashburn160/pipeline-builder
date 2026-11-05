// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The build-shape surfaces (D11/D13).
 *
 * The catalog is IMPORTED here, not mirrored: `lib/build-shape.ts` and the test
 * that parsed api-core's TypeScript source to detect drift are both gone, so
 * these assert behaviour rather than table parity.
 *
 *  - one select over five named machines (Small … X-Large), with gated ones
 *    SHOWN AND LOCKED — a capability nobody can see is a reason to upgrade
 *    nobody ever learns;
 *  - picking a machine also picks the class it belongs with, so Small lands in
 *    `flexible` without the user having to learn why;
 *  - the cost hint says what a build will cost BEFORE it is submitted, states
 *    its own vCPU assumption, and renders nothing for an unlimited or unreadable
 *    quota (fails open).
 */

import { describe, it, expect, jest } from '@jest/globals';
import { fireEvent, render, screen, within } from '@testing-library/react';

import { BuildShapeFields } from '../src/components/plugin/BuildShapeFields';
import { BuildCostHint, buildCreditsBlocked } from '../src/components/ui/BuildCostHint';
import { BuildCapacityCard } from '../src/components/quotas/BuildCapacityCard';
import type { QuotaSummary } from '../src/types';

const noop = () => {};

function summary(over: Partial<QuotaSummary> = {}): QuotaSummary {
  return {
    used: 1_000, limit: 4_500, remaining: 3_500,
    unlimited: false, resetAt: '2026-12-01T00:00:00.000Z', periodDays: 30,
    ...over,
  };
}

function sizes(): string[] {
  return within(screen.getByTestId('build-size-select'))
    .getAllByRole('option')
    .map((o) => (o as HTMLOptionElement).value);
}

describe('BuildShapeFields — the machine select', () => {
  it('offers Small and Standard on the free tier, so the cheapest rung is not a paid feature', () => {
    // `0.5x` is a budget option, not a restriction: the free tier gets a real
    // choice (spend less) instead of a list of locks.
    render(<BuildShapeFields tier="developer" buildClass="standard" buildSize="1x" onClassChange={noop} onSizeChange={noop} />);
    expect(sizes()).toEqual(['0.5x', '1x']);
    const select = screen.getByTestId('build-size-select');
    expect(within(select).getByRole('option', { name: 'Small (0.5x)' })).toBeInTheDocument();
  });

  it('shows gated machines LOCKED with the tier that has them, not hidden', () => {
    render(<BuildShapeFields tier="pro" buildClass="standard" buildSize="1x" onClassChange={noop} onSizeChange={noop} />);
    const ladder = screen.getByTestId('build-size-ladder');
    expect(ladder).toHaveTextContent('Medium (2x) · Team and above');
    expect(ladder).toHaveTextContent('Large (4x) · Business and above');
    expect(ladder).toHaveTextContent('X-Large (8x) · Enterprise and above');
  });

  it('opens the whole ladder at the top tier, with nothing left locked', () => {
    render(<BuildShapeFields tier="enterprise" buildClass="standard" buildSize="1x" onClassChange={noop} onSizeChange={noop} />);
    expect(sizes()).toEqual(['0.5x', '1x', '2x', '4x', '8x']);
    expect(screen.getByTestId('build-size-ladder')).toBeEmptyDOMElement();
  });

  it('moves the class with the machine, so Small defers without being asked', () => {
    // A half-speed build holds its slot about twice as long; on Developer's
    // single standard slot that would block the only urgent-fix slot.
    const onClassChange = jest.fn<(c: string) => void>();
    const onSizeChange = jest.fn<(s: string) => void>();
    render(<BuildShapeFields tier="developer" buildClass="standard" buildSize="1x" onClassChange={onClassChange} onSizeChange={onSizeChange} />);

    fireEvent.change(screen.getByTestId('build-size-select'), { target: { value: '0.5x' } });

    expect(onSizeChange).toHaveBeenCalledWith('0.5x');
    expect(onClassChange).toHaveBeenCalledWith('flexible');
  });

  it('leaves an explicit deferral alone when the machine changes', () => {
    const onClassChange = jest.fn<(c: string) => void>();
    render(<BuildShapeFields tier="business" buildClass="flexible" buildSize="1x" onClassChange={onClassChange} onSizeChange={noop} />);

    fireEvent.change(screen.getByTestId('build-size-select'), { target: { value: '4x' } });

    // `flexible` + `Large` is a legitimate nightly image; the component must not
    // quietly move it back to standard, which is the worst cell for the platform.
    expect(onClassChange).not.toHaveBeenCalled();
  });

  it('names the plan\'s own slot counts beside the deferral toggle', () => {
    render(<BuildShapeFields tier="team" buildClass="standard" buildSize="1x" onClassChange={noop} onSizeChange={noop} />);
    expect(screen.getByText(/3 standard · 6 flexible builds at once/)).toBeInTheDocument();
  });

  it('suppresses the machine field while the tier is unknown, rather than flashing a lock', () => {
    render(<BuildShapeFields buildClass="standard" buildSize="1x" onClassChange={noop} onSizeChange={noop} />);
    expect(screen.queryByTestId('build-size-select')).not.toBeInTheDocument();
    // The class is ungated, so the deferral toggle is offered regardless.
    expect(screen.getByTestId('build-defer-toggle')).toBeInTheDocument();
  });
});

describe('BuildCostHint', () => {
  it('quotes the cost and what is left, with the vCPU assumption stated', () => {
    render(<BuildCostHint quota={{ summary: summary(), tier: 'developer' }} />);
    const hint = screen.getByTestId('build-cost-hint');
    expect(hint).toHaveTextContent('About 15 credits');
    // Stated, not hidden: the figure is a plugin-service env var the frontend
    // cannot read, so an operator who raises it would otherwise make this line
    // quietly wrong.
    expect(hint).toHaveTextContent('at 1.5 vCPU');
    expect(hint).toHaveTextContent('3,500 remaining this month');
  });

  it('scales the quote with the machine, naming it by label', () => {
    render(<BuildCostHint quota={{ summary: summary(), tier: 'business' }} buildSize="4x" />);
    const hint = screen.getByTestId('build-cost-hint');
    expect(hint).toHaveTextContent('About 60 credits');
    expect(hint).toHaveTextContent('at 6 vCPU (Large)');
  });

  it('halves the quote on Small, which is the whole point of that rung', () => {
    render(<BuildCostHint quota={{ summary: summary(), tier: 'developer' }} buildSize="0.5x" />);
    const hint = screen.getByTestId('build-cost-hint');
    // 10 wall-minutes at 0.75 vCPU. An I/O-bound build really does cost about
    // half; a CPU-bound one takes twice as long and costs the same, so Small can
    // never cost MORE than Standard.
    expect(hint).toHaveTextContent('About 8 credits');
    expect(hint).toHaveTextContent('(Small)');
  });

  it('offers the pack when the budget is gone, and says the window also resets it', () => {
    render(<BuildCostHint quota={{ summary: summary({ used: 4_500, remaining: 0 }), tier: 'pro' }} />);
    const hint = screen.getByTestId('build-cost-hint');
    expect(hint).toHaveTextContent('No CPU credits left this month');
    expect(within(hint).getByRole('link', { name: /credits pack/i })).toHaveAttribute('href', '/dashboard/billing');
    expect(hint).toHaveTextContent('wait for the window to reset');
  });

  it('renders NOTHING for an unlimited or unreadable quota, so a read failure locks nothing', () => {
    const { container: a } = render(<BuildCostHint quota={null} />);
    expect(a).toBeEmptyDOMElement();
    const { container: b } = render(<BuildCostHint quota={{ summary: summary({ unlimited: true, limit: -1 }) }} />);
    expect(b).toBeEmptyDOMElement();
  });
});

describe('buildCreditsBlocked', () => {
  it('blocks only on exhaustion, never on an estimate that looks too big', () => {
    // The estimate is an estimate; the backend admits on the real counter. A
    // predicate that refused on the guess would reject builds that would fit.
    expect(buildCreditsBlocked(summary({ remaining: 1 }))).toBe(false);
    expect(buildCreditsBlocked(summary({ remaining: 0 }))).toBe(true);
    expect(buildCreditsBlocked(summary({ remaining: -5 }))).toBe(true);
  });

  it('never blocks on an unlimited or missing quota', () => {
    expect(buildCreditsBlocked(summary({ unlimited: true, remaining: 0 }))).toBe(false);
    expect(buildCreditsBlocked(null)).toBe(false);
    expect(buildCreditsBlocked(undefined)).toBe(false);
  });
});

describe('BuildCapacityCard', () => {
  it('shows slots per class and says a slot is not spent', () => {
    render(<BuildCapacityCard tier="pro" />);
    const card = screen.getByTestId('build-capacity-card');
    expect(card).toHaveTextContent('Standard');
    expect(card).toHaveTextContent('Flexible');
    // Capacity is not a quota: a slot is occupied and given back.
    expect(card).toHaveTextContent('nothing here is spent');
  });

  it('names the machines by label, with gated ones carrying their tier', () => {
    const { unmount } = render(<BuildCapacityCard tier="team" />);
    const card = screen.getByTestId('build-capacity-card');
    expect(card).toHaveTextContent('Medium');
    expect(card).toHaveTextContent('Large · Business and above');
    unmount();

    render(<BuildCapacityCard tier="enterprise" />);
    expect(screen.getByTestId('build-capacity-card')).not.toHaveTextContent('and above');
  });
});
