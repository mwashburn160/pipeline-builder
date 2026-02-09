import { useState, useRef, useEffect, useCallback } from 'react';
import { MetadataEntry } from '@/types/form-types';
import { METADATA_KEY_GROUPS, type MetadataKeyOption } from './metadata-keys';

interface MetadataEditorProps {
  value: MetadataEntry[];
  onChange: (val: MetadataEntry[]) => void;
  disabled?: boolean;
  label?: string;
}

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
              <input
                type={entry.type === 'number' ? 'number' : 'text'}
                value={entry.value}
                onChange={(e) => handleChange(idx, 'value', e.target.value)}
                placeholder="Value"
                disabled={disabled}
                className="flex-1 px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors"
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
