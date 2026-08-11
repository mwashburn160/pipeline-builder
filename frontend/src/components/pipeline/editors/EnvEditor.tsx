import { useRef } from 'react';
import { EnvEntry } from '@/types/form-types';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';

/** Props for {@link EnvEditor}. */
interface EnvEditorProps {
  /** Current list of environment variable entries. */
  value: EnvEntry[];
  /** Callback when the list changes (add, remove, or edit an entry). */
  onChange: (val: EnvEntry[]) => void;
  /** Whether all inputs should be disabled. */
  disabled?: boolean;
}

/**
 * Editor for a list of environment variable key-value pairs.
 *
 * Renders each entry as a KEY = value row with a remove button, plus an
 * "Add Variable" button to append new empty entries.
 */
export default function EnvEditor({ value, onChange, disabled }: EnvEditorProps) {
  // Stable, client-only row ids kept in lockstep with `value` so React keys by
  // row identity (not array index) — prevents focus/value glitches on mid-list
  // removal. These ids are never serialized into the onChange payload.
  const counterRef = useRef(0);
  const idsRef = useRef<string[]>([]);
  // Reconcile length: append ids for rows added here or via the parent, and
  // truncate on a full external reset. Mid-list removal fixes ids explicitly
  // in handleRemove so this only ever adjusts the tail.
  while (idsRef.current.length < value.length) idsRef.current.push(`env-${counterRef.current++}`);
  if (idsRef.current.length > value.length) idsRef.current = idsRef.current.slice(0, value.length);
  const ids = idsRef.current;

  const handleAdd = () => onChange([...value, { key: '', value: '' }]);
  const handleRemove = (index: number) => {
    idsRef.current = idsRef.current.filter((_, i) => i !== index);
    onChange(value.filter((_, i) => i !== index));
  };
  const handleChange = (index: number, field: 'key' | 'value', val: string) => {
    const updated = [...value];
    updated[index] = { ...updated[index], [field]: val };
    onChange(updated);
  };

  return (
    <div>
      <label className="label">Environment Variables</label>
      <div className="space-y-2">
        {value.map((entry, idx) => (
          <div key={ids[idx]} className="flex items-center space-x-2">
            <Input
              type="text"
              value={entry.key}
              onChange={(e) => handleChange(idx, 'key', e.target.value)}
              placeholder="KEY"
              disabled={disabled}
              className="flex-1 font-mono"
            />
            <span className="text-gray-400 dark:text-gray-500">=</span>
            <Input
              type="text"
              value={entry.value}
              onChange={(e) => handleChange(idx, 'value', e.target.value)}
              placeholder="value"
              disabled={disabled}
              className="flex-1 font-mono"
            />
            <Button
              variant="link"
              onClick={() => handleRemove(idx)}
              disabled={disabled}
              className="text-red-500 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 text-sm"
            >
              Remove
            </Button>
          </div>
        ))}
      </div>
      <Button
        variant="link"
        onClick={handleAdd}
        disabled={disabled}
        className="mt-2 text-sm"
      >
        + Add Variable
      </Button>
    </div>
  );
}
