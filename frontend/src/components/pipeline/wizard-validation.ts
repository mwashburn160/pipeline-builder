import { FormBuilderState } from '@/types/form-types';
import { validateFormState } from '@/types/props-converter';

export const WIZARD_STEPS = [
  { label: 'Pipeline Configuration', shortLabel: 'Pipeline' },
  { label: 'Synth Configuration', shortLabel: 'Synth' },
  { label: 'Stages', shortLabel: 'Stages' },
] as const;

const STEP_PREFIXES: string[][] = [
  ['project', 'organization', 'role'],
  ['synth'],
  ['stages'],
];

/**
 * Validate form state and return only errors for the specified wizard step.
 */
export function validateStep(
  state: FormBuilderState,
  stepIndex: number,
): Record<string, string> {
  const allErrors = validateFormState(state);
  const prefixes = STEP_PREFIXES[stepIndex];
  if (!prefixes) return {};

  return Object.fromEntries(
    Object.entries(allErrors).filter(([key]) =>
      prefixes.some((prefix) => key === prefix || key.startsWith(prefix + '.'))
    )
  );
}

/**
 * Returns status for each wizard step based on current form state and which steps have been visited.
 */
export function getStepStatuses(
  state: FormBuilderState,
  visitedSteps: Set<number>,
): Record<number, 'valid' | 'error' | 'untouched'> {
  const allErrors = validateFormState(state);
  const result: Record<number, 'valid' | 'error' | 'untouched'> = {};

  for (let i = 0; i < STEP_PREFIXES.length; i++) {
    if (!visitedSteps.has(i)) {
      result[i] = 'untouched';
      continue;
    }
    const hasErrors = Object.keys(allErrors).some((key) =>
      STEP_PREFIXES[i].some((prefix) => key === prefix || key.startsWith(prefix + '.'))
    );
    result[i] = hasErrors ? 'error' : 'valid';
  }
  return result;
}
