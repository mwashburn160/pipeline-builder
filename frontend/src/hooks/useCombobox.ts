// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState, useRef, useEffect, useCallback, useId } from 'react';

/**
 * Shared hook for combobox/autocomplete inputs.
 *
 * Manages open/close state, input filtering, click-outside dismissal, and — for
 * accessibility — keyboard navigation (↑/↓/Home/End/Enter/Escape) with a tracked
 * `activeIndex`, plus WAI-ARIA combobox/listbox/option wiring helpers.
 *
 * The option list lives in the consumer, so `handleKeyDown(e, optionCount,
 * onSelect)` takes the current option count + a select-by-index callback. Every
 * combobox is expected to wire this + `inputAriaProps` + the listbox/option
 * roles so the whole app's typeaheads are keyboard + screen-reader operable.
 */
export function useCombobox(onChange: (value: string) => void) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
        setActiveIndex(-1);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = e.target.value;
      setFilter(v);
      onChange(v);
      setOpen(true);
      setActiveIndex(-1); // typing resets the highlight (results changed)
    },
    [onChange],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent, optionCount: number, onSelect: (index: number) => void) => {
      if (e.key === 'Escape') {
        setOpen(false);
        setActiveIndex(-1);
        inputRef.current?.blur();
        return;
      }
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setOpen(true);
          setActiveIndex((i) => Math.min((i < 0 ? -1 : i) + 1, optionCount - 1));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setActiveIndex((i) => Math.max(i - 1, 0));
          break;
        case 'Home':
          if (open) { e.preventDefault(); setActiveIndex(0); }
          break;
        case 'End':
          if (open) { e.preventDefault(); setActiveIndex(optionCount - 1); }
          break;
        case 'Enter':
          if (open && activeIndex >= 0 && activeIndex < optionCount) {
            e.preventDefault();
            onSelect?.(activeIndex);
          }
          break;
      }
    },
    [open, activeIndex],
  );

  const dismiss = useCallback(() => {
    setFilter('');
    setOpen(false);
    setActiveIndex(-1);
    inputRef.current?.blur();
  }, []);

  /** DOM id for the option at `index` — for `aria-activedescendant` + option `id`. */
  const optionId = useCallback((index: number) => `${listboxId}-opt-${index}`, [listboxId]);

  /** Spread onto the text input for combobox semantics. */
  const inputAriaProps = {
    role: 'combobox' as const,
    'aria-expanded': open,
    'aria-controls': listboxId,
    'aria-autocomplete': 'list' as const,
    'aria-activedescendant': open && activeIndex >= 0 ? optionId(activeIndex) : undefined,
  };

  return {
    open,
    setOpen,
    filter,
    activeIndex,
    setActiveIndex,
    wrapperRef,
    inputRef,
    handleInputChange,
    handleKeyDown,
    dismiss,
    listboxId,
    optionId,
    inputAriaProps,
  };
}
