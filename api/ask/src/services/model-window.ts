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
 * whether we are inside it.
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

  const up = process.env.ASK_SCHEDULE_UP;
  const down = process.env.ASK_SCHEDULE_DOWN;
  if (!up || !down) return undefined;
  const window = readWindow(up, down);

  // Times are stated as UTC explicitly. The CronJobs have no timezone, so a
  // bare "08:00" would be read as local and be wrong for most readers.
  if (!window) {
    return 'The Ask assistant\'s self-hosted model is not responding. It runs on a schedule and may be switched off right now, or still starting up — try again in a few minutes.';
  }

  const span = `${asClock(window.startMinute)}-${asClock(window.endMinute)} UTC`;
  const minuteOfDay = now.getUTCHours() * 60 + now.getUTCMinutes();
  const dayAllowed = window.days === null || window.days.has(now.getUTCDay());
  const inside = dayAllowed && minuteOfDay >= window.startMinute && minuteOfDay < window.endMinute;

  if (inside) {
    // Scheduled to be up but absent. The honest reading is "starting, or it
    // failed to start" — on eks a GPU node takes about five minutes to
    // provision, and nothing alerts on a scale-up that never succeeded.
    return `The Ask assistant's self-hosted model is scheduled to be running now (${span}) but is not responding. It may still be starting up — try again in a few minutes.`;
  }
  // Exactly Mon-Fri, not merely "no weekend days": {1,3,5} is a real cron the
  // operator could write, and calling it "Monday to Friday" would be wrong.
  const weekdaysOnly = window.days !== null && window.days.size === 5 && [1, 2, 3, 4, 5].every((d) => window.days!.has(d));
  const when = weekdaysOnly ? `${span}, Monday to Friday` : span;
  return `The Ask assistant's self-hosted model runs ${when} and is switched off right now. It will be available again at ${asClock(window.startMinute)} UTC.`;
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
