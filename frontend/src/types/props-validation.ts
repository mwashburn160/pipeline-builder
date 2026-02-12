/**
 * @module props-validation
 * @description Validates FormBuilderState and returns a map of field-path to error messages.
 */

import { FormBuilderState } from './form-types';

/**
 * Validate form state and return a map of field-path -> error message.
 * Pure function — no side effects.
 */
export function validateFormState(state: FormBuilderState): Record<string, string> {
  const errors: Record<string, string> = {};

  if (!state.project.trim()) errors['project'] = 'Project is required';
  if (!state.organization.trim()) errors['organization'] = 'Organization is required';

  // Synth source
  switch (state.synth.sourceType) {
    case 's3':
      if (!state.synth.s3.bucketName.trim()) errors['synth.s3.bucketName'] = 'Bucket name is required';
      break;
    case 'github':
      if (!state.synth.github.repo.trim()) errors['synth.github.repo'] = 'Repository is required';
      else if (!state.synth.github.repo.includes('/')) errors['synth.github.repo'] = 'Format: owner/repo';
      break;
    case 'codestar':
      if (!state.synth.codestar.repo.trim()) errors['synth.codestar.repo'] = 'Repository is required';
      if (!state.synth.codestar.connectionArn.trim()) errors['synth.codestar.connectionArn'] = 'Connection ARN is required';
      break;
  }

  if (!state.synth.plugin.name.trim()) errors['synth.plugin.name'] = 'Plugin name is required';

  // Role
  if (state.role.type === 'roleArn' && !state.role.roleArn.trim()) errors['role.roleArn'] = 'Role ARN is required';
  if (state.role.type === 'roleName' && !state.role.roleName.trim()) errors['role.roleName'] = 'Role name is required';

  // Stages
  for (let i = 0; i < state.stages.length; i++) {
    const stage = state.stages[i];
    if (!stage.stageName.trim()) errors[`stages.${i}.stageName`] = 'Stage name is required';
    if (stage.steps.length === 0) errors[`stages.${i}.steps`] = 'Stage must have at least one step';
    for (let j = 0; j < stage.steps.length; j++) {
      if (!stage.steps[j].plugin.name.trim()) {
        errors[`stages.${i}.steps.${j}.plugin.name`] = 'Plugin name is required';
      }
    }
  }

  return errors;
}
