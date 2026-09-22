// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The `/plugins/submit` page's state machine (plan §4.1, W5), kept pure so it
 * can be tested without a browser:
 *
 *   select ──file──▶ inspecting (challenge → solving → uploading) ──▶ review
 *   review ──submit──▶ submitting (challenge → solving → uploading) ──▶ sent
 *
 * Any call answering `404 SUBMISSIONS_DISABLED` moves to `disabled`. Other
 * failures return to the step they came from with a message, and a validation
 * 400 is mapped onto the fields it names.
 */
import { ApiError } from '@/lib/api/errors';
import { PLUGIN_CATALOG_FIELDS, type PluginCatalogEdits, type PluginCatalogField } from '@/types';
import type { SubmissionInspectResult } from '@/types/plugin-submissions';

/** The server's cap (`SUBMISSION_MAX_ZIP_BYTES`, default 50 MB); checked here only to fail fast. */
export const SUBMISSION_MAX_ZIP_BYTES = 50 * 1024 * 1024;

export type SubmitStep = 'select' | 'inspecting' | 'review' | 'submitting' | 'sent' | 'disabled';

/** What a proof-of-work-guarded call is doing right now. */
export type PowPhase = 'challenge' | 'solving' | 'uploading';

export interface SubmissionFieldErrors {
  plugin?: string;
  email?: string;
  acceptTerms?: string;
  catalog?: Partial<Record<PluginCatalogField, string>>;
}

export type SubmissionErrorInfo =
  | { kind: 'disabled'; message: string }
  | { kind: 'limit'; message: string; retryAfter?: number }
  | { kind: 'name_taken'; message: string }
  | { kind: 'pow'; message: string }
  | { kind: 'validation'; message: string; fields: SubmissionFieldErrors }
  | { kind: 'other'; message: string };

export interface SubmitFlowState {
  step: SubmitStep;
  file: File | null;
  inspect: SubmissionInspectResult | null;
  /** Catalog fields the submitter EDITED (only those; `null` clears one). */
  edits: PluginCatalogEdits;
  email: string;
  acceptTerms: boolean;
  phase: PowPhase | null;
  difficulty: number;
  attempts: number;
  /** The last failure, shown above the form. */
  error: SubmissionErrorInfo | null;
  fieldErrors: SubmissionFieldErrors;
  submissionId: string | null;
}

export type SubmitFlowAction =
  | { type: 'file'; file: File }
  | { type: 'phase'; phase: PowPhase; difficulty?: number }
  | { type: 'progress'; attempts: number }
  | { type: 'inspected'; result: SubmissionInspectResult }
  | { type: 'failed'; error: SubmissionErrorInfo }
  | { type: 'edits'; edits: PluginCatalogEdits }
  | { type: 'email'; email: string }
  | { type: 'terms'; accepted: boolean }
  | { type: 'submit' }
  | { type: 'submitted'; id: string }
  | { type: 'reset' };

export const initialSubmitFlowState: SubmitFlowState = {
  step: 'select',
  file: null,
  inspect: null,
  edits: {},
  email: '',
  acceptTerms: false,
  phase: null,
  difficulty: 0,
  attempts: 0,
  error: null,
  fieldErrors: {},
  submissionId: null,
};

// Deliberately loose: the server validates properly. This only catches typos.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Why a chosen file can't be submitted, or null. */
export function fileProblem(file: File): string | null {
  if (!/\.zip$/i.test(file.name)) return 'Choose a .zip plugin package.';
  if (file.size === 0) return 'That file is empty.';
  if (file.size > SUBMISSION_MAX_ZIP_BYTES) return `The package is larger than ${SUBMISSION_MAX_ZIP_BYTES / (1024 * 1024)} MB.`;
  return null;
}

/** The email and terms checks run before any work is done. */
export function formProblems(state: Pick<SubmitFlowState, 'email' | 'acceptTerms'>): SubmissionFieldErrors {
  const errors: SubmissionFieldErrors = {};
  const email = state.email.trim();
  if (!email) errors.email = 'Enter the email address to confirm the submission with.';
  else if (!EMAIL_RE.test(email)) errors.email = 'Enter a valid email address.';
  if (!state.acceptTerms) errors.acceptTerms = 'Accept the submission terms to continue.';
  return errors;
}

const hasErrors = (e: SubmissionFieldErrors) =>
  !!(e.plugin || e.email || e.acceptTerms || (e.catalog && Object.keys(e.catalog).length > 0));

export function submitFlowReducer(state: SubmitFlowState, action: SubmitFlowAction): SubmitFlowState {
  switch (action.type) {
    case 'file': {
      const problem = fileProblem(action.file);
      if (problem) {
        return { ...initialSubmitFlowState, email: state.email, fieldErrors: { plugin: problem } };
      }
      return {
        ...initialSubmitFlowState,
        email: state.email,
        step: 'inspecting',
        file: action.file,
        phase: 'challenge',
      };
    }
    case 'phase':
      if (state.step !== 'inspecting' && state.step !== 'submitting') return state;
      return {
        ...state,
        phase: action.phase,
        difficulty: action.difficulty ?? state.difficulty,
        attempts: action.phase === 'solving' ? 0 : state.attempts,
      };
    case 'progress':
      return state.phase === 'solving' ? { ...state, attempts: action.attempts } : state;
    case 'inspected':
      if (state.step !== 'inspecting') return state;
      return { ...state, step: 'review', inspect: action.result, phase: null, error: null, fieldErrors: {} };
    case 'failed': {
      if (action.error.kind === 'disabled') return { ...state, step: 'disabled', phase: null, error: action.error };
      const fields = action.error.kind === 'validation' ? action.error.fields : {};
      if (state.step === 'inspecting') {
        // Nothing usable came back: pick a file again.
        return {
          ...state, step: 'select', file: null, inspect: null, phase: null, error: action.error,
          fieldErrors: { plugin: fields.plugin },
        };
      }
      if (state.step === 'submitting') {
        return { ...state, step: 'review', phase: null, error: action.error, fieldErrors: fields };
      }
      return state;
    }
    case 'edits': {
      // Editing a field clears the server's complaint about it.
      const catalog = { ...(state.fieldErrors.catalog ?? {}) };
      for (const key of Object.keys(catalog) as PluginCatalogField[]) {
        if (JSON.stringify(action.edits[key]) !== JSON.stringify(state.edits[key])) delete catalog[key];
      }
      return { ...state, edits: action.edits, fieldErrors: { ...state.fieldErrors, catalog } };
    }
    case 'email':
      return { ...state, email: action.email, fieldErrors: { ...state.fieldErrors, email: undefined } };
    case 'terms':
      return { ...state, acceptTerms: action.accepted, fieldErrors: { ...state.fieldErrors, acceptTerms: undefined } };
    case 'submit': {
      if (state.step !== 'review' || !state.file) return state;
      const problems = formProblems(state);
      if (hasErrors(problems)) return { ...state, fieldErrors: { ...state.fieldErrors, ...problems } };
      return { ...state, step: 'submitting', phase: 'challenge', error: null, fieldErrors: {} };
    }
    case 'submitted':
      if (state.step !== 'submitting') return state;
      return { ...state, step: 'sent', phase: null, submissionId: action.id, error: null };
    case 'reset':
      return initialSubmitFlowState;
    default:
      return state;
  }
}

const CATALOG_FIELDS: ReadonlySet<string> = new Set(PLUGIN_CATALOG_FIELDS);

/** Route one `field → message` pair onto the form. */
function assignField(out: SubmissionFieldErrors, rawField: string, message: string): boolean {
  const field = rawField.replace(/^metadata[.[]/, '').replace(/]$/, '').split(/[.[]/)[0];
  if (field === 'email') { out.email = message; return true; }
  if (field === 'acceptTerms' || field === 'terms') { out.acceptTerms = message; return true; }
  if (field === 'plugin' || field === 'file' || field === 'zip') { out.plugin = message; return true; }
  if (CATALOG_FIELDS.has(field)) {
    out.catalog = { ...(out.catalog ?? {}), [field as PluginCatalogField]: message };
    return true;
  }
  return false;
}

/**
 * Field-level errors from a 400. Accepts `details.fields` (`{ field: message }`),
 * `details.errors` / `details.issues` (`[{ field | path, message }]`),
 * `details.field` with the top-level message, and the metadata validator's
 * `Invalid metadata: summary: …; license: …` message.
 */
export function fieldErrorsFrom(message: string, details: Record<string, unknown> | undefined): SubmissionFieldErrors {
  const out: SubmissionFieldErrors = {};
  const d = details ?? {};
  if (d.fields && typeof d.fields === 'object' && !Array.isArray(d.fields)) {
    for (const [k, v] of Object.entries(d.fields as Record<string, unknown>)) {
      if (typeof v === 'string') assignField(out, k, v);
    }
  }
  const list = Array.isArray(d.errors) ? d.errors : Array.isArray(d.issues) ? d.issues : [];
  for (const item of list) {
    const o = (item ?? {}) as Record<string, unknown>;
    const path = typeof o.field === 'string' ? o.field : Array.isArray(o.path) ? o.path.join('.') : typeof o.path === 'string' ? o.path : '';
    if (path && typeof o.message === 'string') assignField(out, path, o.message);
  }
  if (typeof d.field === 'string') assignField(out, d.field, message);
  const meta = /^Invalid metadata:\s*(.+)$/i.exec(message);
  if (meta) {
    for (const part of meta[1].split(/;\s*/)) {
      const m = /^([\w.[\]]+):\s*(.+)$/.exec(part.trim());
      if (m) assignField(out, m[1], m[2]);
    }
  }
  // A bare message about the email or the terms still belongs next to that field.
  if (!hasErrors(out)) {
    if (/\bemail\b/i.test(message)) out.email = message;
    else if (/acceptTerms|\bterms\b/i.test(message)) out.acceptTerms = message;
  }
  return out;
}

/** Classify a failed submissions call for the page. */
export function classifySubmissionError(err: unknown): SubmissionErrorInfo {
  if (!(err instanceof ApiError)) {
    return { kind: 'other', message: err instanceof Error && err.message ? err.message : 'Something went wrong. Please try again.' };
  }
  const code = err.code ?? '';
  if (code === 'SUBMISSIONS_DISABLED') {
    return { kind: 'disabled', message: 'Anonymous plugin submissions are not enabled on this instance.' };
  }
  if (code === 'SUBMISSION_LIMIT' || err.statusCode === 429) {
    return {
      kind: 'limit',
      message: code === 'SUBMISSION_LIMIT'
        ? 'You have reached the limit of 3 submissions a day for this email address or network. Try again tomorrow.'
        : 'Too many requests. Wait a moment and try again.',
      ...(err.retryAfter ? { retryAfter: err.retryAfter } : {}),
    };
  }
  if (code === 'NAME_TAKEN') {
    return {
      kind: 'name_taken',
      message: err.message || 'That plugin name is taken. Updates to a community plugin are accepted only from the email address that first submitted it.',
    };
  }
  if (/^POW_|PROOF_OF_WORK/.test(code) || err.details?.field === 'pow') {
    return { kind: 'pow', message: 'The anti-spam check expired or was already used. Try again; a new one is solved automatically.' };
  }
  if (err.statusCode === 400 || err.statusCode === 413 || err.statusCode === 422) {
    const fields = fieldErrorsFrom(err.message, err.details);
    if (err.statusCode === 413 && !fields.plugin) fields.plugin = 'The package is too large.';
    return { kind: 'validation', message: err.message || 'Some details need fixing.', fields };
  }
  return { kind: 'other', message: err.message || 'Something went wrong. Please try again.' };
}
