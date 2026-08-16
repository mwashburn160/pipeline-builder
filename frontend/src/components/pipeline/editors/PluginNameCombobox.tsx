import { useState, useCallback } from 'react';
import { Plugin } from '@/types';
import { Input } from '@/components/ui/Input';
import { usePlugins, groupPlugins } from '@/hooks/usePlugins';
import { useCombobox } from '@/hooks/useCombobox';

/** Props for {@link PluginNameCombobox}. */
interface PluginNameComboboxProps {
  /** Current plugin name value. */
  value: string;
  /** Called when the text input value changes (typed or cleared). */
  onChange: (name: string) => void;
  /** Called when a plugin is selected from the dropdown, providing the full Plugin record. */
  onSelectPlugin: (plugin: Plugin) => void;
  /** Whether the input is disabled. */
  disabled?: boolean;
  /** Label text shown above the input. */
  label?: string;
  /** Validation error message displayed below the input. */
  error?: string;
}

/**
 * Autocomplete combobox for selecting a plugin by name.
 *
 * Fetches the plugin list lazily on first focus, then displays a categorized
 * dropdown filtered by the current input. Selecting a plugin fires both onChange
 * (with the name string) and onSelectPlugin (with the full Plugin record).
 */
export default function PluginNameCombobox({
  value, onChange, onSelectPlugin, disabled, label = 'Plugin', error,
}: PluginNameComboboxProps) {
  const { open, setOpen, filter, activeIndex, setActiveIndex, wrapperRef, inputRef, handleInputChange, handleKeyDown, dismiss, listboxId, optionId, inputAriaProps } = useCombobox(onChange);

  const [hasOpened, setHasOpened] = useState(false);
  const { plugins, isLoading } = usePlugins(hasOpened);

  const handleSelect = useCallback((plugin: Plugin) => {
    onChange(plugin.name);
    onSelectPlugin(plugin);
    dismiss();
  }, [onChange, onSelectPlugin, dismiss]);

  const handleFocus = useCallback(() => {
    setHasOpened(true);
    setOpen(true);
  }, [setOpen]);

  const query = filter || value;
  const groups = groupPlugins(plugins, query);
  // Flat, render-ordered option list so keyboard nav can track a single active index across groups.
  const flatPlugins = groups.flatMap((g) => g.plugins);

  return (
    <div>
      <label className="label">{label} Name *</label>
      <div ref={wrapperRef} className="relative">
        <Input
          ref={inputRef}
          type="text"
          value={value}
          onChange={handleInputChange}
          onFocus={handleFocus}
          onKeyDown={(e) => handleKeyDown(e, flatPlugins.length, (i) => handleSelect(flatPlugins[i]))}
          placeholder="plugin-name (type or select)"
          disabled={disabled}
          autoComplete="off"
          {...inputAriaProps}
        />
        {open && !disabled && (
          <div role="listbox" id={listboxId} aria-label="Plugins" className="absolute z-50 mt-1 w-full max-h-60 overflow-auto bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-xl shadow-lg text-sm">
            {isLoading ? (
              <div className="px-3 py-2 text-gray-500 dark:text-gray-400">Loading plugins...</div>
            ) : groups.length === 0 ? (
              <div className="px-3 py-2 text-gray-500 dark:text-gray-400">
                {query ? 'No matching plugins' : 'No plugins available'}
              </div>
            ) : (
              (() => {
                let flatIndex = -1;
                return groups.map((group) => (
                  <div key={group.category}>
                    <div className="px-3 py-1 text-xs font-semibold text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-900 sticky top-0">
                      {group.category}
                    </div>
                    {group.plugins.map((plugin) => {
                      flatIndex += 1;
                      const i = flatIndex;
                      return (
                        <button
                          key={plugin.id}
                          type="button"
                          role="option"
                          id={optionId(i)}
                          aria-selected={i === activeIndex}
                          ref={(el) => { if (i === activeIndex) el?.scrollIntoView({ block: 'nearest' }); }}
                          onMouseDown={(e) => e.preventDefault()}
                          onMouseEnter={() => setActiveIndex(i)}
                          onClick={() => handleSelect(plugin)}
                          className={`w-full text-left px-3 py-1.5 cursor-pointer text-gray-900 dark:text-gray-100 transition-colors ${i === activeIndex ? 'bg-blue-100 dark:bg-blue-900/40' : 'hover:bg-blue-50 dark:hover:bg-blue-900/30'}`}
                        >
                          <div className="flex justify-between items-center">
                            <span className="truncate font-medium">{plugin.name}</span>
                            <span className="ml-2 text-xs text-gray-400 dark:text-gray-500 shrink-0">v{plugin.version}</span>
                          </div>
                          {plugin.description && (
                            <div className="text-xs text-gray-500 dark:text-gray-400 truncate">{plugin.description}</div>
                          )}
                        </button>
                      );
                    })}
                  </div>
                ));
              })()
            )}
          </div>
        )}
      </div>
      {error && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
