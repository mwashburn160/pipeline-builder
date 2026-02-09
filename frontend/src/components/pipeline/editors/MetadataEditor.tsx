import { useState, useRef, useEffect, useCallback } from 'react';
import { MetadataEntry } from '@/types/form-types';
import { METADATA_KEY_GROUPS, type MetadataKeyOption } from './metadata-keys';

interface MetadataEditorProps {
  value: MetadataEntry[];
  onChange: (val: MetadataEntry[]) => void;
  disabled?: boolean;
  label?: string;
}

/** Combobox input for selecting a predefined metadata key or typing a custom one. */
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
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Close on outside click
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
    (opt: MetadataKeyOption) => {
      onChange(opt.key);
      onSelectPredefined(opt);
      setFilter('');
      setOpen(false);
      inputRef.current?.blur();
    },
    [onChange, onSelectPredefined],
  );

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setOpen(false);
      inputRef.current?.blur();
    }
  }, []);

  // Filter groups/keys by current input text
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
        className="w-full px-3 py-1.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
      />
      {open && !disabled && filteredGroups.length > 0 && (
        <div className="absolute z-50 mt-1 w-full max-h-60 overflow-auto bg-white border border-gray-300 rounded-md shadow-lg text-sm">
          {filteredGroups.map((group) => (
            <div key={group.category}>
              <div className="px-3 py-1 text-xs font-semibold text-gray-500 bg-gray-50 sticky top-0">
                {group.category}
              </div>
              {group.keys.map((opt) => (
                <button
                  key={opt.key}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => handleSelect(opt)}
                  className="w-full text-left px-3 py-1.5 hover:bg-blue-50 cursor-pointer flex justify-between items-center"
                >
                  <span className="truncate">{opt.label}</span>
                  <span className="ml-2 text-xs text-gray-400 shrink-0">{opt.type}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function MetadataEditor({ value, onChange, disabled, label }: MetadataEditorProps) {
  const handleAdd = () => onChange([...value, { key: '', value: '', type: 'string' }]);
  const handleRemove = (index: number) => onChange(value.filter((_, i) => i !== index));
  const handleChange = (index: number, field: keyof MetadataEntry, val: string) => {
    const updated = [...value];
    updated[index] = { ...updated[index], [field]: val };
    // Reset value when switching to boolean type
    if (field === 'type' && val === 'boolean' && updated[index].value !== 'true' && updated[index].value !== 'false') {
      updated[index] = { ...updated[index], value: 'false' };
    }
    onChange(updated);
  };

  /** When a predefined key is selected, auto-set the type. */
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
      {label && <label className="block text-sm font-medium text-gray-700 mb-2">{label}</label>}
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
              className="px-2 py-1.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
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
                className="flex-1 px-3 py-1.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
              >
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            ) : (
              <input
                type={entry.type === 'number' ? 'number' : 'text'}
                value={entry.value}
                onChange={(e) => handleChange(idx, 'value', e.target.value)}
                placeholder="Value"
                disabled={disabled}
                className="flex-1 px-3 py-1.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
              />
            )}
            <button
              type="button"
              onClick={() => handleRemove(idx)}
              disabled={disabled}
              className="text-red-500 hover:text-red-700 text-sm px-2 py-1"
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
        className="mt-2 text-sm text-blue-600 hover:text-blue-800"
      >
        + Add Entry
      </button>
    </div>
  );
}
