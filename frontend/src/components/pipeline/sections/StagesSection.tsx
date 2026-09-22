import { FormBuilderState, FormStage, FormStep } from '@/types/form-types';
import { type Plugin } from '@/types';
import type { CatalogEntry } from '@/types/plugin-installs';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import CollapsibleSection from '../editors/CollapsibleSection';
import StepEditor from './StepEditor';
import { computeAvailableArtifacts } from '@/lib/artifact-keys';

/** Props for {@link StagesSection}. */
interface StagesSectionProps {
  /** Current list of pipeline stages. */
  stages: FormStage[];
  /** Callback to add a new empty stage. */
  onAddStage: () => void;
  /** Callback to remove a stage at the given index. */
  onRemoveStage: (index: number) => void;
  /** Callback when a stage's name, alias, or environment changes. */
  onStageFieldChange: (index: number, field: 'stageName' | 'alias' | 'environment', value: string) => void;
  /** Callback to add a new empty step to a stage. */
  onAddStep: (stageIndex: number) => void;
  /** Callback to remove a step from a stage. */
  onRemoveStep: (stageIndex: number, stepIndex: number) => void;
  /** Callback when a step's configuration changes. */
  onStepChange: (stageIndex: number, stepIndex: number, step: FormStep) => void;
  /** Whether all inputs should be disabled. */
  disabled?: boolean;
  /** Validation errors keyed by field path (e.g. 'stages.0.stageName'). */
  errors?: Record<string, string>;
  /** Synth config for computing available artifact keys. */
  synth?: FormBuilderState['synth'];
  /** Plugin list for looking up primaryOutputDirectory. */
  plugins?: Plugin[];
  /** Catalog listings (installed / implicit Official) — their resolved primaryOutputDirectory. */
  catalog?: CatalogEntry[];
}

/**
 * Section for managing pipeline stages and their steps.
 *
 * Renders a collapsible list of stages, each containing a name/alias form,
 * a list of StepEditor instances, and add/remove controls. Computes available
 * artifact keys for each step based on the synth config and preceding stages.
 * Shown as step 3 in wizard mode.
 */
export default function StagesSection({
  stages, onAddStage, onRemoveStage, onStageFieldChange,
  onAddStep, onRemoveStep, onStepChange, disabled, errors = {},
  synth, plugins = [], catalog = [],
}: StagesSectionProps) {
  return (
    <CollapsibleSection title={`Pipeline Stages (${stages.length})`} hasContent={stages.length > 0}>
      <div className="mt-3 space-y-4">
        {stages.map((stage, stageIdx) => (
          <div key={stage.id} className="border border-default rounded-xl p-4">
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
                <FormField label="Stage name *" error={errors[`stages.${stageIdx}.stageName`]}>
                  <Input
                    type="text"
                    value={stage.stageName}
                    onChange={(e) => onStageFieldChange(stageIdx, 'stageName', e.target.value)}
                    placeholder="deploy"
                    disabled={disabled}
                  />
                </FormField>
                <FormField label="Alias">
                  <Input
                    type="text"
                    value={stage.alias}
                    onChange={(e) => onStageFieldChange(stageIdx, 'alias', e.target.value)}
                    placeholder="Optional alias"
                    disabled={disabled}
                  />
                </FormField>
              </div>

              {/* Deploy environment: when set, pipeline-core folds `<stageName>:<env>`
                  into the `pb.deploys` tag, marking this stage a deployment for DORA
                  (frequency / change-failure). Blank = not a deploy stage.
                  `production` is the DORA headline environment. */}
              <div className="grid grid-cols-2 gap-4">
                <FormField
                  label="Environment"
                  hint="Set to mark this stage a deployment (e.g. production). Blank = not a deploy stage."
                >
                  <Input
                    type="text"
                    list={`stage-environments-${stage.id}`}
                    value={stage.environment}
                    onChange={(e) => onStageFieldChange(stageIdx, 'environment', e.target.value)}
                    placeholder="e.g. production (optional)"
                    disabled={disabled}
                  />
                </FormField>
                <datalist id={`stage-environments-${stage.id}`}>
                  {['production', 'staging', 'development', 'preview', 'qa'].map((env) => (
                    <option key={env} value={env} />
                  ))}
                </datalist>
              </div>

              {errors[`stages.${stageIdx}.steps`] && (
                <p className="text-xs text-red-600 dark:text-red-400">{errors[`stages.${stageIdx}.steps`]}</p>
              )}

              <div className="space-y-3">
                <h5 className="text-sm font-medium text-fg-muted">Steps ({stage.steps.length})</h5>
                {stage.steps.map((step, stepIdx) => (
                  <div key={step.id} className="border border-default rounded-xl p-3 bg-surface-muted">
                    <div className="flex items-center justify-between mb-3">
                      <span className="text-xs font-medium text-fg-muted">Step {stepIdx + 1}</span>
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
                      availableArtifacts={synth ? computeAvailableArtifacts(synth, stages, { plugins, catalog }, stageIdx, stepIdx) : []}
                    />
                  </div>
                ))}
              </div>

              <button
                type="button"
                onClick={() => onAddStep(stageIdx)}
                disabled={disabled}
                className="text-sm text-brand hover:text-brand-strong transition-colors"
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
          className="w-full py-2 border-2 border-dashed border-default rounded-xl text-sm text-fg-muted hover:border-brand hover:text-brand transition-colors"
        >
          + Add Stage
        </button>
      </div>
    </CollapsibleSection>
  );
}
