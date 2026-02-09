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
      {label && <label className="label">{label}</label>}
      <div className="space-y-2">
        {value.map((item, idx) => (
          <div key={idx} className="flex items-center space-x-2">
            <input
              type="text"
              value={item}
              onChange={(e) => handleChange(idx, e.target.value)}
              placeholder={placeholder}
              disabled={disabled}
              className="flex-1 px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors"
            />
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
        {addLabel}
      </button>
    </div>
  );
}
