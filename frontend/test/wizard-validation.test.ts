// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for wizard-validation.ts: WIZARD_STEPS, validateStep, getStepStatuses.
 */
import { WIZARD_STEPS, validateStep, getStepStatuses } from '../src/lib/wizard-validation';
import { createInitialFormState } from '../src/types/form-types';

// ---------------------------------------------------------------------------
// WIZARD_STEPS
// ---------------------------------------------------------------------------
describe('WIZARD_STEPS', () => {
  it('should have 3 steps', () => {
    expect(WIZARD_STEPS).toHaveLength(3);
  });

  it('should have labels and shortLabels for each step', () => {
    for (const step of WIZARD_STEPS) {
      expect(step.label).toBeTruthy();
      expect(step.shortLabel).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// validateStep
// ---------------------------------------------------------------------------
describe('validateStep', () => {
  it('should return pipeline errors for step 0', () => {
    const state = createInitialFormState();
    // project and organization are empty — should produce errors
    const errors = validateStep(state, 0);
    expect(errors.project).toBeDefined();
    expect(errors.organization).toBeDefined();
    // Should NOT include synth or stages errors
    expect(Object.keys(errors).some(k => k.startsWith('synth'))).toBe(false);
    expect(Object.keys(errors).some(k => k.startsWith('stages'))).toBe(false);
  });

  it('should return synth errors for step 1', () => {
    const state = createInitialFormState();
    const errors = validateStep(state, 1);
    // Should include synth-related errors (e.g. synth.plugin.name)
    expect(Object.keys(errors).some(k => k.startsWith('synth'))).toBe(true);
    // Should NOT include project/organization errors
    expect(errors.project).toBeUndefined();
    expect(errors.organization).toBeUndefined();
  });

  it('should return empty for out-of-bounds step index', () => {
    const state = createInitialFormState();
    expect(validateStep(state, 99)).toEqual({});
    expect(validateStep(state, -1)).toEqual({});
  });

  it('should return no errors for step 0 when project and org are filled', () => {
    const state = createInitialFormState();
    state.project = 'my-project';
    state.organization = 'my-org';
    const errors = validateStep(state, 0);
    expect(errors.project).toBeUndefined();
    expect(errors.organization).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getStepStatuses
// ---------------------------------------------------------------------------
describe('getStepStatuses', () => {
  it('should mark unvisited steps as untouched', () => {
    const state = createInitialFormState();
    const visited = new Set<number>();
    const statuses = getStepStatuses(state, visited);
    expect(statuses[0]).toBe('untouched');
    expect(statuses[1]).toBe('untouched');
    expect(statuses[2]).toBe('untouched');
  });

  it('should mark visited step with errors as error', () => {
    const state = createInitialFormState();
    // project/organization are empty — step 0 should have errors
    const visited = new Set([0]);
    const statuses = getStepStatuses(state, visited);
    expect(statuses[0]).toBe('error');
    expect(statuses[1]).toBe('untouched');
  });

  it('should mark visited step without errors as valid', () => {
    const state = createInitialFormState();
    state.project = 'my-project';
    state.organization = 'my-org';
    const visited = new Set([0]);
    const statuses = getStepStatuses(state, visited);
    expect(statuses[0]).toBe('valid');
  });

  it('should handle all steps visited', () => {
    const state = createInitialFormState();
    const visited = new Set([0, 1, 2]);
    const statuses = getStepStatuses(state, visited);
    // All should be either 'valid' or 'error' — none 'untouched'
    expect(statuses[0]).not.toBe('untouched');
    expect(statuses[1]).not.toBe('untouched');
    expect(statuses[2]).not.toBe('untouched');
  });
});
