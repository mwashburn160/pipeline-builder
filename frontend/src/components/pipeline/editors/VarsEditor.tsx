// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useRef } from 'react';
import { Select } from '@/components/ui/Select';
import { useTemplateValidation } from '@/hooks/useTemplateValidation';
import type { MetadataEntry } from '@/types/form-types';

interface VarsEditorProps {
  /** Current list of key/value/type variable entries. */
  value: MetadataEntry[];
  /** Callback when the list changes (add, remove, or edit an entry). */
  onChange: (val: MetadataEntry[]) => void;
  disabled?: boolean;
}

/**
 * Editor for pipeline-level template variables (`{{ pipeline.vars.* }}`).
 *
 * Unlike MetadataEditor, the key is a plain free-form text input (var names are
 * user-chosen, e.g. `orgId` — not drawn from the metadata-key catalog), and the
 * row uses an explicit CSS grid so the key/value inputs keep a stable width and
 * can't collapse behind the type selector. The string value input is
 * template-aware so `{{ … }}` tokens are highlighted.
 */
export default function VarsEditor({ value, onChange, disabled }: VarsEditorProps) {
  // Stable, client-only row ids kept in lockstep with `value` so React keys by
  // row identity (not index) — keys/values are free-text and may be empty/dup.
  const counterRef = useRef(0);
  const idsRef = useRef<string[]>([]);
  while (idsRef.current.length < value.length) idsRef.current.push(`var-${counterRef.current++}`);
  if (idsRef.current.length > value.length) idsRef.current = idsRef.current.slice(0, value.length);
  const ids = idsRef.current;

  const handleAdd = () => onChange([...value, { key: '', value: '', type: 'string' }]);
  const handleRemove = (index: number) => {
    idsRef.current = idsRef.current.filter((_, i) => i !== index);
    onChange(value.filter((_, i) => i !== index));
  };
  const handleChange = (index: number, field: keyof MetadataEntry, val: string) => {
    const updated = [...value];
    updated[index] = { ...updated[index], [field]: val };
    // Coerce the value into a valid boolean when switching to the boolean type.
    if (field === 'type' && val === 'boolean' && updated[index].value !== 'true' && updated[index].value !== 'false') {
      updated[index] = { ...updated[index], value: 'false' };
    }
    onChange(updated);
  };

  const inputCls =
    'w-full px-3 py-1.5 border rounded-lg text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 ' +
    'placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors';

  return (
    <div className="space-y-2">
      {value.map((entry, idx) => (
        <VarRow
          key={ids[idx]}
          entry={entry}
          disabled={disabled}
          inputCls={inputCls}
          onKeyChange={(v) => handleChange(idx, 'key', v)}
          onValueChange={(v) => handleChange(idx, 'value', v)}
          onTypeChange={(v) => handleChange(idx, 'type', v)}
          onRemove={() => handleRemove(idx)}
        />
      ))}
      <button
        type="button"
        onClick={handleAdd}
        disabled={disabled}
        className="text-sm text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 font-medium disabled:opacity-50"
      >
        + Add Variable
      </button>
    </div>
  );
}

function VarRow({
  entry, disabled, inputCls, onKeyChange, onValueChange, onTypeChange, onRemove,
}: {
  entry: MetadataEntry;
  disabled?: boolean;
  inputCls: string;
  onKeyChange: (v: string) => void;
  onValueChange: (v: string) => void;
  onTypeChange: (v: string) => void;
  onRemove: () => void;
}) {
  const validation = useTemplateValidation(entry.type === 'string' ? entry.value : undefined);
  const invalid = validation.hasTemplate && !validation.valid;
  const valueBorder = invalid
    ? 'border-red-400 dark:border-red-500'
    : validation.hasTemplate
      ? 'border-indigo-400 dark:border-indigo-500'
      : 'border-gray-300 dark:border-gray-600';

  return (
    <div>
      {/* Explicit grid so key/value keep a stable width and never collapse. */}
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_7rem_auto] items-center gap-2">
        <input
          type="text"
          value={entry.key}
          onChange={(e) => onKeyChange(e.target.value)}
          placeholder="Name (e.g. orgId)"
          disabled={disabled}
          autoComplete="off"
          className={`${inputCls} border-gray-300 dark:border-gray-600`}
        />
        {entry.type === 'boolean' ? (
          <Select value={entry.value} onChange={(e) => onValueChange(e.target.value)} disabled={disabled} className={`${inputCls} ${valueBorder}`}>
            <option value="true">true</option>
            <option value="false">false</option>
          </Select>
        ) : (
          <input
            type={entry.type === 'number' ? 'number' : 'text'}
            value={entry.value}
            onChange={(e) => onValueChange(e.target.value)}
            placeholder="Value"
            disabled={disabled}
            className={`${inputCls} ${valueBorder}`}
          />
        )}
        <Select value={entry.type} onChange={(e) => onTypeChange(e.target.value)} disabled={disabled} className={`${inputCls} border-gray-300 dark:border-gray-600`}>
          <option value="string">String</option>
          <option value="number">Number</option>
          <option value="boolean">Boolean</option>
        </Select>
        <button
          type="button"
          onClick={onRemove}
          disabled={disabled}
          className="text-sm text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 px-2 disabled:opacity-50"
        >
          Remove
        </button>
      </div>
      {invalid && (
        <div className="mt-0.5 text-xs text-red-600 dark:text-red-400" role="alert">{validation.error}</div>
      )}
      {validation.hasTemplate && validation.valid && (
        <div className="mt-0.5 text-xs text-indigo-600 dark:text-indigo-400">
          Contains {validation.tokens.filter(t => t.kind === 'expr').length} template token{validation.tokens.filter(t => t.kind === 'expr').length === 1 ? '' : 's'} — resolved at synth time
        </div>
      )}
    </div>
  );
}
