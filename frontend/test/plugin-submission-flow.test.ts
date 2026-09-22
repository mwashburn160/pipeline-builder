// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The `/plugins/submit` state machine (plan §4, W5) and how API failures are
 * read: a disabled instance ends the flow, a limit / taken name / refused
 * proof-of-work is a message, and a validation 400 lands on the fields it names.
 */
import { describe, it, expect } from '@jest/globals';
import { ApiError } from '../src/lib/api/errors';
import {
  classifySubmissionError, fieldErrorsFrom, fileProblem, initialSubmitFlowState, submitFlowReducer,
  SUBMISSION_MAX_ZIP_BYTES, type SubmitFlowAction, type SubmitFlowState,
} from '../src/lib/plugin-submissions/submit-flow';
import type { SubmissionInspectResult } from '../src/types/plugin-submissions';

const zip = (name = 'eslint.zip', size = 1024) => {
  const f = new File(['x'], name, { type: 'application/zip' });
  Object.defineProperty(f, 'size', { value: size });
  return f;
};

const inspect: SubmissionInspectResult = {
  plugin: { name: 'eslint', version: '1.0.0', pluginType: 'CodeBuildStep', buildType: 'build_image', smokeTest: true },
  fields: [{ field: 'summary', value: 'Lint', source: 'spec', error: null }],
  lint: [],
  heuristics: [],
  nameCheck: null,
};

const run = (actions: SubmitFlowAction[], from: SubmitFlowState = initialSubmitFlowState) =>
  actions.reduce(submitFlowReducer, from);

const toReview = () => run([{ type: 'file', file: zip() }, { type: 'inspected', result: inspect }]);

describe('submitFlowReducer', () => {
  it('file → inspecting (challenge → solving → uploading) → review', () => {
    let s = run([{ type: 'file', file: zip() }]);
    expect(s).toMatchObject({ step: 'inspecting', phase: 'challenge' });
    s = run([{ type: 'phase', phase: 'solving', difficulty: 20 }, { type: 'progress', attempts: 4096 }], s);
    expect(s).toMatchObject({ phase: 'solving', difficulty: 20, attempts: 4096 });
    s = run([{ type: 'phase', phase: 'uploading' }, { type: 'inspected', result: inspect }], s);
    expect(s).toMatchObject({ step: 'review', phase: null, inspect });
  });

  it('refuses a non-zip, empty or oversized file without starting any work', () => {
    expect(run([{ type: 'file', file: zip('plugin.tar.gz') }])).toMatchObject({ step: 'select', fieldErrors: { plugin: expect.stringMatching(/\.zip/) } });
    expect(fileProblem(zip('a.zip', 0))).toMatch(/empty/);
    expect(fileProblem(zip('a.zip', SUBMISSION_MAX_ZIP_BYTES + 1))).toMatch(/50 MB/);
    expect(fileProblem(zip('A.ZIP'))).toBeNull();
  });

  it('submit checks the email and the terms before any work', () => {
    let s = run([{ type: 'submit' }], toReview());
    expect(s.step).toBe('review');
    expect(s.fieldErrors.email).toMatch(/email address/);
    expect(s.fieldErrors.acceptTerms).toMatch(/Accept/);

    s = run([{ type: 'email', email: 'not-an-email' }, { type: 'terms', accepted: true }, { type: 'submit' }], s);
    expect(s.step).toBe('review');
    expect(s.fieldErrors).toMatchObject({ email: 'Enter a valid email address.', acceptTerms: undefined });

    s = run([{ type: 'email', email: ' dev@example.com ' }, { type: 'submit' }], s);
    expect(s).toMatchObject({ step: 'submitting', phase: 'challenge', fieldErrors: {} });
    s = run([{ type: 'submitted', id: 'sub-1' }], s);
    expect(s).toMatchObject({ step: 'sent', submissionId: 'sub-1' });
  });

  it('a disabled instance ends the flow from any step', () => {
    const s = run([{ type: 'file', file: zip() }, { type: 'failed', error: { kind: 'disabled', message: 'off' } }]);
    expect(s.step).toBe('disabled');
  });

  it('an inspect failure goes back to choosing a file; a submit failure back to review with field errors', () => {
    const failedInspect = run([{ type: 'file', file: zip() }, { type: 'failed', error: { kind: 'other', message: 'bad zip' } }]);
    expect(failedInspect).toMatchObject({ step: 'select', file: null, error: { message: 'bad zip' } });

    const submitting = run([{ type: 'email', email: 'a@b.co' }, { type: 'terms', accepted: true }, { type: 'submit' }], toReview());
    const failed = run([{
      type: 'failed',
      error: { kind: 'validation', message: 'Invalid', fields: { catalog: { summary: 'Too long' }, email: 'Blocked domain' } },
    }], submitting);
    expect(failed).toMatchObject({ step: 'review', fieldErrors: { email: 'Blocked domain', catalog: { summary: 'Too long' } } });

    // Editing the field clears its error; typing a new email clears that one.
    const edited = run([{ type: 'edits', edits: { summary: 'Short' } }, { type: 'email', email: 'c@d.co' }], failed);
    expect(edited.fieldErrors.catalog).toEqual({});
    expect(edited.fieldErrors.email).toBeUndefined();
  });

  it('choosing a new file keeps the typed email and drops the old inspection and edits', () => {
    const s = run([{ type: 'email', email: 'a@b.co' }, { type: 'edits', edits: { summary: 'x' } }, { type: 'file', file: zip('other.zip') }], toReview());
    expect(s).toMatchObject({ step: 'inspecting', email: 'a@b.co', inspect: null, edits: {} });
  });

  it('ignores progress and results that arrive in the wrong step', () => {
    const review = toReview();
    expect(submitFlowReducer(review, { type: 'progress', attempts: 5 })).toBe(review);
    expect(submitFlowReducer(review, { type: 'submitted', id: 'x' })).toBe(review);
    expect(submitFlowReducer(initialSubmitFlowState, { type: 'inspected', result: inspect })).toBe(initialSubmitFlowState);
  });
});

describe('classifySubmissionError', () => {
  it('reads the contract codes', () => {
    expect(classifySubmissionError(new ApiError('off', 404, 'SUBMISSIONS_DISABLED')).kind).toBe('disabled');
    const limit = classifySubmissionError(Object.assign(new ApiError('slow down', 429, 'SUBMISSION_LIMIT'), { retryAfter: 3600 }));
    expect(limit).toMatchObject({ kind: 'limit', retryAfter: 3600, message: expect.stringMatching(/3 submissions a day/) });
    expect(classifySubmissionError(new ApiError('rate', 429, 'RATE_LIMIT_EXCEEDED'))).toMatchObject({ kind: 'limit', message: expect.stringMatching(/Too many requests/) });
    expect(classifySubmissionError(new ApiError('community/eslint belongs to another submitter', 409, 'NAME_TAKEN')))
      .toEqual({ kind: 'name_taken', message: 'community/eslint belongs to another submitter' });
    expect(classifySubmissionError(new ApiError('expired', 400, 'PROOF_OF_WORK_INVALID')).kind).toBe('pow');
  });

  it('maps a validation 400 onto fields', () => {
    const err = new ApiError('Invalid metadata: summary: Too long; homepageUrl: Must be https', 400, 'VALIDATION_ERROR');
    expect(classifySubmissionError(err)).toEqual({
      kind: 'validation',
      message: err.message,
      fields: { catalog: { summary: 'Too long', homepageUrl: 'Must be https' } },
    });
  });

  it('non-API errors are plain messages', () => {
    expect(classifySubmissionError(new Error('boom'))).toEqual({ kind: 'other', message: 'boom' });
    expect(classifySubmissionError('?')).toMatchObject({ kind: 'other' });
  });
});

describe('fieldErrorsFrom', () => {
  it('accepts details.fields, details.errors / issues, and details.field', () => {
    expect(fieldErrorsFrom('bad', { fields: { email: 'Invalid email', acceptTerms: 'Required', 'metadata.license': 'Not an allowed SPDX id' } }))
      .toEqual({ email: 'Invalid email', acceptTerms: 'Required', catalog: { license: 'Not an allowed SPDX id' } });
    expect(fieldErrorsFrom('bad', { errors: [{ field: 'plugin', message: 'Symlinks are not allowed' }, { path: ['metadata', 'keywords'], message: 'Too many' }] }))
      .toEqual({ plugin: 'Symlinks are not allowed', catalog: { keywords: 'Too many' } });
    expect(fieldErrorsFrom('Commands cannot be edited', { field: 'commands' })).toEqual({});
    expect(fieldErrorsFrom('Enter a valid email', { field: 'email' })).toEqual({ email: 'Enter a valid email' });
  });
});
