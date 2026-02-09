interface StringArrayEditorProps {
  value: string[];
  onChange: (val: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
  label?: string;
  addLabel?: string;
}

export default function StringArrayEditor({
  value, onChange, placeholder = '', disabled, label, addLabel = '+ Add',
}: StringArrayEditorProps) {
  const handleAdd = () => onChange([...value, '']);
  const handleRemove = (index: number) => onChange(value.filter((_, i) => i !== index));
  const handleChange = (index: number, val: string) => {
    const updated = [...value];
    updated[index] = val;
    onChange(updated);
  };

  return (
    <div>
      {label && <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>}
      <div className="space-y-2">
        {value.map((item, idx) => (
          <div key={idx} className="flex items-center space-x-2">
            <input
              type="text"
              value={item}
              onChange={(e) => handleChange(idx, e.target.value)}
              placeholder={placeholder}
              disabled={disabled}
              className="flex-1 px-3 py-1.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
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
        {addLabel}
      </button>
    </div>
  );
}
