import { useCallback } from 'react';
import { MetadataEntry } from '@/types/form-types';
import { useCombobox } from '@/hooks/useCombobox';
import { useTemplateValidation } from '@/hooks/useTemplateValidation';
import { METADATA_KEY_GROUPS, type MetadataKeyOption } from './metadata-keys';

/** Props for {@link MetadataEditor}. */
interface MetadataEditorProps {
  /** Current list of metadata key-value-type entries. */
  value: MetadataEntry[];
  /** Callback when the list changes (add, remove, or edit an entry). */
  onChange: (val: MetadataEntry[]) => void;
  /** Whether all inputs should be disabled. */
  disabled?: boolean;
  /** Optional label rendered above the list. */
  label?: string;
}

/**
 * Value input for a metadata entry. String entries get template-awareness —
 * parsing and highlighting inline when `{{ ... }}` tokens are present.
 * Numeric and boolean entries fall through to plain inputs.
 */
function MetadataValueInput({
  entry,
  disabled,
  onChange,
}: {
  entry: MetadataEntry;
  disabled?: boolean;
  onChange: (v: string) => void;
}): React.ReactElement {
  const validation = useTemplateValidation(entry.type === 'string' ? entry.value : undefined);
  const hasTemplate = validation.hasTemplate;
  const invalid = hasTemplate && !validation.valid;
  const border = invalid
    ? 'border-red-400 dark:border-red-500'
    : hasTemplate
      ? 'border-indigo-400 dark:border-indigo-500'
      : 'border-gray-300 dark:border-gray-600';

  return (
    <div className="flex-1">
      <input
        type={entry.type === 'number' ? 'number' : 'text'}
        value={entry.value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Value"
        disabled={disabled}
        className={`w-full px-3 py-1.5 border ${border} rounded-lg text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors`}
      />
      {invalid && (
        <div className="mt-0.5 text-xs text-red-600 dark:text-red-400" role="alert">
          {validation.error}
        </div>
      )}
      {hasTemplate && validation.valid && (
        <div className="mt-0.5 text-xs text-indigo-600 dark:text-indigo-400">
          Contains {validation.tokens.filter(t => t.kind === 'expr').length} template token{validation.tokens.filter(t => t.kind === 'expr').length === 1 ? '' : 's'} — resolved at synth time
        </div>
      )}
    </div>
  );
}

/**
 * Autocomplete combobox for metadata key input.
 *
 * Shows a categorized dropdown of predefined metadata keys filtered by the
 * current input. Selecting a predefined key also sets the entry's type.
 */
function MetadataKeyCombobox({
  value,
  onChange,
  onSelectPredefined,
  disabled,
}: {
  value: string;
  onChange: (val: string) => void;
  onSelectPredefined: (opt: MetadataKeyOption) => void;
  disabled?: boolean;
}) {
  const { open, setOpen, filter, wrapperRef, inputRef, handleInputChange, handleKeyDown, dismiss } = useCombobox(onChange);

  const handleSelect = useCallback(
    (opt: MetadataKeyOption) => {
      onChange(opt.key);
      onSelectPredefined(opt);
      dismiss();
    },
    [onChange, onSelectPredefined, dismiss],
  );

  const query = (filter || value).toLowerCase();
  const filteredGroups = METADATA_KEY_GROUPS.map((group) => ({
    ...group,
    keys: group.keys.filter(
      (k) =>
        k.key.toLowerCase().includes(query) ||
        k.label.toLowerCase().includes(query) ||
        group.category.toLowerCase().includes(query),
    ),
  })).filter((g) => g.keys.length > 0);

  return (
    <div ref={wrapperRef} className="relative flex-1">
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={handleInputChange}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
        placeholder="Key (type or select)"
        disabled={disabled}
        autoComplete="off"
        className="w-full px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors"
      />
      {open && !disabled && filteredGroups.length > 0 && (
        <div className="absolute z-50 mt-1 w-full max-h-60 overflow-auto bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-xl shadow-lg text-sm">
          {filteredGroups.map((group) => (
            <div key={group.category}>
              <div className="px-3 py-1 text-xs font-semibold text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-900 sticky top-0">
                {group.category}
              </div>
              {group.keys.map((opt) => (
                <button
                  key={opt.key}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => handleSelect(opt)}
                  className="w-full text-left px-3 py-1.5 hover:bg-blue-50 dark:hover:bg-blue-900/30 cursor-pointer flex justify-between items-center text-gray-900 dark:text-gray-100 transition-colors"
                >
                  <span className="truncate">{opt.label}</span>
                  <span className="ml-2 text-xs text-gray-400 dark:text-gray-500 shrink-0">{opt.type}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Editor for a list of typed metadata key-value entries.
 *
 * Each entry has a key (with autocomplete from predefined metadata keys),
 * a type selector (string, number, boolean), and a value input that adapts
 * to the selected type. Boolean entries render as a true/false dropdown.
 */
export default function MetadataEditor({ value, onChange, disabled, label }: MetadataEditorProps) {
  const handleAdd = () => onChange([...value, { key: '', value: '', type: 'string' }]);
  const handleRemove = (index: number) => onChange(value.filter((_, i) => i !== index));
  const handleChange = (index: number, field: keyof MetadataEntry, val: string) => {
    const updated = [...value];
    updated[index] = { ...updated[index], [field]: val };
    if (field === 'type' && val === 'boolean' && updated[index].value !== 'true' && updated[index].value !== 'false') {
      updated[index] = { ...updated[index], value: 'false' };
    }
    onChange(updated);
  };

  const handleSelectPredefined = (index: number, opt: MetadataKeyOption) => {
    const updated = [...value];
    updated[index] = {
      ...updated[index],
      key: opt.key,
      type: opt.type,
      value: opt.type === 'boolean' ? 'false' : updated[index].value,
    };
    onChange(updated);
  };

  return (
    <div>
      {label && <label className="label">{label}</label>}
      <div className="space-y-2">
        {value.map((entry, idx) => (
          <div key={idx} className="flex items-center space-x-2">
            <MetadataKeyCombobox
              value={entry.key}
              onChange={(v) => handleChange(idx, 'key', v)}
              onSelectPredefined={(opt) => handleSelectPredefined(idx, opt)}
              disabled={disabled}
            />
            <select
              value={entry.type}
              onChange={(e) => handleChange(idx, 'type', e.target.value)}
              disabled={disabled}
              className="px-2 py-1.5 border border-gray-300 dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors"
            >
              <option value="string">String</option>
              <option value="number">Number</option>
              <option value="boolean">Boolean</option>
            </select>
            {entry.type === 'boolean' ? (
              <select
                value={entry.value}
                onChange={(e) => handleChange(idx, 'value', e.target.value)}
                disabled={disabled}
                className="flex-1 px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors"
              >
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            ) : (
              <MetadataValueInput
                entry={entry}
                disabled={disabled}
                onChange={(v) => handleChange(idx, 'value', v)}
              />
            )}
            <button
              type="button"
              onClick={() => handleRemove(idx)}
              disabled={disabled}
              className="text-red-500 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 text-sm px-2 py-1 transition-colors"
            >
              Remove
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={handleAdd}
        disabled={disabled}
        className="mt-2 text-sm text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 transition-colors"
      >
        + Add Entry
      </button>
    </div>
  );
}
