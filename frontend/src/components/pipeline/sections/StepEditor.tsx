import { FormStep, FormNetworkConfig, FormPluginOptions, MetadataEntry, EnvEntry } from '@/types/form-types';
import { FormField } from '@/components/ui/FormField';
import CollapsibleSection from '../editors/CollapsibleSection';
import PluginOptionsEditor from '../editors/PluginOptionsEditor';
import NetworkConfigEditor from '../editors/NetworkConfigEditor';
import MetadataEditor from '../editors/MetadataEditor';
import StringArrayEditor from '../editors/StringArrayEditor';
import EnvEditor from '../editors/EnvEditor';

export interface StepEditorProps {
  step: FormStep;
  onChange: (step: FormStep) => void;
  disabled?: boolean;
  errorPrefix: string;
  errors?: Record<string, string>;
}

export default function StepEditor({
  step, onChange, disabled, errorPrefix, errors = {},
}: StepEditorProps) {
  const updatePosition = (position: 'pre' | 'post') => onChange({ ...step, position });
  const updatePlugin = (plugin: FormPluginOptions) => onChange({ ...step, plugin });
  const updateMetadata = (metadata: MetadataEntry[]) => onChange({ ...step, metadata });
  const updateNetworkType = (networkType: FormStep['networkType']) => onChange({ ...step, networkType });
  const updateNetwork = (network: FormNetworkConfig) => onChange({ ...step, network });
  const updateCommands = (field: 'preInstallCommands' | 'postInstallCommands' | 'preCommands' | 'postCommands', value: string[]) =>
    onChange({ ...step, [field]: value });
  const updateEnv = (env: EnvEntry[]) => onChange({ ...step, env });
  const updateInputArtifact = (inputArtifact: string) => onChange({ ...step, inputArtifact });
  const updateAdditionalInput = (index: number, field: 'path' | 'key', value: string) => {
    const updated = step.additionalInputArtifacts.map((a, i) => i === index ? { ...a, [field]: value } : a);
    onChange({ ...step, additionalInputArtifacts: updated });
  };
  const addAdditionalInput = () => onChange({ ...step, additionalInputArtifacts: [...step.additionalInputArtifacts, { path: '', key: '' }] });
  const removeAdditionalInput = (index: number) => onChange({ ...step, additionalInputArtifacts: step.additionalInputArtifacts.filter((_, i) => i !== index) });

  return (
    <div className="space-y-3">
      <FormField label="Step Position">
        <select
          value={step.position}
          onChange={(e) => updatePosition(e.target.value as 'pre' | 'post')}
          disabled={disabled}
          className="input"
        >
          <option value="pre">Pre (before deployment)</option>
          <option value="post">Post (after deployment)</option>
        </select>
      </FormField>

      <PluginOptionsEditor
        value={step.plugin}
        onChange={updatePlugin}
        disabled={disabled}
        error={errors[`${errorPrefix}.plugin.name`]}
        label="Step Plugin"
      />

      <CollapsibleSection title="Step Metadata" hasContent={step.metadata.length > 0}>
        <div className="mt-3">
          <MetadataEditor value={step.metadata} onChange={updateMetadata} disabled={disabled} />
        </div>
      </CollapsibleSection>

      <CollapsibleSection title="Step Network" hasContent={step.networkType !== 'none'}>
        <div className="mt-3">
          <NetworkConfigEditor
            networkType={step.networkType}
            network={step.network}
            onTypeChange={updateNetworkType}
            onNetworkChange={updateNetwork}
            disabled={disabled}
          />
        </div>
      </CollapsibleSection>

      <CollapsibleSection title="Pre-Install Commands" hasContent={step.preInstallCommands.length > 0}>
        <div className="mt-3">
          <StringArrayEditor
            value={step.preInstallCommands}
            onChange={(val) => updateCommands('preInstallCommands', val)}
            placeholder="npm ci"
            disabled={disabled}
            addLabel="+ Add Command"
          />
        </div>
      </CollapsibleSection>

      <CollapsibleSection title="Post-Install Commands" hasContent={step.postInstallCommands.length > 0}>
        <div className="mt-3">
          <StringArrayEditor
            value={step.postInstallCommands}
            onChange={(val) => updateCommands('postInstallCommands', val)}
            placeholder="npm run build"
            disabled={disabled}
            addLabel="+ Add Command"
          />
        </div>
      </CollapsibleSection>

      <CollapsibleSection title="Pre-Commands" hasContent={step.preCommands.length > 0}>
        <div className="mt-3">
          <StringArrayEditor
            value={step.preCommands}
            onChange={(val) => updateCommands('preCommands', val)}
            placeholder="echo 'starting...'"
            disabled={disabled}
            addLabel="+ Add Command"
          />
        </div>
      </CollapsibleSection>

      <CollapsibleSection title="Post-Commands" hasContent={step.postCommands.length > 0}>
        <div className="mt-3">
          <StringArrayEditor
            value={step.postCommands}
            onChange={(val) => updateCommands('postCommands', val)}
            placeholder="echo 'done!'"
            disabled={disabled}
            addLabel="+ Add Command"
          />
        </div>
      </CollapsibleSection>

      <CollapsibleSection title="Environment Variables" hasContent={step.env.length > 0}>
        <div className="mt-3">
          <EnvEditor value={step.env} onChange={updateEnv} disabled={disabled} />
        </div>
      </CollapsibleSection>

      <CollapsibleSection title="Inputs" hasContent={!!step.inputArtifact || step.additionalInputArtifacts.length > 0}>
        <div className="mt-3 space-y-3">
          <FormField label="Primary Input Artifact" hint="Colon-delimited artifact key from a previous step">
            <input
              type="text"
              value={step.inputArtifact}
              onChange={(e) => updateInputArtifact(e.target.value)}
              placeholder="stageName:stageAlias:pluginName:pluginAlias:outputDir"
              disabled={disabled}
              className="input"
            />
          </FormField>

          <div>
            <label className="label">Additional Input Artifacts</label>
            <div className="space-y-2">
              {step.additionalInputArtifacts.map((entry, idx) => (
                <div key={idx} className="flex gap-2 items-center">
                  <input
                    type="text"
                    value={entry.path}
                    onChange={(e) => updateAdditionalInput(idx, 'path', e.target.value)}
                    placeholder="mount/path"
                    disabled={disabled}
                    className="input flex-1"
                  />
                  <input
                    type="text"
                    value={entry.key}
                    onChange={(e) => updateAdditionalInput(idx, 'key', e.target.value)}
                    placeholder="stageName:stageAlias:pluginName:pluginAlias:outputDir"
                    disabled={disabled}
                    className="input flex-[2]"
                  />
                  <button
                    type="button"
                    onClick={() => removeAdditionalInput(idx)}
                    disabled={disabled}
                    className="text-red-500 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 text-sm transition-colors"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={addAdditionalInput}
              disabled={disabled}
              className="mt-2 text-sm text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 transition-colors"
            >
              + Add Additional Input
            </button>
          </div>
        </div>
      </CollapsibleSection>
    </div>
  );
}
