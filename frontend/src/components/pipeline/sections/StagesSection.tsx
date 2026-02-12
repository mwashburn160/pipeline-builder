import { FormStage, FormStep } from '@/types/form-types';
import { FormField } from '@/components/ui/FormField';
import CollapsibleSection from '../editors/CollapsibleSection';
import StepEditor from './StepEditor';

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
                <FormField label="Stage Name *" error={errors[`stages.${stageIdx}.stageName`]}>
                  <input
                    type="text"
                    value={stage.stageName}
                    onChange={(e) => onStageFieldChange(stageIdx, 'stageName', e.target.value)}
                    placeholder="deploy"
                    disabled={disabled}
                    className="input"
                  />
                </FormField>
                <FormField label="Alias">
                  <input
                    type="text"
                    value={stage.alias}
                    onChange={(e) => onStageFieldChange(stageIdx, 'alias', e.target.value)}
                    placeholder="Optional alias"
                    disabled={disabled}
                    className="input"
                  />
                </FormField>
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
