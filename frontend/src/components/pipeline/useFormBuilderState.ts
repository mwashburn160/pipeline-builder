import { useReducer, useCallback, useState } from 'react';
import {
  FormBuilderState,
  FormNetworkConfig,
  FormSecurityGroupConfig,
  FormPluginOptions,
  FormStep,
  MetadataEntry,
  createInitialFormState,
  createEmptyStep,
  createEmptyStage,
} from '@/types/form-types';
import type { BuilderProps } from '@/types';
import { assembleBuilderProps as assembleProps } from '@/types/props-converter';

// ─── Action Types ──────────────────────────────────────────────

type Action =
  | { type: 'SET_CORE'; field: 'project' | 'organization' | 'pipelineName'; value: string }
  | { type: 'SET_DESCRIPTION'; value: string }
  | { type: 'SET_KEYWORDS'; value: string }
  | { type: 'SET_GLOBAL_METADATA'; value: MetadataEntry[] }
  // Defaults
  | { type: 'SET_DEFAULTS_ENABLED'; value: boolean }
  | { type: 'SET_DEFAULTS_NETWORK_TYPE'; value: FormBuilderState['defaults']['networkType'] }
  | { type: 'SET_DEFAULTS_NETWORK'; value: FormNetworkConfig }
  | { type: 'SET_DEFAULTS_SG_TYPE'; value: FormBuilderState['defaults']['securityGroupType'] }
  | { type: 'SET_DEFAULTS_SG'; value: FormSecurityGroupConfig }
  | { type: 'SET_DEFAULTS_METADATA'; value: MetadataEntry[] }
  // Role
  | { type: 'SET_ROLE_TYPE'; value: FormBuilderState['role']['type'] }
  | { type: 'SET_ROLE_FIELD'; field: 'roleArn' | 'roleName'; value: string }
  | { type: 'SET_ROLE_MUTABLE'; value: boolean }
  // Synth source
  | { type: 'SET_SYNTH_SOURCE_TYPE'; value: FormBuilderState['synth']['sourceType'] }
  | { type: 'SET_SYNTH_S3'; field: string; value: string }
  | { type: 'SET_SYNTH_GITHUB'; field: string; value: string }
  | { type: 'SET_SYNTH_CODESTAR'; field: string; value: string | boolean }
  // Synth plugin, metadata, network
  | { type: 'SET_SYNTH_PLUGIN'; value: FormPluginOptions }
  | { type: 'SET_SYNTH_METADATA'; value: MetadataEntry[] }
  | { type: 'SET_SYNTH_NETWORK_TYPE'; value: FormBuilderState['synth']['networkType'] }
  | { type: 'SET_SYNTH_NETWORK'; value: FormNetworkConfig }
  // Stages
  | { type: 'ADD_STAGE' }
  | { type: 'REMOVE_STAGE'; index: number }
  | { type: 'SET_STAGE_FIELD'; index: number; field: 'stageName' | 'alias'; value: string }
  | { type: 'ADD_STEP'; stageIndex: number }
  | { type: 'REMOVE_STEP'; stageIndex: number; stepIndex: number }
  | { type: 'SET_STEP'; stageIndex: number; stepIndex: number; step: FormStep }
  // Reset
  | { type: 'RESET' };

// ─── Reducer ───────────────────────────────────────────────────

function formReducer(state: FormBuilderState, action: Action): FormBuilderState {
  switch (action.type) {
    case 'SET_CORE': {
      const updated = { ...state, [action.field]: action.value };
      // Auto-generate pipelineName when project or organization changes (not when pipelineName is edited directly)
      if (action.field === 'project' || action.field === 'organization') {
        const org = action.field === 'organization' ? action.value : state.organization;
        const proj = action.field === 'project' ? action.value : state.project;
        updated.pipelineName = org && proj ? `${org}-${proj}-pipeline` : '';
      }
      return updated;
    }

    case 'SET_DESCRIPTION':
      return { ...state, description: action.value };

    case 'SET_KEYWORDS':
      return { ...state, keywords: action.value };

    case 'SET_GLOBAL_METADATA':
      return { ...state, global: action.value };

    // Defaults
    case 'SET_DEFAULTS_ENABLED':
      return { ...state, defaults: { ...state.defaults, enabled: action.value } };
    case 'SET_DEFAULTS_NETWORK_TYPE':
      return { ...state, defaults: { ...state.defaults, networkType: action.value } };
    case 'SET_DEFAULTS_NETWORK':
      return { ...state, defaults: { ...state.defaults, network: action.value } };
    case 'SET_DEFAULTS_SG_TYPE':
      return { ...state, defaults: { ...state.defaults, securityGroupType: action.value } };
    case 'SET_DEFAULTS_SG':
      return { ...state, defaults: { ...state.defaults, securityGroup: action.value } };
    case 'SET_DEFAULTS_METADATA':
      return { ...state, defaults: { ...state.defaults, metadata: action.value } };

    // Role
    case 'SET_ROLE_TYPE':
      return { ...state, role: { ...state.role, type: action.value } };
    case 'SET_ROLE_FIELD':
      return { ...state, role: { ...state.role, [action.field]: action.value } };
    case 'SET_ROLE_MUTABLE':
      return { ...state, role: { ...state.role, mutable: action.value } };

    // Synth source
    case 'SET_SYNTH_SOURCE_TYPE':
      return { ...state, synth: { ...state.synth, sourceType: action.value } };
    case 'SET_SYNTH_S3':
      return { ...state, synth: { ...state.synth, s3: { ...state.synth.s3, [action.field]: action.value } } };
    case 'SET_SYNTH_GITHUB':
      return { ...state, synth: { ...state.synth, github: { ...state.synth.github, [action.field]: action.value } } };
    case 'SET_SYNTH_CODESTAR':
      return { ...state, synth: { ...state.synth, codestar: { ...state.synth.codestar, [action.field]: action.value } } };

    // Synth plugin, metadata, network
    case 'SET_SYNTH_PLUGIN':
      return { ...state, synth: { ...state.synth, plugin: action.value } };
    case 'SET_SYNTH_METADATA':
      return { ...state, synth: { ...state.synth, metadata: action.value } };
    case 'SET_SYNTH_NETWORK_TYPE':
      return { ...state, synth: { ...state.synth, networkType: action.value } };
    case 'SET_SYNTH_NETWORK':
      return { ...state, synth: { ...state.synth, network: action.value } };

    // Stages
    case 'ADD_STAGE':
      return { ...state, stages: [...state.stages, createEmptyStage()] };
    case 'REMOVE_STAGE':
      return { ...state, stages: state.stages.filter((_, i) => i !== action.index) };
    case 'SET_STAGE_FIELD': {
      const stages = [...state.stages];
      stages[action.index] = { ...stages[action.index], [action.field]: action.value };
      return { ...state, stages };
    }
    case 'ADD_STEP': {
      const stages = [...state.stages];
      stages[action.stageIndex] = {
        ...stages[action.stageIndex],
        steps: [...stages[action.stageIndex].steps, createEmptyStep()],
      };
      return { ...state, stages };
    }
    case 'REMOVE_STEP': {
      const stages = [...state.stages];
      stages[action.stageIndex] = {
        ...stages[action.stageIndex],
        steps: stages[action.stageIndex].steps.filter((_, i) => i !== action.stepIndex),
      };
      return { ...state, stages };
    }
    case 'SET_STEP': {
      const stages = [...state.stages];
      const steps = [...stages[action.stageIndex].steps];
      steps[action.stepIndex] = action.step;
      stages[action.stageIndex] = { ...stages[action.stageIndex], steps };
      return { ...state, stages };
    }

    case 'RESET':
      return createInitialFormState();

    default:
      return state;
  }
}

// ─── Hook ──────────────────────────────────────────────────────

export function useFormBuilderState(initialState?: FormBuilderState) {
  const [state, dispatch] = useReducer(
    formReducer,
    initialState,
    (init) => init ?? createInitialFormState(),
  );
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});

  const assembleBuilderProps = useCallback((): BuilderProps | null => {
    const { props, errors } = assembleProps(state);
    setValidationErrors(errors);
    return props;
  }, [state]);

  const reset = useCallback(() => {
    dispatch({ type: 'RESET' });
    setValidationErrors({});
  }, []);

  return {
    state,
    dispatch,
    validationErrors,
    assembleBuilderProps,
    reset,
  };
}
