import { useId } from 'react';
import { EnvEntry } from '@/types/form-types';
import { useRowIds } from '@/hooks/useRowIds';
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
  const uid = useId();
  const { ids, add, remove, replace } = useRowIds(value, onChange, 'env');

  const handleChange = (index: number, field: 'key' | 'value', val: string) =>
    replace(index, { ...value[index], [field]: val });

  return (
    <div>
      <span className="label" id={`${uid}-env`}>Environment variables</span>
      <div role="group" aria-labelledby={`${uid}-env`} className="space-y-2">
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
            <span className="text-fg-subtle">=</span>
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
              onClick={() => remove(idx)}
              disabled={disabled}
              className="text-danger hover:text-danger text-sm"
            >
              Remove
            </Button>
          </div>
        ))}
      </div>
      <Button
        variant="link"
        onClick={() => add({ key: '', value: '' })}
        disabled={disabled}
        className="mt-2 text-sm"
      >
        + Add Variable
      </Button>
    </div>
  );
}
