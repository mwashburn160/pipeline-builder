import { FormStage, FormStep, FormNetworkConfig, FormPluginOptions, MetadataEntry, EnvEntry, createEmptyNetworkConfig, createEmptyPlugin } from '@/types/form-types';
import CollapsibleSection from '../editors/CollapsibleSection';
import PluginOptionsEditor from '../editors/PluginOptionsEditor';
import NetworkConfigEditor from '../editors/NetworkConfigEditor';
import MetadataEditor from '../editors/MetadataEditor';
import StringArrayEditor from '../editors/StringArrayEditor';
import EnvEditor from '../editors/EnvEditor';

interface StagesSectionProps {
  stages: FormStage[];
  onAddStage: () => void;
  onRemoveStage: (index: number) => void;
  onStageFieldChange: (index: number, field: 'stageName' | 'alias', value: string) => void;
  onAddStep: (stageIndex: number) => void;
  onRemoveStep: (stageIndex: number, stepIndex: number) => void;
  onStepChange: (stageIndex: number, stepIndex: number, step: FormStep) => void;
  disabled?: boolean;
  errors?: Record<string, string>;
}

function StepEditor({
  step, onChange, disabled, errorPrefix, errors = {},
}: {
  step: FormStep;
  onChange: (step: FormStep) => void;
  disabled?: boolean;
  errorPrefix: string;
  errors?: Record<string, string>;
}) {
  const updatePosition = (position: 'pre' | 'post') => onChange({ ...step, position });
  const updatePlugin = (plugin: FormPluginOptions) => onChange({ ...step, plugin });
  const updateMetadata = (metadata: MetadataEntry[]) => onChange({ ...step, metadata });
  const updateNetworkType = (networkType: FormStep['networkType']) => onChange({ ...step, networkType });
  const updateNetwork = (network: FormNetworkConfig) => onChange({ ...step, network });
  const updateCommands = (field: 'preInstallCommands' | 'postInstallCommands' | 'preCommands' | 'postCommands', value: string[]) =>
    onChange({ ...step, [field]: value });
  const updateEnv = (env: EnvEntry[]) => onChange({ ...step, env });

  return (
    <div className="space-y-3">
      <div>
        <label className="label">Step Position</label>
        <select
          value={step.position}
          onChange={(e) => updatePosition(e.target.value as 'pre' | 'post')}
          disabled={disabled}
          className="input"
        >
          <option value="pre">Pre (before deployment)</option>
          <option value="post">Post (after deployment)</option>
        </select>
      </div>

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
    </div>
  );
}

export default function StagesSection({
  stages, onAddStage, onRemoveStage, onStageFieldChange,
  onAddStep, onRemoveStep, onStepChange, disabled, errors = {},
}: StagesSectionProps) {
  return (
    <CollapsibleSection title={`Pipeline Stages (${stages.length})`} hasContent={stages.length > 0}>
      <div className="mt-3 space-y-4">
        {stages.map((stage, stageIdx) => (
          <div key={stageIdx} className="border border-gray-300 dark:border-gray-600 rounded-xl p-4">
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-sm font-medium text-gray-800 dark:text-gray-200">Stage {stageIdx + 1}</h4>
              <button
                type="button"
                onClick={() => onRemoveStage(stageIdx)}
                disabled={disabled}
                className="text-red-500 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 text-sm transition-colors"
              >
                Remove Stage
              </button>
            </div>

            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="label">Stage Name *</label>
                  <input
                    type="text"
                    value={stage.stageName}
                    onChange={(e) => onStageFieldChange(stageIdx, 'stageName', e.target.value)}
                    placeholder="deploy"
                    disabled={disabled}
                    className="input"
                  />
                  {errors[`stages.${stageIdx}.stageName`] && (
                    <p className="mt-1 text-xs text-red-600 dark:text-red-400">{errors[`stages.${stageIdx}.stageName`]}</p>
                  )}
                </div>
                <div>
                  <label className="label">Alias</label>
                  <input
                    type="text"
                    value={stage.alias}
                    onChange={(e) => onStageFieldChange(stageIdx, 'alias', e.target.value)}
                    placeholder="Optional alias"
                    disabled={disabled}
                    className="input"
                  />
                </div>
              </div>

              {errors[`stages.${stageIdx}.steps`] && (
                <p className="text-xs text-red-600 dark:text-red-400">{errors[`stages.${stageIdx}.steps`]}</p>
              )}

              <div className="space-y-3">
                <h5 className="text-sm font-medium text-gray-700 dark:text-gray-300">Steps ({stage.steps.length})</h5>
                {stage.steps.map((step, stepIdx) => (
                  <div key={stepIdx} className="border border-gray-200 dark:border-gray-700 rounded-xl p-3 bg-gray-50 dark:bg-gray-800/50">
                    <div className="flex items-center justify-between mb-3">
                      <span className="text-xs font-medium text-gray-600 dark:text-gray-400">Step {stepIdx + 1}</span>
                      <button
                        type="button"
                        onClick={() => onRemoveStep(stageIdx, stepIdx)}
                        disabled={disabled}
                        className="text-red-500 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 text-xs transition-colors"
                      >
                        Remove Step
                      </button>
                    </div>
                    <StepEditor
                      step={step}
                      onChange={(updated) => onStepChange(stageIdx, stepIdx, updated)}
                      disabled={disabled}
                      errorPrefix={`stages.${stageIdx}.steps.${stepIdx}`}
                      errors={errors}
                    />
                  </div>
                ))}
              </div>

              <button
                type="button"
                onClick={() => onAddStep(stageIdx)}
                disabled={disabled}
                className="text-sm text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 transition-colors"
              >
                + Add Step
              </button>
            </div>
          </div>
        ))}

        <button
          type="button"
          onClick={onAddStage}
          disabled={disabled}
          className="w-full py-2 border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-xl text-sm text-gray-600 dark:text-gray-400 hover:border-blue-400 dark:hover:border-blue-500 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
        >
          + Add Stage
        </button>
      </div>
    </CollapsibleSection>
  );
}
