import { EnvEntry } from '@/types/form-types';

interface EnvEditorProps {
  value: EnvEntry[];
  onChange: (val: EnvEntry[]) => void;
  disabled?: boolean;
}

export default function EnvEditor({ value, onChange, disabled }: EnvEditorProps) {
  const handleAdd = () => onChange([...value, { key: '', value: '' }]);
  const handleRemove = (index: number) => onChange(value.filter((_, i) => i !== index));
  const handleChange = (index: number, field: 'key' | 'value', val: string) => {
    const updated = [...value];
    updated[index] = { ...updated[index], [field]: val };
    onChange(updated);
  };

  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-2">Environment Variables</label>
      <div className="space-y-2">
        {value.map((entry, idx) => (
          <div key={idx} className="flex items-center space-x-2">
            <input
              type="text"
              value={entry.key}
              onChange={(e) => handleChange(idx, 'key', e.target.value)}
              placeholder="KEY"
              disabled={disabled}
              className="flex-1 px-3 py-1.5 border border-gray-300 rounded-md text-sm font-mono focus:outline-none focus:ring-blue-500 focus:border-blue-500"
            />
            <span className="text-gray-400">=</span>
            <input
              type="text"
              value={entry.value}
              onChange={(e) => handleChange(idx, 'value', e.target.value)}
              placeholder="value"
              disabled={disabled}
              className="flex-1 px-3 py-1.5 border border-gray-300 rounded-md text-sm font-mono focus:outline-none focus:ring-blue-500 focus:border-blue-500"
            />
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
        + Add Variable
      </button>
    </div>
  );
}
