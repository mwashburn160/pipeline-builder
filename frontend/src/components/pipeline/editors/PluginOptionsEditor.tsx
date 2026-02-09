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
        <label className="label">{label} Name *</label>
        <input
          type="text"
          value={value.name}
          onChange={(e) => update({ name: e.target.value })}
          placeholder="plugin-name"
          disabled={disabled}
          className="input"
        />
        {error && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>}
      </div>
      <div>
        <label className="label">{label} Alias</label>
        <input
          type="text"
          value={value.alias}
          onChange={(e) => update({ alias: e.target.value })}
          placeholder="Optional alias"
          disabled={disabled}
          className="input"
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
