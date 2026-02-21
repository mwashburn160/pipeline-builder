import { validateFormState } from '../src/types/props-validation';
import { createInitialFormState, createEmptyStep, createEmptyPlugin } from '../src/types/form-types';
import type { FormBuilderState } from '../src/types/form-types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function validState(): FormBuilderState {
  const state = createInitialFormState();
  state.project = 'my-project';
  state.organization = 'my-org';
  state.synth.sourceType = 'github';
  state.synth.github.repo = 'owner/repo';
  state.synth.plugin.name = 'synth-plugin';
  return state;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('validateFormState', () => {
  it('should return no errors for valid state', () => {
    const errors = validateFormState(validState());
    expect(Object.keys(errors)).toHaveLength(0);
  });

  it('should require project', () => {
    const state = validState();
    state.project = '';
    const errors = validateFormState(state);
    expect(errors['project']).toBe('Project is required');
  });

  it('should require organization', () => {
    const state = validState();
    state.organization = '  ';
    const errors = validateFormState(state);
    expect(errors['organization']).toBe('Organization is required');
  });

  describe('synth source validation', () => {
    it('should require s3 bucket name', () => {
      const state = validState();
      state.synth.sourceType = 's3';
      state.synth.s3.bucketName = '';
      const errors = validateFormState(state);
      expect(errors['synth.s3.bucketName']).toBe('Bucket name is required');
    });

    it('should require github repo', () => {
      const state = validState();
      state.synth.sourceType = 'github';
      state.synth.github.repo = '';
      const errors = validateFormState(state);
      expect(errors['synth.github.repo']).toBe('Repository is required');
    });

    it('should require github repo format owner/repo', () => {
      const state = validState();
      state.synth.sourceType = 'github';
      state.synth.github.repo = 'invalid-repo';
      const errors = validateFormState(state);
      expect(errors['synth.github.repo']).toBe('Format: owner/repo');
    });

    it('should accept valid github repo format', () => {
      const state = validState();
      state.synth.sourceType = 'github';
      state.synth.github.repo = 'owner/repo';
      const errors = validateFormState(state);
      expect(errors['synth.github.repo']).toBeUndefined();
    });

    it('should require codestar repo', () => {
      const state = validState();
      state.synth.sourceType = 'codestar';
      state.synth.codestar.repo = '';
      state.synth.codestar.connectionArn = 'arn:aws:codestar:us-east-1:123:connection/abc';
      const errors = validateFormState(state);
      expect(errors['synth.codestar.repo']).toBe('Repository is required');
    });

    it('should require codestar connection ARN', () => {
      const state = validState();
      state.synth.sourceType = 'codestar';
      state.synth.codestar.repo = 'my-repo';
      state.synth.codestar.connectionArn = '';
      const errors = validateFormState(state);
      expect(errors['synth.codestar.connectionArn']).toBe('Connection ARN is required');
    });
  });

  it('should require synth plugin name', () => {
    const state = validState();
    state.synth.plugin.name = '';
    const errors = validateFormState(state);
    expect(errors['synth.plugin.name']).toBe('Plugin name is required');
  });

  describe('role validation', () => {
    it('should require roleArn when type is roleArn', () => {
      const state = validState();
      state.role.type = 'roleArn';
      state.role.roleArn = '';
      const errors = validateFormState(state);
      expect(errors['role.roleArn']).toBe('Role ARN is required');
    });

    it('should require roleName when type is roleName', () => {
      const state = validState();
      state.role.type = 'roleName';
      state.role.roleName = '';
      const errors = validateFormState(state);
      expect(errors['role.roleName']).toBe('Role name is required');
    });

    it('should not require role when type is none', () => {
      const state = validState();
      state.role.type = 'none';
      const errors = validateFormState(state);
      expect(errors['role.roleArn']).toBeUndefined();
      expect(errors['role.roleName']).toBeUndefined();
    });
  });

  describe('stage validation', () => {
    it('should require stage name', () => {
      const state = validState();
      const step = createEmptyStep();
      step.plugin.name = 'test-plugin';
      state.stages = [{ stageName: '', alias: '', steps: [step] }];
      const errors = validateFormState(state);
      expect(errors['stages.0.stageName']).toBe('Stage name is required');
    });

    it('should require at least one step per stage', () => {
      const state = validState();
      state.stages = [{ stageName: 'build', alias: '', steps: [] }];
      const errors = validateFormState(state);
      expect(errors['stages.0.steps']).toBe('Stage must have at least one step');
    });

    it('should require plugin name in steps', () => {
      const state = validState();
      const step = createEmptyStep();
      step.plugin = createEmptyPlugin();
      state.stages = [{ stageName: 'build', alias: '', steps: [step] }];
      const errors = validateFormState(state);
      expect(errors['stages.0.steps.0.plugin.name']).toBe('Plugin name is required');
    });

    it('should validate multiple stages and steps', () => {
      const state = validState();
      const step1 = createEmptyStep();
      step1.plugin.name = 'plugin-a';
      const step2 = createEmptyStep();
      // step2 has empty plugin name

      state.stages = [
        { stageName: 'build', alias: '', steps: [step1] },
        { stageName: '', alias: '', steps: [step2] },
      ];
      const errors = validateFormState(state);
      expect(errors['stages.1.stageName']).toBe('Stage name is required');
      expect(errors['stages.1.steps.0.plugin.name']).toBe('Plugin name is required');
      expect(errors['stages.0.stageName']).toBeUndefined();
      expect(errors['stages.0.steps.0.plugin.name']).toBeUndefined();
    });
  });
});
