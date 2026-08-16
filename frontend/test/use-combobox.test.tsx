// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { renderHook, act } from '@testing-library/react';
import { useCombobox } from '@/hooks/useCombobox';

type KD = React.KeyboardEvent;
const key = (k: string): KD => ({ key: k, preventDefault: () => {} } as unknown as KD);

describe('useCombobox — keyboard navigation + ARIA', () => {
  it('ArrowDown opens and advances; Enter selects the active option', () => {
    const { result } = renderHook(() => useCombobox(() => {}));
    const onSelect = jest.fn();

    act(() => result.current.handleKeyDown(key('ArrowDown'), 3, onSelect));
    expect(result.current.open).toBe(true);
    expect(result.current.activeIndex).toBe(0);

    act(() => result.current.handleKeyDown(key('ArrowDown'), 3, onSelect));
    expect(result.current.activeIndex).toBe(1);

    act(() => result.current.handleKeyDown(key('Enter'), 3, onSelect));
    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it('ArrowUp clamps at 0; Escape closes and clears the highlight', () => {
    const { result } = renderHook(() => useCombobox(() => {}));
    act(() => result.current.handleKeyDown(key('ArrowDown'), 2, () => {}));
    act(() => result.current.handleKeyDown(key('ArrowUp'), 2, () => {}));
    act(() => result.current.handleKeyDown(key('ArrowUp'), 2, () => {}));
    expect(result.current.activeIndex).toBe(0);

    act(() => result.current.handleKeyDown(key('Escape'), 2, () => {}));
    expect(result.current.open).toBe(false);
    expect(result.current.activeIndex).toBe(-1);
  });

  it('inputAriaProps reflect open + active descendant', () => {
    const { result } = renderHook(() => useCombobox(() => {}));
    expect(result.current.inputAriaProps.role).toBe('combobox');
    expect(result.current.inputAriaProps['aria-expanded']).toBe(false);

    act(() => result.current.handleKeyDown(key('ArrowDown'), 2, () => {}));
    expect(result.current.inputAriaProps['aria-expanded']).toBe(true);
    expect(result.current.inputAriaProps['aria-activedescendant']).toBe(result.current.optionId(0));
  });
});
