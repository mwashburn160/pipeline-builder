// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Client for ANONYMOUS plugin submissions (plan §4, W5): the plugin service's
 * `/public/plugin-submissions` routes, exposed by nginx under `/api/public/`.
 *
 * Deliberately NOT part of the shared `api` object: that client attaches the
 * session's `Authorization` and `x-org-id` headers, and a submission must never
 * carry an identity (it is anonymous even when the visitor happens to be signed
 * in). Every call here sends no auth header and `credentials: 'omit'`.
 *
 * Every failure is an {@link ApiError} carrying the HTTP status, the server's
 * `code` (`SUBMISSIONS_DISABLED`, `SUBMISSION_LIMIT`, `NAME_TAKEN`, …), its
 * `details`, and `retryAfter` on 429.
 */
import { ApiError } from '../errors';
import { API_URL } from '../util';
import type { PluginCatalogEdits, PluginInspectField } from '@/types';
import type {
  HeuristicFinding, ProofOfWorkSolution, SubmissionChallenge, SubmissionCreated, SubmissionGate, SubmissionInspectResult,
  SubmissionLintIssue, SubmissionStatusView, SubmissionVerified,
} from '@/types/plugin-submissions';

interface ErrorBody { message?: string; code?: string; details?: Record<string, unknown>; data?: unknown }

async function call<T>(path: string, init: RequestInit & { signal?: AbortSignal } = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: { Accept: 'application/json', ...(init.headers as Record<string, string> | undefined) },
      credentials: 'omit',
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    throw new ApiError('Could not reach the server. Check your connection and try again.', 0, 'NETWORK_ERROR');
  }
  const body = (await response.json().catch(() => ({}))) as ErrorBody;
  if (!response.ok) {
    const error = new ApiError(body.message || `Request failed (${response.status})`, response.status, body.code, body.details);
    const retryAfter = Number(response.headers.get('Retry-After'));
    if (Number.isFinite(retryAfter) && retryAfter > 0) error.retryAfter = retryAfter;
    throw error;
  }
  // The platform wraps payloads as `{ success, data }`; tolerate a bare body too.
  return (body && typeof body === 'object' && 'data' in body ? body.data : body) as T;
}

const asString = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const asLine = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function normalizeLint(raw: unknown): SubmissionLintIssue[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item): SubmissionLintIssue => {
    if (typeof item === 'string') return { rule: null, message: item, severity: 'warning', path: null, line: null };
    const o = (item ?? {}) as Record<string, unknown>;
    return {
      rule: asString(o.rule) ?? asString(o.id),
      message: asString(o.message) ?? String(o.rule ?? 'Lint issue'),
      // api-core's PluginLintFinding says `level`; accept `severity` too.
      severity: (o.level ?? o.severity) === 'error' ? 'error' : 'warning',
      path: asString(o.path) ?? asString(o.file),
      line: asLine(o.line),
    };
  });
}

/** Heuristics findings from either `heuristics: Finding[]` or `heuristics: { findings }`. */
export function normalizeFindings(raw: unknown): HeuristicFinding[] {
  const list = Array.isArray(raw) ? raw : Array.isArray((raw as { findings?: unknown })?.findings) ? (raw as { findings: unknown[] }).findings : [];
  return list.map((item): HeuristicFinding => {
    const o = (item ?? {}) as Record<string, unknown>;
    const severity = o.severity === 'high' || o.severity === 'medium' ? o.severity : 'low';
    return { id: String(o.id ?? 'finding'), severity, path: String(o.path ?? ''), line: asLine(o.line), excerpt: String(o.excerpt ?? '') };
  });
}

/** A `{ id, ok, message }` gate, or null. */
export function normalizeGate(raw: unknown): SubmissionGate | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  return { id: String(o.id ?? 'gate'), ok: o.ok === true, message: String(o.message ?? '') };
}

/** Normalize the inspect payload (the spec summary may come as `plugin` or `spec`). */
export function normalizeInspect(raw: unknown): SubmissionInspectResult {
  const o = (raw ?? {}) as Record<string, unknown>;
  const spec = (o.plugin ?? o.spec ?? {}) as Record<string, unknown>;
  const lintSource = o.lint ?? o.lintWarnings ?? o.warnings;
  return {
    plugin: {
      name: String(spec.name ?? ''),
      version: String(spec.version ?? ''),
      pluginType: asString(spec.pluginType),
      buildType: asString(spec.buildType),
      smokeTest: typeof spec.smokeTest === 'boolean' ? spec.smokeTest : null,
    },
    fields: Array.isArray(o.fields) ? (o.fields as PluginInspectField[]) : [],
    lint: normalizeLint(Array.isArray(lintSource) ? lintSource : (lintSource as { warnings?: unknown })?.warnings),
    heuristics: normalizeFindings(o.heuristics),
    nameCheck: normalizeGate(o.name ?? o.nameCheck),
  };
}

/** A fresh proof-of-work challenge. Each one is single use. */
export function getSubmissionChallenge(opts: { signal?: AbortSignal } = {}): Promise<SubmissionChallenge> {
  return call<SubmissionChallenge>('/api/public/plugin-submissions/challenge', { method: 'GET', signal: opts.signal });
}

/** Dry-run the package: detected catalog fields, lint and a heuristics preview. Stores nothing. */
export async function inspectSubmission(
  file: File, pow: ProofOfWorkSolution, opts: { signal?: AbortSignal } = {},
): Promise<SubmissionInspectResult> {
  const form = new FormData();
  form.append('plugin', file);
  form.append('pow', JSON.stringify(pow));
  return normalizeInspect(await call<unknown>('/api/public/plugin-submissions/inspect', { method: 'POST', body: form, signal: opts.signal }));
}

/**
 * Submit. `metadata` carries ONLY the catalog fields the submitter edited
 * (omitted when there are none, which accepts every detected value).
 */
export function createSubmission(
  input: { file: File; email: string; pow: ProofOfWorkSolution; metadata?: PluginCatalogEdits },
  opts: { signal?: AbortSignal } = {},
): Promise<SubmissionCreated> {
  const form = new FormData();
  form.append('plugin', input.file);
  form.append('email', input.email);
  form.append('pow', JSON.stringify(input.pow));
  form.append('acceptTerms', 'true');
  if (input.metadata && Object.keys(input.metadata).length > 0) form.append('metadata', JSON.stringify(input.metadata));
  return call<SubmissionCreated>('/api/public/plugin-submissions', { method: 'POST', body: form, signal: opts.signal });
}

/** Confirm the email address with the magic-link token (single use, 30 minutes). */
export async function verifySubmission(token: string, opts: { signal?: AbortSignal } = {}): Promise<SubmissionVerified> {
  const res = await call<Partial<SubmissionVerified>>('/api/public/plugin-submissions/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
    signal: opts.signal,
  });
  return { id: String(res.id ?? ''), status: res.status ?? 'pending_review', statusToken: res.statusToken ?? null };
}

/** A submission's status, by the status token from the verify step or an email. */
export function getSubmissionStatus(token: string, opts: { signal?: AbortSignal } = {}): Promise<SubmissionStatusView> {
  return call<SubmissionStatusView>(`/api/public/plugin-submissions/status?token=${encodeURIComponent(token)}`, { method: 'GET', signal: opts.signal });
}
