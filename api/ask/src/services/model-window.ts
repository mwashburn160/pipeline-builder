// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Explain a self-hosted-model outage that is a SCHEDULE, not a fault.
 *
 * On the AWS targets `ask-model` is scaled to zero outside a business-hours
 * window (`deploy/aws/{ec2,eks}/k8s/ask-model-schedule.yaml`) because the GPU
 * node it holds is the largest line in the bill. With zero replicas the
 * `ask-model` Service has no endpoints, so the model call fails at TCP — and
 * what the user saw was an SSE `error` event carrying the raw SDK text
 * (`AI_APICallError: Cannot connect to API: other side closed`) or a flat 500
 * "Failed to answer the question". Both are indistinguishable from the model
 * being broken, which sends people to an operator over a deliberate setting.
 *
 * Nothing upstream can soften this. Provider resolution is CONFIGURATION ONLY
 * — `resolveModelSelection` never opens a socket, and
 * `OPENAI_COMPATIBLE_BASE_URL` is still set while the Deployment sits at zero —
 * so the provider resolves happily and the failure surfaces much later, inside
 * the stream. The registry's `fallbacks` do not help either: they are consulted
 * when a provider cannot be RESOLVED, never when a resolved one is unreachable
 * (and the Ask routes pass none).
 *
 * Deliberately narrow. A notice is produced only when all three hold:
 *   1. a schedule is actually configured (`ASK_SCHEDULE_ENABLED=true`),
 *   2. the failing provider is the self-hosted one — a cloud provider's
 *      outage has nothing to do with this window, and blaming the schedule for
 *      an Anthropic 529 would be a lie,
 *   3. the error looks like a CONNECTION failure. A 404 for a model the server
 *      has not pulled, or a context-length refusal, must keep its own message.
 *
 * It never claims to know more than it does: an unparseable cron (a step or
 * list in the minute/hour field, a window crossing midnight) yields the
 * "should be running, may still be starting" wording rather than a guess about
 * whether we are inside it. The same applies to an unusable ASK_SCHEDULE_TIMEZONE.
 *
 * TIMES ARE LOCAL TO `ASK_SCHEDULE_TIMEZONE`, not UTC — the CronJobs carry that
 * zone in `spec.timeZone`, so this must read the clock the same way or it will
 * name a window the cluster is not keeping. Messages carry the zone's CURRENT
 * abbreviation, so they say EDT in summer and EST in winter.
 */

import { ErrorCode, OPENAI_COMPATIBLE_PROVIDER_ID, handleAIError, sendError } from '@pipeline-builder/api-core';
import type { Response } from 'express';

/**
 * Failures that mean "nothing answered at this address".
 *
 * Node, undici and the AI SDK each phrase it differently depending on whether
 * DNS resolved, the connection was refused, or the socket died mid-body — and
 * a Service with no endpoints can produce any of them.
 */
const CONNECTION_FAILURE =
  /cannot connect|econnrefused|econnreset|enotfound|eai_again|etimedout|fetch failed|socket hang up|other side closed|terminated|network error/i;

/** `ASK_SCHEDULE_UP`/`DOWN` are five-field cron; only these parts are needed. */
interface Window {
  /** Minutes past midnight UTC the model comes up. */
  readonly startMinute: number;
  /** Minutes past midnight UTC it goes down. */
  readonly endMinute: number;
  /** Days-of-week the window applies to, or null for every day. */
  readonly days: ReadonlySet<number> | null;
}

/** A cron minute/hour field, but only when it is a plain number. */
function plainNumber(field: string | undefined): number | null {
  if (!field || !/^\d+$/.test(field)) return null;
  return Number(field);
}

/**
 * A cron day-of-week field: `*`, `3`, `1-5`, `1,3,5` or a mix. Returns null for
 * `*` (every day) and undefined when it cannot be read.
 *
 * Cron accepts both 0 and 7 for Sunday; `Date#getUTCDay` only ever returns 0,
 * so 7 is normalised rather than silently never matching.
 */
function parseDays(field: string | undefined): ReadonlySet<number> | null | undefined {
  if (!field || field === '*') return null;
  const days = new Set<number>();
  for (const part of field.split(',')) {
    const range = /^(\d)-(\d)$/.exec(part);
    const single = /^\d$/.test(part) ? Number(part) : null;
    if (range) {
      const [from, to] = [Number(range[1]) % 7, Number(range[2]) % 7];
      // A wrapping range (`5-1` = Fri..Mon) is legal cron; walk it forward
      // rather than assuming from <= to.
      for (let d = from; ; d = (d + 1) % 7) {
        days.add(d);
        if (d === to) break;
      }
    } else if (single !== null) {
      days.add(single % 7);
    } else {
      return undefined; // a step (*/2) or name (MON) — not read here
    }
  }
  return days;
}

/** The configured window, or null when either expression is not plain enough to reason about. */
function readWindow(up: string, down: string): Window | null {
  const [upMin, upHour, , , upDow] = up.trim().split(/\s+/);
  const [downMin, downHour, , , downDow] = down.trim().split(/\s+/);
  const startMinute = plainNumber(upHour) !== null && plainNumber(upMin) !== null ? plainNumber(upHour)! * 60 + plainNumber(upMin)! : null;
  const endMinute = plainNumber(downHour) !== null && plainNumber(downMin) !== null ? plainNumber(downHour)! * 60 + plainNumber(downMin)! : null;
  if (startMinute === null || endMinute === null) return null;
  // A window that ends before it starts crosses midnight. The deploy's own
  // validation does not forbid it, but reasoning about "are we inside it" then
  // needs care that is not worth guessing at for a message.
  if (endMinute <= startMinute) return null;
  const days = parseDays(upDow);
  if (days === undefined) return null;
  // Divergent day sets (up weekdays, down daily) make "which days is it up"
  // ambiguous; say nothing definite rather than something wrong.
  const downDays = parseDays(downDow);
  if (downDays === undefined) return null;
  const sameDays = (days === null && downDays === null)
    || (days !== null && downDays !== null && days.size === downDays.size && [...days].every((d) => downDays.has(d)));
  if (!sameDays) return null;
  return { startMinute, endMinute, days };
}

/** `465` → `07:45`, for a message a user reads. */
function asClock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/**
 * Where the configured window sits relative to `now`, independent of any
 * failure.
 *
 * Extracted so the reactive path (a model call that just failed) and the
 * proactive one (`GET /ask/availability`, which the panel calls before the user
 * types) cannot disagree about whether the model is scheduled off. A second
 * implementation — in particular one in the browser, computing the window from
 * `ASK_SCHEDULE_*` shipped to the client — would duplicate this cron reading AND
 * drop the self-hosted-provider check below, which is what keeps a cloud
 * provider's outage from being blamed on this schedule.
 */
type WindowState =
  /** No schedule configured, so nothing here explains anything. */
  | { readonly kind: 'none' }
  /** A schedule is set but its cron is not plain enough to reason about. */
  | { readonly kind: 'unreadable' }
  /** Scheduled to be up right now. */
  | { readonly kind: 'inside'; readonly span: string }
  /** Scheduled off right now. */
  | { readonly kind: 'outside'; readonly span: string; readonly when: string; readonly resumesAt: string };

/**
 * The zone the CronJobs read their expressions in.
 *
 * MUST match `ASK_SCHEDULE_TIMEZONE` in the deploy `.env` — the same value is
 * substituted into each CronJob's `spec.timeZone`, so Kubernetes and this
 * service have to agree or the sentence below names a window the cluster is not
 * keeping. Both default to America/New_York.
 *
 * The default is deliberately NOT UTC: the scalers run an 08:00-17:00 Eastern
 * business day, and a fixed-offset reading of that is an hour wrong for the
 * eight months the US is on EDT.
 */
const SCHEDULE_TZ = (): string => process.env.ASK_SCHEDULE_TIMEZONE || 'America/New_York';

/** Where `now` falls in a zone: minutes past local midnight, and the local weekday. */
interface ZonedNow {
  readonly minuteOfDay: number;
  /** 0 = Sunday, matching cron's day-of-week and `Date#getUTCDay`. */
  readonly day: number;
  /** The zone's CURRENT abbreviation (`EST`, `EDT`, `UTC`) — correct for this instant. */
  readonly label: string;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Read `now` in `timeZone`, or null when the zone is unusable.
 *
 * `Intl` is what makes daylight saving correct without shipping a tz database:
 * it resolves the offset FOR THIS INSTANT, so the window does not drift across
 * the switch the way a hardcoded offset does. The abbreviation comes from the
 * same call, so the message says "EDT" in summer and "EST" in winter rather
 * than a zone name most readers would have to translate.
 */
function zonedNow(now: Date, timeZone: string): ZonedNow | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone, hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
    }).formatToParts(now);
    const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
    // `hour12: false` renders midnight as "24" in en-US, which would put the
    // first minute of the day at 1440 and read as after every window.
    const hour = Number(get('hour')) % 24;
    const minute = Number(get('minute'));
    const day = WEEKDAYS.indexOf(get('weekday'));
    if (!Number.isFinite(hour) || !Number.isFinite(minute) || day < 0) return null;
    return { minuteOfDay: hour * 60 + minute, day, label: get('timeZoneName') || timeZone };
  } catch {
    // An invalid zone throws rather than falling back. Saying nothing is better
    // than naming a window computed in the wrong one.
    return null;
  }
}

function evaluateWindow(now: Date): WindowState {
  if (process.env.ASK_SCHEDULE_ENABLED !== 'true') return { kind: 'none' };
  const up = process.env.ASK_SCHEDULE_UP;
  const down = process.env.ASK_SCHEDULE_DOWN;
  if (!up || !down) return { kind: 'none' };
  const window = readWindow(up, down);
  if (!window) return { kind: 'unreadable' };
  const zoned = zonedNow(now, SCHEDULE_TZ());
  if (!zoned) return { kind: 'unreadable' };

  const span = `${asClock(window.startMinute)}-${asClock(window.endMinute)} ${zoned.label}`;
  const dayAllowed = window.days === null || window.days.has(zoned.day);
  const inside = dayAllowed && zoned.minuteOfDay >= window.startMinute && zoned.minuteOfDay < window.endMinute;
  if (inside) return { kind: 'inside', span };

  // Exactly Mon-Fri, not merely "no weekend days": {1,3,5} is a real cron the
  // operator could write, and calling it "Monday to Friday" would be wrong.
  const weekdaysOnly = window.days !== null && window.days.size === 5 && [1, 2, 3, 4, 5].every((d) => window.days!.has(d));
  return {
    kind: 'outside',
    span,
    when: weekdaysOnly ? `${span}, Monday to Friday` : span,
    resumesAt: `${asClock(window.startMinute)} ${zoned.label}`,
  };
}

/**
 * A user-facing explanation when the self-hosted model is unreachable AND a
 * business-hours schedule is configured, or undefined when the schedule is not
 * the explanation.
 *
 * @param providerId - The RESOLVED provider that failed (not the requested one,
 *   which is often absent — the registry picks the first configured provider).
 * @param failure - The error message as the route already stringified it.
 * @param now - Injectable clock; the window is UTC, matching the CronJobs,
 *   which carry no timezone.
 */
export function askModelScheduleNotice(providerId: string | undefined, failure: string, now: Date = new Date()): string | undefined {
  if (process.env.ASK_SCHEDULE_ENABLED !== 'true') return undefined;
  if (providerId !== OPENAI_COMPATIBLE_PROVIDER_ID) return undefined;
  if (!CONNECTION_FAILURE.test(failure)) return undefined;

  const state = evaluateWindow(now);
  // Times are stated as UTC explicitly. The CronJobs have no timezone, so a
  // bare "08:00" would be read as local and be wrong for most readers.
  if (state.kind === 'none' || state.kind === 'unreadable') {
    return 'The Ask assistant\'s self-hosted model is not responding. It runs on a schedule and may be switched off right now, or still starting up — try again in a few minutes.';
  }
  if (state.kind === 'inside') {
    // Scheduled to be up but absent. The honest reading is "starting, or it
    // failed to start" — on eks a GPU node takes about five minutes to
    // provision, and nothing alerts on a scale-up that never succeeded.
    return `The Ask assistant's self-hosted model is scheduled to be running now (${state.span}) but is not responding. It may still be starting up — try again in a few minutes.`;
  }
  return `The Ask assistant's self-hosted model runs ${state.when} and is switched off right now. It will be available again at ${state.resumesAt}.`;
}

/** Why the assistant cannot answer, when it cannot. */
export type AskUnavailableReason =
  /** Scaled to zero by its business-hours schedule. Comes back by itself. */
  | 'scheduled-off'
  /** No AI provider is configured at all. Does NOT come back by itself. */
  | 'not-configured';

/** The answer `GET /ask/availability` serves. */
export type AskAvailability =
  | { readonly available: true }
  | {
    readonly available: false;
    readonly reason: AskUnavailableReason;
    /** A sentence for the user, already naming times as UTC. */
    readonly message: string;
    /** When it returns, e.g. `07:45 UTC`. Absent when nothing will change on its own. */
    readonly resumesAt?: string;
    /** The configured window, e.g. `07:45-17:00 UTC, Monday to Friday`. */
    readonly window?: string;
  };

/**
 * Whether the assistant can answer right now — asked BEFORE a question is sent,
 * so the panel can open straight into help topics instead of inviting a question
 * that is going to fail.
 *
 * This PREDICTS from the configured cron; it does not observe the Deployment.
 * The two can disagree — suspending the CronJobs (`ASK_SCHEDULE_ENABLED=false`)
 * while `ask-model` sits at zero replicas leaves the model off indefinitely with
 * no schedule to explain it. So this deliberately only ever reports `false` for
 * a state it is sure of, and the reactive 503 from `sendAskFailure` remains the
 * authority on an actual failed call.
 *
 * @param providerId - The provider Ask would resolve for a request right now, or
 *   undefined when nothing is configured.
 * @param now - Injectable clock; the window is UTC, matching the CronJobs.
 */
export function askModelAvailability(providerId: string | undefined, now: Date = new Date()): AskAvailability {
  if (!providerId) {
    return {
      available: false,
      reason: 'not-configured',
      message: 'No AI provider is configured for this deployment, so the assistant cannot answer questions. The help topics below cover the same material.',
    };
  }
  // The schedule governs the SELF-HOSTED model only. A deployment answering from
  // Anthropic or OpenAI is up regardless of ASK_SCHEDULE_*, and reporting it
  // unavailable would switch off a working assistant.
  if (providerId !== OPENAI_COMPATIBLE_PROVIDER_ID) return { available: true };

  const state = evaluateWindow(now);
  // 'inside' and 'unreadable' both mean "no reason to think it is off". If it
  // turns out to be down, the call fails and sendAskFailure explains it.
  if (state.kind !== 'outside') return { available: true };
  return {
    available: false,
    reason: 'scheduled-off',
    message: `The Ask assistant's self-hosted model runs ${state.when} and is switched off right now. It will be available again at ${state.resumesAt}.`,
    resumesAt: state.resumesAt,
    window: state.when,
  };
}

/**
 * Send an Ask failure, preferring a SCHEDULE explanation when that is what it is.
 *
 * Outside its business-hours window the self-hosted model has zero replicas, so
 * the call dies at TCP and the user saw either a bare 500 "Failed to answer the
 * question" or the raw SDK text in an SSE error event — both of which read as
 * "Ask is broken" rather than "Ask is off until 07:45". `askModelScheduleNotice`
 * returns a sentence only when the schedule really is the cause; otherwise this
 * is exactly the previous behaviour.
 *
 * 503 rather than 500 on the non-streamed path: the model is temporarily
 * unavailable by configuration, which is what that status means, and it lets a
 * client distinguish "come back later" from a genuine fault. Once headers are
 * flushed the status is already sent, so the streamed path can only replace the
 * error TEXT — which is the part the user reads.
 *
 * @param now - Injectable clock, forwarded to the notice; the routes omit it.
 */
export function sendAskFailure(res: Response, message: string, fallback: string, providerId: string | undefined, now?: Date): void {
  const notice = askModelScheduleNotice(providerId, message, now);
  if (!notice) return handleAIError(res, message, fallback);
  if (!res.headersSent) return sendError(res, 503, notice, ErrorCode.SERVICE_UNAVAILABLE);
  res.write(`data: ${JSON.stringify({ type: 'error', message: notice })}\n\n`);
  res.end();
}
