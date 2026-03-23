import { useState, useRef, useEffect, useCallback } from 'react';

/**
 * Shared hook for combobox/autocomplete inputs.
 *
 * Manages open/close state, input filtering, click-outside dismissal,
 * and Escape key handling. Used by MetadataKeyCombobox and ArtifactKeyCombobox.
 */
export function useCombobox(onChange: (value: string) => void) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
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
    },
    [onChange],
  );

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setOpen(false);
      inputRef.current?.blur();
    }
  }, []);

  const dismiss = useCallback(() => {
    setFilter('');
    setOpen(false);
    inputRef.current?.blur();
  }, []);

  return {
    open,
    setOpen,
    filter,
    wrapperRef,
    inputRef,
    handleInputChange,
    handleKeyDown,
    dismiss,
  };
}
