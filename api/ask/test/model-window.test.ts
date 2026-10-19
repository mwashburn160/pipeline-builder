// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * services/model-window.ts — telling "the model is OFF BY DESIGN" apart from
 * "the model is broken".
 *
 * Outside its business-hours window `ask-model` has zero replicas, so the call
 * dies at TCP and the user used to get the raw SDK text
 * (`Cannot connect to API: other side closed`) or a flat 500. These lock the
 * three ways that explanation can go wrong:
 *   - claiming the schedule when something else failed (a cloud provider's
 *     outage, a model the server never pulled) — a confident lie;
 *   - staying silent when the schedule IS the cause — the bug being fixed;
 *   - getting the window arithmetic wrong, which is easy because the CronJobs
 *     are UTC and carry no timezone.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const handleAIError = jest.fn<AnyFn>();
const sendError = jest.fn<AnyFn>();
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  handleAIError: (...a: unknown[]) => handleAIError(...a),
  sendError: (...a: unknown[]) => sendError(...a),
}));

const { askModelAvailability, askModelScheduleNotice, sendAskFailure } = await import('../src/services/model-window.js');

/** The provider id the self-hosted endpoint registers under. */
const SELF_HOSTED = 'openai-compatible';
/** What an unreachable Service with no endpoints actually produces. */
const UNREACHABLE = 'AI_APICallError: Cannot connect to API: other side closed';
/** 2026-10-09 is a Friday; 2026-10-10 a Saturday. */
const at = (iso: string) => new Date(iso);

const ENV_KEYS = ['ASK_SCHEDULE_ENABLED', 'ASK_SCHEDULE_UP', 'ASK_SCHEDULE_DOWN', 'ASK_SCHEDULE_TIMEZONE'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.ASK_SCHEDULE_ENABLED = 'true';
  process.env.ASK_SCHEDULE_UP = '45 7 * * *';
  process.env.ASK_SCHEDULE_DOWN = '0 17 * * *';
  // These cases exercise the window ARITHMETIC, so they pin the zone to UTC and
  // feed UTC instants — keeping the clock and the expectation in one frame. The
  // deploy default is America/New_York; that is covered on its own below.
  process.env.ASK_SCHEDULE_TIMEZONE = 'UTC';
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('askModelScheduleNotice — when the schedule is the explanation', () => {
  it('says the model is switched off, and when it returns', () => {
    // 02:00 UTC — hours before the 07:45 scale-up.
    const notice = askModelScheduleNotice(SELF_HOSTED, UNREACHABLE, at('2026-10-09T02:00:00Z'));
    expect(notice).toContain('switched off right now');
    expect(notice).toContain('07:45-17:00 UTC');
    // The one actionable fact: when to come back.
    expect(notice).toContain('available again at 07:45 UTC');
  });

  it('treats the END of the window as closed, not open', () => {
    // 17:00 is when the down-job runs, so 17:00 is OUT.
    expect(askModelScheduleNotice(SELF_HOSTED, UNREACHABLE, at('2026-10-09T17:00:00Z'))).toContain('switched off');
    expect(askModelScheduleNotice(SELF_HOSTED, UNREACHABLE, at('2026-10-09T16:59:00Z'))).toContain('scheduled to be running now');
  });

  it('does NOT claim the window is closed when it is open', () => {
    // Scheduled up but unreachable: starting, or the scale-up failed. Saying
    // "switched off" here would send someone away from a real outage — and
    // nothing alerts on a failed scale-up, so the message is the only signal.
    const notice = askModelScheduleNotice(SELF_HOSTED, UNREACHABLE, at('2026-10-09T09:00:00Z'));
    expect(notice).toContain('scheduled to be running now');
    expect(notice).toContain('may still be starting up');
    expect(notice).not.toContain('switched off');
  });

  it('reads the window in UTC, not the host timezone', () => {
    // 23:30 in a UTC+9 zone is 14:30 UTC — INSIDE the window. A notice built
    // from local time would call this closed.
    expect(askModelScheduleNotice(SELF_HOSTED, UNREACHABLE, at('2026-10-09T14:30:00Z'))).toContain('scheduled to be running now');
  });

  it('honours a weekday-only window on a Saturday', () => {
    process.env.ASK_SCHEDULE_UP = '45 7 * * 1-5';
    process.env.ASK_SCHEDULE_DOWN = '0 17 * * 1-5';
    // 2026-10-10 is a Saturday: inside the HOURS, outside the DAYS.
    const notice = askModelScheduleNotice(SELF_HOSTED, UNREACHABLE, at('2026-10-10T09:00:00Z'));
    expect(notice).toContain('switched off right now');
    expect(notice).toContain('Monday to Friday');
    // ...and the same clock time on the Friday is open.
    expect(askModelScheduleNotice(SELF_HOSTED, UNREACHABLE, at('2026-10-09T09:00:00Z'))).toContain('scheduled to be running now');
  });

  it('does not call an arbitrary day set "Monday to Friday"', () => {
    process.env.ASK_SCHEDULE_UP = '45 7 * * 1,3,5';
    process.env.ASK_SCHEDULE_DOWN = '0 17 * * 1,3,5';
    // Thursday: off, but it is NOT a Mon-Fri schedule.
    const notice = askModelScheduleNotice(SELF_HOSTED, UNREACHABLE, at('2026-10-08T09:00:00Z'));
    expect(notice).toContain('switched off right now');
    expect(notice).not.toContain('Monday to Friday');
  });

  it('accepts Sunday as 7 as well as 0', () => {
    process.env.ASK_SCHEDULE_UP = '45 7 * * 7';
    process.env.ASK_SCHEDULE_DOWN = '0 17 * * 7';
    // 2026-10-11 is a Sunday; cron allows both 0 and 7, Date only reports 0.
    expect(askModelScheduleNotice(SELF_HOSTED, UNREACHABLE, at('2026-10-11T09:00:00Z'))).toContain('scheduled to be running now');
  });

  it('falls back to vague-but-true wording on a cron it cannot read', () => {
    process.env.ASK_SCHEDULE_UP = '*/15 7 * * *';
    const notice = askModelScheduleNotice(SELF_HOSTED, UNREACHABLE, at('2026-10-09T02:00:00Z'));
    // No window claim at all — it must not invent one.
    expect(notice).toContain('runs on a schedule');
    expect(notice).not.toContain('UTC');
  });

  it('says nothing definite when a window crosses midnight', () => {
    process.env.ASK_SCHEDULE_UP = '0 22 * * *';
    process.env.ASK_SCHEDULE_DOWN = '0 6 * * *';
    expect(askModelScheduleNotice(SELF_HOSTED, UNREACHABLE, at('2026-10-09T23:00:00Z'))).toContain('runs on a schedule');
  });

  it('says nothing definite when up and down disagree on the days', () => {
    process.env.ASK_SCHEDULE_UP = '45 7 * * 1-5';
    process.env.ASK_SCHEDULE_DOWN = '0 17 * * *';
    expect(askModelScheduleNotice(SELF_HOSTED, UNREACHABLE, at('2026-10-09T02:00:00Z'))).toContain('runs on a schedule');
  });
});

describe('askModelScheduleNotice — when the schedule is NOT the explanation', () => {
  it('is silent with no schedule configured', () => {
    process.env.ASK_SCHEDULE_ENABLED = 'false';
    expect(askModelScheduleNotice(SELF_HOSTED, UNREACHABLE, at('2026-10-09T02:00:00Z'))).toBeUndefined();
  });

  it('is silent when the variable is absent entirely (docker/minikube)', () => {
    delete process.env.ASK_SCHEDULE_ENABLED;
    expect(askModelScheduleNotice(SELF_HOSTED, UNREACHABLE, at('2026-10-09T02:00:00Z'))).toBeUndefined();
  });

  it('never blames the window for a CLOUD provider failing', () => {
    // An Anthropic overload at 02:00 has nothing to do with ask-model, and
    // telling the user "our model is off until 07:45" would be a lie.
    expect(askModelScheduleNotice('anthropic', UNREACHABLE, at('2026-10-09T02:00:00Z'))).toBeUndefined();
    expect(askModelScheduleNotice(undefined, UNREACHABLE, at('2026-10-09T02:00:00Z'))).toBeUndefined();
  });

  it('leaves non-connection failures their own message', () => {
    for (const other of [
      'model "qwen2.5-coder:7b" not found, try pulling it first',
      'This model\'s maximum context length is 8192 tokens',
      'AI is not configured: no provider API key is set and OPENAI_COMPATIBLE_BASE_URL is unset.',
    ]) {
      expect([other, askModelScheduleNotice(SELF_HOSTED, other, at('2026-10-09T02:00:00Z'))]).toEqual([other, undefined]);
    }
  });

  it('recognises the connection failures Node actually produces', () => {
    // A Service with no endpoints surfaces differently depending on whether DNS
    // resolved and how far the socket got; all of them mean "nothing there".
    for (const msg of ['connect ECONNREFUSED 10.0.1.5:11434', 'fetch failed', 'socket hang up', 'read ECONNRESET', 'getaddrinfo ENOTFOUND ask-model', 'terminated']) {
      expect([msg, askModelScheduleNotice(SELF_HOSTED, msg, at('2026-10-09T02:00:00Z'))]).not.toEqual([msg, undefined]);
    }
  });
});

describe('sendAskFailure — how the notice reaches the client', () => {
  const res = () => ({ headersSent: false, write: jest.fn<AnyFn>(), end: jest.fn<AnyFn>() }) as any;

  it('answers 503, not 500, before the stream opens', () => {
    const r = res();
    sendAskFailure(r, UNREACHABLE, 'Failed to answer the question', SELF_HOSTED, at('2026-10-09T02:00:00Z'));
    // 503 = temporarily unavailable by configuration, which is exactly true and
    // lets a client tell "come back later" from a genuine fault.
    expect(sendError).toHaveBeenCalledWith(r, 503, expect.stringContaining('switched off'), expect.any(String));
    expect(handleAIError).not.toHaveBeenCalled();
  });

  it('replaces the SSE error TEXT once headers are flushed', () => {
    const r = res();
    r.headersSent = true;
    sendAskFailure(r, UNREACHABLE, 'Failed to answer the question', SELF_HOSTED, at('2026-10-09T02:00:00Z'));
    // The status is long gone, so the text is the only thing left to fix.
    const written = (r.write.mock.calls as string[][]).map((c) => c[0]).join('');
    expect(written).toContain('"type":"error"');
    expect(written).toContain('switched off');
    expect(written).not.toContain('other side closed');
    expect(r.end).toHaveBeenCalled();
  });

  it('falls through to the normal error path when the schedule is not the cause', () => {
    const r = res();
    sendAskFailure(r, 'model not found', 'Failed to answer the question', SELF_HOSTED);
    // Unchanged behaviour: this is the branch every other failure takes.
    expect(handleAIError).toHaveBeenCalledWith(r, 'model not found', 'Failed to answer the question');
    expect(sendError).not.toHaveBeenCalled();
  });
});

/**
 * The PROACTIVE half: asked before a question is sent, so the panel can open
 * into help topics instead of inviting a turn that is going to fail.
 *
 * It shares `evaluateWindow` with the notice above, so the two can never
 * disagree about whether the model is scheduled off — the reason that logic was
 * extracted rather than reimplemented in the browser.
 *
 * The bias is deliberate and asymmetric: report `false` ONLY for a state we are
 * sure of. A wrong `false` replaces a working assistant with a help page, which
 * no user can argue with; a wrong `true` costs one failed turn that explains
 * itself.
 */
describe('askModelAvailability — can the assistant answer right now', () => {
  it('reports unavailable, with when it returns, outside the window', () => {
    const a = askModelAvailability(SELF_HOSTED, at('2026-10-09T02:00:00Z'));
    expect(a.available).toBe(false);
    if (a.available) throw new Error('unreachable');
    expect(a.reason).toBe('scheduled-off');
    expect(a.resumesAt).toBe('07:45 UTC');
    expect(a.message).toContain('switched off right now');
  });

  it('reports available INSIDE the window', () => {
    expect(askModelAvailability(SELF_HOSTED, at('2026-10-09T09:00:00Z')).available).toBe(true);
  });

  it('never blames the schedule for a CLOUD provider', () => {
    // The window scales `ask-model` only. A deployment answering from Anthropic
    // is up 24/7 regardless, and reporting it off would switch off a working
    // assistant for everyone on that deployment.
    expect(askModelAvailability('anthropic', at('2026-10-09T02:00:00Z')).available).toBe(true);
  });

  it('reports available when no schedule is configured', () => {
    process.env.ASK_SCHEDULE_ENABLED = 'false';
    expect(askModelAvailability(SELF_HOSTED, at('2026-10-09T02:00:00Z')).available).toBe(true);
  });

  it('reports available when the cron cannot be read', () => {
    // A step expression is legal cron this parser does not read. Unknown is not
    // the same as off: claiming off here would be a guess.
    process.env.ASK_SCHEDULE_UP = '*/15 7 * * *';
    expect(askModelAvailability(SELF_HOSTED, at('2026-10-09T02:00:00Z')).available).toBe(true);
  });

  it('reports not-configured, and does NOT promise a return, with no provider', () => {
    const a = askModelAvailability(undefined, at('2026-10-09T09:00:00Z'));
    expect(a.available).toBe(false);
    if (a.available) throw new Error('unreachable');
    expect(a.reason).toBe('not-configured');
    // Unlike the schedule, nothing brings this back on its own — so no time.
    expect(a.resumesAt).toBeUndefined();
  });

  it('agrees with the reactive notice at the same instant', () => {
    // The two paths are the whole reason evaluateWindow exists. If they can
    // disagree, a user is told "available" and then handed "switched off".
    const when = at('2026-10-09T02:00:00Z');
    const a = askModelAvailability(SELF_HOSTED, when);
    expect(a.available).toBe(false);
    if (a.available) throw new Error('unreachable');
    expect(a.message).toBe(askModelScheduleNotice(SELF_HOSTED, UNREACHABLE, when));
  });
});

/**
 * The window is read in `ASK_SCHEDULE_TIMEZONE`, matching each CronJob's
 * `spec.timeZone`.
 *
 * This is the half a fixed UTC offset cannot do. The scalers run an 08:00-17:00
 * Eastern business day; written as a constant offset that is an hour wrong for
 * the eight months the US spends on EDT, and the sentence the user reads would
 * name a window the cluster is not keeping.
 */
describe('askModelAvailability — reads the window in the configured zone', () => {
  beforeEach(() => {
    process.env.ASK_SCHEDULE_TIMEZONE = 'America/New_York';
    process.env.ASK_SCHEDULE_UP = '45 7 * * 1-5';
    process.env.ASK_SCHEDULE_DOWN = '0 17 * * 1-5';
  });

  it('is OPEN at 09:00 Eastern in winter (EST, UTC-5)', () => {
    // 2026-01-14 14:00Z = 09:00 EST, a Wednesday.
    const a = askModelAvailability(SELF_HOSTED, at('2026-01-14T14:00:00Z'));
    expect(a.available).toBe(true);
  });

  it('is OPEN at 09:00 Eastern in summer (EDT, UTC-4)', () => {
    // 2026-07-15 13:00Z = 09:00 EDT, a Wednesday. The SAME local time as above
    // at a DIFFERENT UTC instant — which is the whole point of the zone.
    const a = askModelAvailability(SELF_HOSTED, at('2026-07-15T13:00:00Z'));
    expect(a.available).toBe(true);
  });

  it('is CLOSED at 02:00 Eastern in summer', () => {
    // 2026-07-15 06:00Z = 02:00 EDT, well before the 07:45 scale-up.
    const a = askModelAvailability(SELF_HOSTED, at('2026-07-15T06:00:00Z'));
    expect(a.available).toBe(false);
    if (a.available) throw new Error('unreachable');
    expect(a.reason).toBe('scheduled-off');
  });

  it('names the zone the reader is actually in, per season', () => {
    const winter = askModelAvailability(SELF_HOSTED, at('2026-01-14T06:00:00Z'));
    const summer = askModelAvailability(SELF_HOSTED, at('2026-07-15T06:00:00Z'));
    if (winter.available || summer.available) throw new Error('expected both closed');
    // Not "America/New_York", and emphatically not a hardcoded "UTC".
    expect(winter.message).toContain('EST');
    expect(summer.message).toContain('EDT');
    expect(winter.message).toContain('Monday to Friday');
  });

  it('would be WRONG if the zone were ignored (the mechanism bites)', () => {
    // An instant where the two readings DISAGREE, or this proves nothing:
    // 11:00Z is 07:00 EDT — before the 07:45 open, so closed — while the same
    // instant read as UTC is 11:00, comfortably inside the window. A build that
    // ignored the zone would answer `available: true` here.
    const a = askModelAvailability(SELF_HOSTED, at('2026-07-15T11:00:00Z'));
    expect(a.available).toBe(false);
  });

  it('says nothing definite when the zone is unusable', () => {
    // An invalid zone makes Intl throw. Guessing in the wrong frame would be
    // worse than the cautious wording.
    process.env.ASK_SCHEDULE_TIMEZONE = 'Mars/Olympus_Mons';
    expect(askModelAvailability(SELF_HOSTED, at('2026-07-15T06:00:00Z')).available).toBe(true);
    const notice = askModelScheduleNotice(SELF_HOSTED, UNREACHABLE, at('2026-07-15T06:00:00Z'));
    expect(notice).toContain('may be switched off right now');
  });
});
