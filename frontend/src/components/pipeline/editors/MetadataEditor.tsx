import { MetadataEntry } from '@/types/form-types';

interface MetadataEditorProps {
  value: MetadataEntry[];
  onChange: (val: MetadataEntry[]) => void;
  disabled?: boolean;
  label?: string;
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

  return (
    <div>
      {label && <label className="block text-sm font-medium text-gray-700 mb-2">{label}</label>}
      <div className="space-y-2">
        {value.map((entry, idx) => (
          <div key={idx} className="flex items-center space-x-2">
            <input
              type="text"
              value={entry.key}
              onChange={(e) => handleChange(idx, 'key', e.target.value)}
              placeholder="Key"
              disabled={disabled}
              className="flex-1 px-3 py-1.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
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
