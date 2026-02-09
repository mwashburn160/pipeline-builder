import { FormPluginOptions, FormPluginFilter } from '@/types/form-types';
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
  const updateFilter = (fields: Partial<FormPluginFilter>) =>
    update({ filter: { ...value.filter, ...fields } });

  const hasFilter = value.filter.name !== '' || value.filter.namePattern !== '' ||
    value.filter.version !== '' || value.filter.versionMin !== '' ||
    value.filter.versionMax !== '' || value.filter.imageTag !== '';

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
      <CollapsibleSection title={`${label} Filters`} hasContent={hasFilter}>
        <div className="mt-3 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Filter Name</label>
              <input
                type="text"
                value={value.filter.name}
                onChange={(e) => updateFilter({ name: e.target.value })}
                placeholder="Exact plugin name"
                disabled={disabled}
                className="input"
              />
            </div>
            <div>
              <label className="label">Name Pattern</label>
              <input
                type="text"
                value={value.filter.namePattern}
                onChange={(e) => updateFilter({ namePattern: e.target.value })}
                placeholder="e.g. nodejs-*"
                disabled={disabled}
                className="input"
              />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="label">Version</label>
              <input
                type="text"
                value={value.filter.version}
                onChange={(e) => updateFilter({ version: e.target.value })}
                placeholder="e.g. 1.0.0"
                disabled={disabled}
                className="input"
              />
            </div>
            <div>
              <label className="label">Version Min</label>
              <input
                type="text"
                value={value.filter.versionMin}
                onChange={(e) => updateFilter({ versionMin: e.target.value })}
                placeholder="e.g. 1.0.0"
                disabled={disabled}
                className="input"
              />
            </div>
            <div>
              <label className="label">Version Max</label>
              <input
                type="text"
                value={value.filter.versionMax}
                onChange={(e) => updateFilter({ versionMax: e.target.value })}
                placeholder="e.g. 2.0.0"
                disabled={disabled}
                className="input"
              />
            </div>
          </div>
          <div>
            <label className="label">Image Tag</label>
            <input
              type="text"
              value={value.filter.imageTag}
              onChange={(e) => updateFilter({ imageTag: e.target.value })}
              placeholder="Docker image tag"
              disabled={disabled}
              className="input"
            />
          </div>
        </div>
      </CollapsibleSection>
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
