/**
 * @module editors/ArtifactKeyCombobox
 * @description Autocomplete combobox for artifact key selection.
 *
 * Allows users to either type a free-text artifact key or select from
 * a dropdown of available artifact keys computed from the current
 * pipeline form state. Follows the same pattern as {@link MetadataKeyCombobox}.
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { type ArtifactKeyOption, groupArtifactOptions } from '@/lib/artifact-keys';

interface ArtifactKeyComboboxProps {
  /** Current artifact key value. */
  value: string;
  /** Called when the value changes (typed or selected). */
  onChange: (key: string) => void;
  /** Available artifact key options to show in the dropdown. */
  options: ArtifactKeyOption[];
  /** Whether the input is disabled. */
  disabled?: boolean;
  /** Placeholder text for the input. */
  placeholder?: string;
}

export default function ArtifactKeyCombobox({
  value,
  onChange,
  options,
  disabled,
  placeholder = 'Type or select artifact key',
}: ArtifactKeyComboboxProps) {
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

  const handleSelect = useCallback(
    (opt: ArtifactKeyOption) => {
      onChange(opt.key);
      setFilter('');
      setOpen(false);
      inputRef.current?.blur();
    },
    [onChange],
  );

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setOpen(false);
      inputRef.current?.blur();
    }
  }, []);

  const query = filter || value;
  const groups = groupArtifactOptions(options, query);

  return (
    <div ref={wrapperRef} className="relative flex-[2]">
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={handleInputChange}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        className="input w-full"
      />
      {open && !disabled && options.length > 0 && groups.length > 0 && (
        <div className="absolute z-50 mt-1 w-full max-h-60 overflow-auto bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-xl shadow-lg text-sm">
          {groups.map((group) => (
            <div key={group.category}>
              <div className="px-3 py-1 text-xs font-semibold text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-900 sticky top-0">
                {group.category}
              </div>
              {group.options.map((opt) => (
                <button
                  key={opt.key}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => handleSelect(opt)}
                  className="w-full text-left px-3 py-1.5 hover:bg-blue-50 dark:hover:bg-blue-900/30 cursor-pointer transition-colors"
                >
                  <div className="flex justify-between items-center">
                    <span className="truncate text-gray-900 dark:text-gray-100">{opt.label}</span>
                  </div>
                  <div className="text-xs text-gray-400 dark:text-gray-500 truncate">{opt.key}</div>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
