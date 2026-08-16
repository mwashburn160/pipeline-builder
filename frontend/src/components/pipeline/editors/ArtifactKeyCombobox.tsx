import { useCallback } from 'react';
import { type ArtifactKeyOption, groupArtifactOptions } from '@/lib/artifact-keys';
import { useCombobox } from '@/hooks/useCombobox';

/** Props for {@link ArtifactKeyCombobox}. */
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

/**
 * Autocomplete combobox for selecting an artifact key.
 *
 * Allows users to either type a free-text artifact key or select from a
 * categorized dropdown of available artifact keys computed from the current
 * pipeline form state (synth output + preceding stages/steps).
 */
export default function ArtifactKeyCombobox({
  value,
  onChange,
  options,
  disabled,
  placeholder = 'Type or select artifact key',
}: ArtifactKeyComboboxProps) {
  const { open, setOpen, filter, activeIndex, setActiveIndex, wrapperRef, inputRef, handleInputChange, handleKeyDown, dismiss, listboxId, optionId, inputAriaProps } = useCombobox(onChange);

  const handleSelect = useCallback(
    (opt: ArtifactKeyOption) => {
      onChange(opt.key);
      dismiss();
    },
    [onChange, dismiss],
  );

  const query = filter || value;
  const groups = groupArtifactOptions(options, query);
  // Flat, render-ordered option list so keyboard nav can track a single active index across groups.
  const flatOptions = groups.flatMap((g) => g.options);

  return (
    <div ref={wrapperRef} className="relative flex-[2]">
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={handleInputChange}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => handleKeyDown(e, flatOptions.length, (i) => handleSelect(flatOptions[i]))}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        className="input w-full"
        {...inputAriaProps}
      />
      {open && !disabled && options.length > 0 && groups.length > 0 && (
        <div role="listbox" id={listboxId} aria-label="Artifact keys" className="absolute z-50 mt-1 w-full max-h-60 overflow-auto bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-xl shadow-lg text-sm">
          {(() => {
            let flatIndex = -1;
            return groups.map((group) => (
              <div key={group.category}>
                <div className="px-3 py-1 text-xs font-semibold text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-900 sticky top-0">
                  {group.category}
                </div>
                {group.options.map((opt) => {
                  flatIndex += 1;
                  const i = flatIndex;
                  return (
                    <button
                      key={opt.key}
                      type="button"
                      role="option"
                      id={optionId(i)}
                      aria-selected={i === activeIndex}
                      ref={(el) => { if (i === activeIndex) el?.scrollIntoView({ block: 'nearest' }); }}
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseEnter={() => setActiveIndex(i)}
                      onClick={() => handleSelect(opt)}
                      className={`w-full text-left px-3 py-1.5 cursor-pointer transition-colors ${i === activeIndex ? 'bg-blue-100 dark:bg-blue-900/40' : 'hover:bg-blue-50 dark:hover:bg-blue-900/30'}`}
                    >
                      <div className="flex justify-between items-center">
                        <span className="truncate text-gray-900 dark:text-gray-100">{opt.label}</span>
                      </div>
                      <div className="text-xs text-gray-400 dark:text-gray-500 truncate">{opt.key}</div>
                    </button>
                  );
                })}
              </div>
            ));
          })()}
        </div>
      )}
    </div>
  );
}
