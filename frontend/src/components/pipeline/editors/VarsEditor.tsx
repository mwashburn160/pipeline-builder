// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Select } from '@/components/ui/Select';
import { useRowIds } from '@/hooks/useRowIds';
import { coerceEntryValue, TemplateValueHint, useTemplateValueStyle } from './entry-value';
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
  const { ids, add, remove, replace } = useRowIds(value, onChange, 'var');

  const handleChange = (index: number, field: keyof MetadataEntry, val: string) =>
    replace(index, coerceEntryValue({ ...value[index], [field]: val }));

  const inputCls =
    'w-full px-3 py-1.5 border rounded-lg text-sm bg-surface text-fg ' +
    'placeholder:text-fg-subtle focus:outline-none focus:ring-2 focus:ring-[color:var(--pb-ring)] focus:border-brand transition-colors';

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
          onRemove={() => remove(idx)}
        />
      ))}
      <button
        type="button"
        onClick={() => add({ key: '', value: '', type: 'string' })}
        disabled={disabled}
        className="text-sm text-brand hover:text-brand-strong font-medium disabled:opacity-50"
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
  const { validation, invalid, border: valueBorder } = useTemplateValueStyle(entry);

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
          className={`${inputCls} border-default`}
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
        <Select value={entry.type} onChange={(e) => onTypeChange(e.target.value)} disabled={disabled} className={`${inputCls} border-default`}>
          <option value="string">String</option>
          <option value="number">Number</option>
          <option value="boolean">Boolean</option>
        </Select>
        <button
          type="button"
          onClick={onRemove}
          disabled={disabled}
          className="text-sm text-danger hover:text-danger px-2 disabled:opacity-50"
        >
          Remove
        </button>
      </div>
      <TemplateValueHint validation={validation} invalid={invalid} />
    </div>
  );
}
