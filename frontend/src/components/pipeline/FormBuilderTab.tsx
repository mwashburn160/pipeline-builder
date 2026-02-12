import { useImperativeHandle, forwardRef, useRef } from 'react';
import { BuilderProps } from '@/types';
import { FormBuilderState } from '@/types/form-types';
import { propsToFormState } from '@/types/props-converter';
import { useFormBuilderState } from './useFormBuilderState';
import PipelineConfigSection from './sections/PipelineConfigSection';
import SynthSection from './sections/SynthSection';
import DefaultsSection from './sections/DefaultsSection';
import RoleSection from './sections/RoleSection';
import StagesSection from './sections/StagesSection';
import CollapsibleSection from './editors/CollapsibleSection';
import MetadataEditor from './editors/MetadataEditor';

export interface FormBuilderTabRef {
  getProps: () => BuilderProps | null;
  getDescription: () => string;
  getKeywords: () => string;
}

interface FormBuilderTabProps {
  disabled?: boolean;
  initialProps?: BuilderProps;
  initialDescription?: string;
  initialKeywords?: string;
}

const FormBuilderTab = forwardRef<FormBuilderTabRef, FormBuilderTabProps>(
  ({ disabled, initialProps, initialDescription, initialKeywords }, ref) => {
    const initialStateRef = useRef<FormBuilderState | undefined>(
      initialProps
        ? {
            ...propsToFormState(initialProps as unknown as Record<string, unknown>),
            description: initialDescription ?? '',
            keywords: initialKeywords ?? '',
          }
        : undefined,
    );
    const initialState = initialStateRef.current;

    const { state, dispatch, validationErrors, assembleBuilderProps } = useFormBuilderState(initialState);

    useImperativeHandle(ref, () => ({
      getProps: (): BuilderProps | null => {
        return assembleBuilderProps();
      },
      getDescription: () => state.description,
      getKeywords: () => state.keywords,
    }));

    return (
      <div className="space-y-6">
        {/* Section: Pipeline Configuration (non-collapsible) */}
        <PipelineConfigSection
          project={state.project}
          organization={state.organization}
          pipelineName={state.pipelineName}
          description={state.description}
          keywords={state.keywords}
          onProjectChange={(v) => dispatch({ type: 'SET_CORE', field: 'project', value: v })}
          onOrganizationChange={(v) => dispatch({ type: 'SET_CORE', field: 'organization', value: v })}
          onPipelineNameChange={(v) => dispatch({ type: 'SET_CORE', field: 'pipelineName', value: v })}
          onDescriptionChange={(v) => dispatch({ type: 'SET_DESCRIPTION', value: v })}
          onKeywordsChange={(v) => dispatch({ type: 'SET_KEYWORDS', value: v })}
          disabled={disabled}
          errors={validationErrors}
        >
          <CollapsibleSection title="Global Metadata" hasContent={state.global.length > 0}>
            <div className="mt-3">
              <MetadataEditor
                value={state.global}
                onChange={(v) => dispatch({ type: 'SET_GLOBAL_METADATA', value: v })}
                disabled={disabled}
              />
            </div>
          </CollapsibleSection>

          <DefaultsSection
            defaults={state.defaults}
            onEnabledChange={(v) => dispatch({ type: 'SET_DEFAULTS_ENABLED', value: v })}
            onNetworkTypeChange={(v) => dispatch({ type: 'SET_DEFAULTS_NETWORK_TYPE', value: v })}
            onNetworkChange={(v) => dispatch({ type: 'SET_DEFAULTS_NETWORK', value: v })}
            onSGTypeChange={(v) => dispatch({ type: 'SET_DEFAULTS_SG_TYPE', value: v })}
            onSGChange={(v) => dispatch({ type: 'SET_DEFAULTS_SG', value: v })}
            onMetadataChange={(v) => dispatch({ type: 'SET_DEFAULTS_METADATA', value: v })}
            disabled={disabled}
          />

          <RoleSection
            role={state.role}
            onTypeChange={(v) => dispatch({ type: 'SET_ROLE_TYPE', value: v })}
            onFieldChange={(field, value) => dispatch({ type: 'SET_ROLE_FIELD', field, value })}
            onMutableChange={(v) => dispatch({ type: 'SET_ROLE_MUTABLE', value: v })}
            disabled={disabled}
            errors={validationErrors}
          />
        </PipelineConfigSection>

        {/* Section: Synth Configuration (collapsible) */}
        <SynthSection
          synth={state.synth}
          onSourceTypeChange={(v) => dispatch({ type: 'SET_SYNTH_SOURCE_TYPE', value: v })}
          onS3Change={(field, value) => dispatch({ type: 'SET_SYNTH_S3', field, value })}
          onGithubChange={(field, value) => dispatch({ type: 'SET_SYNTH_GITHUB', field, value })}
          onCodestarChange={(field, value) => dispatch({ type: 'SET_SYNTH_CODESTAR', field, value })}
          onPluginChange={(v) => dispatch({ type: 'SET_SYNTH_PLUGIN', value: v })}
          onMetadataChange={(v) => dispatch({ type: 'SET_SYNTH_METADATA', value: v })}
          onNetworkTypeChange={(v) => dispatch({ type: 'SET_SYNTH_NETWORK_TYPE', value: v })}
          onNetworkChange={(v) => dispatch({ type: 'SET_SYNTH_NETWORK', value: v })}
          disabled={disabled}
          errors={validationErrors}
        />

        {/* Section: Stages (collapsible) */}
        <StagesSection
          stages={state.stages}
          onAddStage={() => dispatch({ type: 'ADD_STAGE' })}
          onRemoveStage={(index) => dispatch({ type: 'REMOVE_STAGE', index })}
          onStageFieldChange={(index, field, value) => dispatch({ type: 'SET_STAGE_FIELD', index, field, value })}
          onAddStep={(stageIndex) => dispatch({ type: 'ADD_STEP', stageIndex })}
          onRemoveStep={(stageIndex, stepIndex) => dispatch({ type: 'REMOVE_STEP', stageIndex, stepIndex })}
          onStepChange={(stageIndex, stepIndex, step) => dispatch({ type: 'SET_STEP', stageIndex, stepIndex, step })}
          disabled={disabled}
          errors={validationErrors}
        />

        {Object.keys(validationErrors).length > 0 && (
          <div className="alert-error">
            <p className="font-medium">
              Please fix {Object.keys(validationErrors).length} validation error(s) above.
            </p>
          </div>
        )}
      </div>
    );
  }
);

FormBuilderTab.displayName = 'FormBuilderTab';
export default FormBuilderTab;
