// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `Button`'s unavailable states.
 *
 * `disabledReason` (and `readOnly`, which is `disabledReason = READ_ONLY_REASON`)
 * renders `aria-disabled` rather than native `disabled`: the button stays in the
 * Tab order so a keyboard user can reach it and hear WHY, activation is
 * swallowed (including a form submit), and the reason is the button's
 * accessible description and its focus-aware tooltip. Plain `disabled` / `loading`
 * keep native disabled semantics.
 */
import { describe, it, expect, jest } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from '../src/components/ui/Button';
import { READ_ONLY_REASON } from '../src/components/ui/ReadOnlyNotice';

describe('Button disabledReason', () => {
  it('is focusable, inert and described by its reason', async () => {
    const onClick = jest.fn<AnyFn>();
    render(<Button disabledReason="Requires pipelines:write" onClick={onClick}>Create</Button>);
    const btn = screen.getByRole('button', { name: 'Create' });

    expect(btn).not.toBeDisabled();
    expect(btn).toHaveAttribute('aria-disabled', 'true');
    expect(btn).toHaveAccessibleDescription('Requires pipelines:write');
    expect(btn).not.toHaveAttribute('title');

    await userEvent.tab();
    expect(btn).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('shows the reason in the tooltip on keyboard focus', () => {
    jest.useFakeTimers();
    try {
      render(<Button disabledReason="Requires pipelines:write">Create</Button>);
      act(() => { screen.getByRole('button', { name: 'Create' }).focus(); });
      act(() => { jest.advanceTimersByTime(400); });
      expect(screen.getByRole('tooltip')).toHaveTextContent('Requires pipelines:write');
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not submit its form', () => {
    const onSubmit = jest.fn<AnyFn>((e: Event) => e.preventDefault());
    render(<form onSubmit={onSubmit as never}><Button type="submit" disabledReason="Nope">Save</Button></form>);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('keeps a caller aria-describedby alongside the reason', () => {
    render(<><p id="hint">Saves the draft</p><Button aria-describedby="hint" disabledReason="Nope">Save</Button></>);
    expect(screen.getByRole('button', { name: 'Save' })).toHaveAccessibleDescription('Saves the draft Nope');
  });

  it('falsy reason means available, subject to disabled', () => {
    const onClick = jest.fn<AnyFn>();
    const { rerender } = render(<Button disabledReason={undefined} title="Create a token" onClick={onClick}>Create</Button>);
    const btn = screen.getByRole('button', { name: 'Create' });
    expect(btn).toBeEnabled();
    expect(btn).not.toHaveAttribute('aria-disabled');
    expect(btn).toHaveAttribute('title', 'Create a token');
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);

    rerender(<Button disabledReason={false} disabled>Create</Button>);
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
  });
});

describe('Button readOnly', () => {
  it('is unavailable with the read-only reason, replacing its own title', () => {
    const onClick = jest.fn<AnyFn>();
    render(<Button readOnly title="Create a token" onClick={onClick}>Create</Button>);
    const btn = screen.getByRole('button', { name: 'Create' });
    expect(btn).toHaveAttribute('aria-disabled', 'true');
    expect(btn).toHaveAccessibleDescription(READ_ONLY_REASON);
    expect(btn).not.toHaveAttribute('title');
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('keeps its own title and state when not read-only', () => {
    render(<Button title="Create a token" disabled={false}>Create</Button>);
    const btn = screen.getByRole('button', { name: 'Create' });
    expect(btn).toBeEnabled();
    expect(btn).toHaveAttribute('title', 'Create a token');
  });

  it('still honours disabled alongside readOnly={false}', () => {
    render(<Button readOnly={false} disabled>Create</Button>);
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
  });

  it('loading disables natively and shows the spinner', () => {
    render(<Button loading>Save</Button>);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});
