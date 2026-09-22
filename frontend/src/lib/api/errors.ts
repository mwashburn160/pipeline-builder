// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0


export class ApiError extends Error {
  statusCode: number;
  code?: string;
  details?: Record<string, unknown>;
  /** Seconds to wait before retrying (from Retry-After header on 429 responses). */
  retryAfter?: number;

  constructor(message: string, statusCode: number, code?: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

/**
 * Thrown by registry copy/blob calls when the backend returns 4xx with a
 * `details.reason` payload that the UI needs to discriminate on. Catch
 * with `instanceof ConflictError` then branch on `reason` to drive the
 * overwrite preflight (`target-exists`), source-missing retry
 * (`source-incomplete`), or inline validation (`source-equals-target`).
 */
export class ConflictError extends ApiError {
  reason: 'target-exists' | 'source-incomplete' | 'source-equals-target' | string;
  existing?: { ref: string; digest: string };
  requested?: { digest: string };
  missingDigest?: string;

  constructor(message: string, statusCode: number, code: string | undefined, details: Record<string, unknown>) {
    super(message, statusCode, code, details);
    this.name = 'ConflictError';
    this.reason = (details.reason as string) ?? 'unknown';
    this.existing = details.existing as { ref: string; digest: string } | undefined;
    this.requested = details.requested as { digest: string } | undefined;
    this.missingDigest = details.missingDigest as string | undefined;
  }
}

/**
 * Thrown when a destructive endpoint rejects the request because the
 * step-up token is missing, expired, or invalid.
 *
 * Surfaces the three backend error codes — STEP_UP_REQUIRED,
 * STEP_UP_INVALID, STEP_UP_MISMATCH — through one class so callers
 * just `catch (err instanceof StepUpRequiredError)` and re-prompt
 * for password via StepUpModal. The api client also dispatches a
 * `'step-up-required'` window event so a top-level layout listener
 * can pop the modal globally (covers stale tabs that fired a
 * destructive call without going through their local flow).
 */
export class StepUpRequiredError extends ApiError {
  /**
   * The replay of the refused request, when the global step-up dialog took the
   * refusal over: resolves with the replay's result once the person confirms,
   * rejects if they dismiss the dialog or the replay fails. Absent when no
   * dialog is mounted, or for a call marked non-replayable.
   */
  resume?: Promise<unknown>;

  constructor(message: string, code: string, details?: Record<string, unknown>) {
    super(message, 401, code, details);
    this.name = 'StepUpRequiredError';
  }

  /** @internal Set by the api client once a listener has claimed the refusal. */
  attachResume(resume: Promise<unknown>): void {
    this.resume = resume;
  }
}

/**
 * Follow a refusal the global step-up dialog took over through to its replay.
 *
 * Resolves with the replayed request's result; a second refusal (the replay was
 * itself refused and re-prompted) is followed the same way. Rejects with the
 * original error when nothing took it over.
 */
async function followResume<T>(err: unknown): Promise<T> {
  if (!(err instanceof StepUpRequiredError) || !err.resume) throw err;
  try {
    return (await err.resume) as T;
  } catch (next) {
    // A dismissed dialog rejects with the refusal itself: that is the end.
    if (next === err) throw err;
    return followResume<T>(next);
  }
}

/**
 * Run an api call; if it is refused for step-up and the global dialog takes the
 * refusal over, resolve with the REPLAY's result instead of failing. Use it for
 * a call whose caller has nothing on screen that the dialog would stack on top
 * of (a button, not an open modal) — it simply waits for the confirmation.
 */
export async function withStepUpResume<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    return followResume<T>(err);
  }
}

/**
 * For a `catch` block: `true` when `err` is a step-up refusal the global dialog
 * has taken over — the caller should close its own UI and NOT report an error
 * (the dialog reports the outcome); `onResumed` runs with the replay's result
 * once the person confirms, so the caller can refresh what it shows. `false`
 * for anything else, which the caller handles as it always did.
 */
export function continueAfterStepUp<T = unknown>(err: unknown, onResumed: (result: T) => void): boolean {
  if (!(err instanceof StepUpRequiredError) || !err.resume) return false;
  followResume<T>(err).then(onResumed, () => undefined);
  return true;
}

/**
 * Thrown when a route refuses the SESSION rather than the request:
 * `MFA_REQUIRED` (the session is single-factor and the route needs two) or
 * `REAUTH_REQUIRED` (it is MFA-grade but older than the route allows).
 *
 * Its own class, and NOT part of the generic 401 handling, because the recovery
 * is different in kind: an access-token refresh cannot fix it (assurance lives on
 * the session slot and a refresh never raises it), and signing the person out
 * would take away the session they need in order to enrol a factor. The api
 * client also dispatches an `'mfa-required'` window event so the layout can offer
 * the enrolment route from anywhere, including a stale tab.
 */
export class MfaRequiredError extends ApiError {
  /** `'MFA_REQUIRED'` (enrol or sign in with a factor) or `'REAUTH_REQUIRED'`
   *  (the factor is there, the sign-in is just too old). */
  declare code: string;

  constructor(message: string, code: string, details?: Record<string, unknown>) {
    super(message, 401, code, details);
    this.name = 'MfaRequiredError';
  }
}

/**
 * Map a structured error response from the registry endpoints to the right
 * typed error subclass. Keeps the components from re-deriving the same
 * status-code switch.
 */
export function toRegistryError(message: string, statusCode: number, code: string | undefined, details?: Record<string, unknown>): ApiError {
  if (statusCode === 409 || (statusCode === 400 && details?.reason === 'source-equals-target')) {
    return new ConflictError(message, statusCode, code, details ?? {});
  }
  return new ApiError(message, statusCode, code, details);
}
