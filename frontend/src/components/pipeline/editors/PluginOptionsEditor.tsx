import { useCallback, useId } from 'react';
import { FormPluginOptions, FormPluginFilter, createEmptyPluginFilter } from '@/types/form-types';
import type { PluginPick } from '@/lib/plugin-installs';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import CollapsibleSection from './CollapsibleSection';
import MetadataEditor from './MetadataEditor';
import PluginNameCombobox from './PluginNameCombobox';
import { PluginResolutionWarnings } from './PluginResolutionWarnings';

/** Props for {@link PluginOptionsEditor}. */
interface PluginOptionsEditorProps {
  /** Current plugin options state (name, alias, filter, metadata). */
  value: FormPluginOptions;
  /** Callback when any plugin option changes. */
  onChange: (val: FormPluginOptions) => void;
  /** Whether all inputs should be disabled. */
  disabled?: boolean;
  /** Validation error message for the plugin name field. */
  error?: string;
  /** Display label prefix (e.g. "Plugin", "Step plugin"). */
  label?: string;
}

/**
 * Editor for configuring a plugin reference within a pipeline step or synth section.
 *
 * Renders a plugin name combobox, alias field, collapsible filter section
 * (ID, org, access, version, image tag), and collapsible metadata section.
 * When a plugin is selected from the combobox, filter fields are auto-populated.
 */
export default function PluginOptionsEditor({
  value, onChange, disabled, error, label = 'Plugin',
}: PluginOptionsEditorProps) {
  const uid = useId();
  const update = (fields: Partial<FormPluginOptions>) => onChange({ ...value, ...fields });
  const updateFilter = (fields: Partial<FormPluginFilter>) =>
    update({ filter: { ...value.filter, ...fields } });

  const handlePluginSelect = useCallback((pick: PluginPick) => {
    if (pick.kind === 'listing') {
      // A listing resolves through the org's install (its version policy), so
      // the reference is just `{ publisher?, name }` — own-row filters (id,
      // orgId, visibility, …) would never match a listing and are cleared.
      const { reference } = pick.entry;
      onChange({
        ...value,
        publisher: reference.publisher ?? '',
        name: reference.name,
        filter: createEmptyPluginFilter(),
      });
      return;
    }
    const { plugin } = pick;
    onChange({
      ...value,
      publisher: '',
      name: plugin.name,
      filter: {
        ...value.filter,
        id: plugin.id,
        orgId: plugin.orgId,
        visibility: plugin.visibility,
        isDefault: String(plugin.isDefault),
        isActive: String(plugin.isActive),
        name: plugin.name,
        version: plugin.version,
      },
    });
  }, [value, onChange]);

  const hasFilter = value.filter.id !== '' || value.filter.orgId !== '' ||
    value.filter.visibility !== '' || value.filter.isDefault !== '' ||
    value.filter.isActive !== '' || value.filter.name !== '' ||
    value.filter.version !== '';

  return (
    <div className="space-y-3">
      <PluginNameCombobox
        value={value.name}
        publisher={value.publisher}
        onChange={(name) => update({ name })}
        onSelectPlugin={handlePluginSelect}
        disabled={disabled}
        label={label}
        error={error}
      />
      <PluginResolutionWarnings
        name={value.name}
        publisher={value.publisher}
        version={value.filter.version}
        id={value.filter.id}
      />
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor={`${uid}-publisher`}>{label} Publisher</label>
          <Input
            id={`${uid}-publisher`}
            type="text"
            value={value.publisher}
            onChange={(e) => update({ publisher: e.target.value.trim() })}
            placeholder="Optional (e.g. acme)"
            disabled={disabled}
          />
          <p className="mt-1 text-xs text-fg-subtle">Set to use an installed listing from that publisher only.</p>
        </div>
        <div>
          <label className="label" htmlFor={`${uid}-alias`}>{label} Alias</label>
          <Input
            id={`${uid}-alias`}
            type="text"
            value={value.alias}
            onChange={(e) => update({ alias: e.target.value })}
            placeholder="Optional alias"
            disabled={disabled}
          />
        </div>
      </div>
      <CollapsibleSection title={`${label} Filters`} hasContent={hasFilter}>
        <div className="mt-3 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor={`${uid}-plugin-id`}>Plugin ID</label>
              <Input
                id={`${uid}-plugin-id`}
                type="text"
                value={value.filter.id}
                onChange={(e) => updateFilter({ id: e.target.value })}
                placeholder="Plugin UUID"
                disabled={disabled}
              />
            </div>
            <div>
              <label className="label" htmlFor={`${uid}-org-id`}>Org ID</label>
              <Input
                id={`${uid}-org-id`}
                type="text"
                value={value.filter.orgId}
                onChange={(e) => updateFilter({ orgId: e.target.value })}
                placeholder="Organization ID"
                disabled={disabled}
              />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="label" htmlFor={`${uid}-access-modifier`}>Access modifier</label>
              <Select
                id={`${uid}-access-modifier`}
                value={value.filter.visibility}
                onChange={(e) => updateFilter({ visibility: e.target.value })}
                disabled={disabled}
              >
                <option value="">Any</option>
                <option value="public">Public</option>
                <option value="private">Private</option>
              </Select>
            </div>
            <div>
              <label className="label" htmlFor={`${uid}-is-default`}>Is default</label>
              <Select
                id={`${uid}-is-default`}
                value={value.filter.isDefault}
                onChange={(e) => updateFilter({ isDefault: e.target.value })}
                disabled={disabled}
              >
                <option value="">Any</option>
                <option value="true">Yes</option>
                <option value="false">No</option>
              </Select>
            </div>
            <div>
              <label className="label" htmlFor={`${uid}-is-active`}>Is active</label>
              <Select
                id={`${uid}-is-active`}
                value={value.filter.isActive}
                onChange={(e) => updateFilter({ isActive: e.target.value })}
                disabled={disabled}
              >
                <option value="">Any</option>
                <option value="true">Yes</option>
                <option value="false">No</option>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor={`${uid}-filter-name`}>Filter name</label>
              <Input
                id={`${uid}-filter-name`}
                type="text"
                value={value.filter.name}
                onChange={(e) => updateFilter({ name: e.target.value })}
                placeholder="Exact plugin name"
                disabled={disabled}
              />
            </div>
          </div>
          <div>
            <label className="label" htmlFor={`${uid}-version`}>Version</label>
            <Input
              id={`${uid}-version`}
              type="text"
              value={value.filter.version}
              onChange={(e) => updateFilter({ version: e.target.value })}
              placeholder="e.g. 1.0.0"
              disabled={disabled}
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
