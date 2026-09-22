// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The directory search box: a real GET form (works before hydration), a `/`
 * shortcut, and debounced as-you-type search that keeps the URL the query.
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, act } from '@testing-library/react';

const replace = jest.fn<AnyFn>();
const push = jest.fn<AnyFn>();
jest.mock('next/router', () => require('./helpers/pageMocks').routerModule(() => ({ replace, push })));

import { DirectorySearch, SEARCH_DEBOUNCE_MS } from '../src/components/public-directory/DirectorySearch';

beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.useRealTimers(); });

describe('DirectorySearch', () => {
  it('is a GET form to /plugins that carries the other filters as hidden fields (no cursor)', () => {
    const { container } = render(<DirectorySearch query={{ q: 'a', tier: 'official', cursor: 'c1' }} />);
    const form = screen.getByRole('search');
    expect(form).toHaveAttribute('method', 'get');
    expect(form).toHaveAttribute('action', '/plugins');
    const hidden = [...container.querySelectorAll('input[type=hidden]')].map((i) => [i.getAttribute('name'), i.getAttribute('value')]);
    expect(hidden).toEqual([['tier', 'official']]);
  });

  it('debounces typing into one URL update', () => {
    render(<DirectorySearch query={{ tier: 'official' }} />);
    const input = screen.getByLabelText('Search plugins');
    fireEvent.change(input, { target: { value: 'ter' } });
    fireEvent.change(input, { target: { value: 'terraform' } });
    expect(replace).not.toHaveBeenCalled();
    act(() => { jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS); });
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace.mock.calls[0][0]).toBe('/plugins?q=terraform&tier=official');
  });

  it('does not search as you type when live is off', () => {
    render(<DirectorySearch query={{ category: 'security' }} live={false} />);
    fireEvent.change(screen.getByLabelText('Search plugins'), { target: { value: 'snyk' } });
    act(() => { jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS * 2); });
    expect(replace).not.toHaveBeenCalled();
    fireEvent.submit(screen.getByRole('search'));
    expect(push).toHaveBeenCalledWith('/plugins?q=snyk&category=security');
  });

  it('"/" focuses the box, but not while typing elsewhere', () => {
    render(<><input aria-label="other" /><DirectorySearch query={{}} /></>);
    const box = screen.getByLabelText('Search plugins');
    fireEvent.keyDown(document.body, { key: '/' });
    expect(box).toHaveFocus();
    const other = screen.getByLabelText('other');
    other.focus();
    fireEvent.keyDown(other, { key: '/' });
    expect(other).toHaveFocus();
  });
});
