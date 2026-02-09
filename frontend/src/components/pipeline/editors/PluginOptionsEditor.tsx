import { FormPluginOptions } from '@/types/form-types';
import CollapsibleSection from './CollapsibleSection';
import MetadataEditor from './MetadataEditor';

interface PluginOptionsEditorProps {
  value: FormPluginOptions;
  onChange: (val: FormPluginOptions) => void;
  disabled?: boolean;
  error?: string;
  label?: string;
}

export default function PluginOptionsEditor({
  value, onChange, disabled, error, label = 'Plugin',
}: PluginOptionsEditorProps) {
  const update = (fields: Partial<FormPluginOptions>) => onChange({ ...value, ...fields });

  return (
    <div className="space-y-3">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">{label} Name *</label>
        <input
          type="text"
          value={value.name}
          onChange={(e) => update({ name: e.target.value })}
          placeholder="plugin-name"
          disabled={disabled}
          className="block w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
        />
        {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">{label} Alias</label>
        <input
          type="text"
          value={value.alias}
          onChange={(e) => update({ alias: e.target.value })}
          placeholder="Optional alias"
          disabled={disabled}
          className="block w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
        />
      </div>
      <CollapsibleSection title={`${label} Metadata`} hasContent={value.metadata.length > 0}>
        <div className="mt-3">
          <MetadataEditor
            value={value.metadata}
            onChange={(metadata) => update({ metadata })}
            disabled={disabled}
          />
        </div>
      </CollapsibleSection>
    </div>
  );
}
