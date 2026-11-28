// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Real user activity, shared by every tab of this browser.
 *
 * The platform signs an interactive session out after `idleTimeoutMinutes`
 * without ACTIVITY, and only the browser can tell activity from a background
 * poll: a visible tab keeps calling the API (and so refreshing its token) with
 * nobody at the keyboard. This tracker is the one source of "somebody is
 * here": pointer, key, touch and wheel input — never a request, a timer, a
 * visibility change or a scroll (code scrolls too: a live log tail, a
 * streaming answer; a person's own scroll arrives as one of the inputs).
 * The API client reads it to mark a refresh `activity: 'user' | 'passive'`;
 * the idle guard reads it to time the warning.
 *
 * Input in ANY tab counts, so activity is shared over a BroadcastChannel —
 * falling back to the `storage` event where there is none — and the latest
 * moment is also kept in localStorage so a page opened later starts from it.
 * It is a timestamp, not a credential.
 */

/** DOM input that proves a person is present. */
export const ACTIVITY_EVENTS = ['pointermove', 'pointerdown', 'keydown', 'touchstart', 'wheel'] as const;

/** At most one recorded activity per window: pointer moves fire dozens of times a second. */
export const ACTIVITY_THROTTLE_MS = 5_000;

const CHANNEL_NAME = 'pipeline-builder:activity';
const STORAGE_KEY = 'pb.activity';

type ActivityMessage = { type: 'activity'; at: number };

function readStored(): number {
  try {
    const n = Number(localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function writeStored(at: number): void {
  try { localStorage.setItem(STORAGE_KEY, String(at)); } catch { /* storage blocked — the channel still shares it */ }
}

export class ActivityTracker {
  private last = 0;
  private lastInputRecordedAt = Number.NEGATIVE_INFINITY;
  private suspended = false;
  private listeners = new Set<(at: number) => void>();
  private channel: BroadcastChannel | null = null;
  /** `start()` calls not yet stopped — the DOM listeners live while any is open. */
  private starts = 0;

  /** The latest real activity in any tab (ms), or 0 when none is known. */
  lastActivityAt(): number {
    return this.last;
  }

  /**
   * While suspended (the inactivity warning is showing), ambient input in THIS
   * tab is ignored, so a nudge of the mouse can't dismiss the warning unseen —
   * the person answers it. Activity from other tabs, and {@link record}, still count.
   */
  setSuspended(suspended: boolean): void {
    this.suspended = suspended;
  }

  /** Record deliberate activity now (e.g. "Stay signed in") — never throttled or suspended. */
  record(at: number = Date.now()): void {
    this.apply(at, true);
  }

  /** Called with the new timestamp whenever activity (here or in another tab) moves it. */
  subscribe(callback: (at: number) => void): () => void {
    this.listeners.add(callback);
    return () => { this.listeners.delete(callback); };
  }

  /**
   * Listen for input and for the other tabs. Reference-counted: every caller
   * gets its own stop function, and the listeners go once all have stopped.
   */
  start(): () => void {
    if (typeof window === 'undefined') return () => undefined;
    if (this.starts++ === 0) this.attach();
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      if (--this.starts === 0) this.detach();
    };
  }

  /** Forget everything (tests). */
  resetForTests(): void {
    this.last = 0;
    this.lastInputRecordedAt = Number.NEGATIVE_INFINITY;
    this.suspended = false;
  }

  private readonly onInput = (): void => {
    if (this.suspended) return;
    const now = Date.now();
    if (now - this.lastInputRecordedAt < ACTIVITY_THROTTLE_MS) return;
    this.lastInputRecordedAt = now;
    this.apply(now, true);
  };

  private readonly onStorage = (event: StorageEvent): void => {
    if (event.key !== STORAGE_KEY || !event.newValue) return;
    const at = Number(event.newValue);
    if (Number.isFinite(at) && at > 0) this.apply(at, false);
  };

  private apply(at: number, share: boolean): void {
    if (at <= this.last) return;
    this.last = at;
    if (share) {
      writeStored(at);
      try { this.channel?.postMessage({ type: 'activity', at } satisfies ActivityMessage); } catch { /* closed channel */ }
    }
    this.listeners.forEach((cb) => {
      try { cb(at); } catch { /* a listener's fault is its own */ }
    });
  }

  private attach(): void {
    this.last = Math.max(this.last, readStored());
    for (const type of ACTIVITY_EVENTS) {
      window.addEventListener(type, this.onInput, { capture: true, passive: true });
    }
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        this.channel = new BroadcastChannel(CHANNEL_NAME);
        this.channel.onmessage = (event: MessageEvent<ActivityMessage>) => {
          const at = event.data?.type === 'activity' ? Number(event.data.at) : NaN;
          if (Number.isFinite(at) && at > 0) this.apply(at, false);
        };
        return;
      } catch {
        this.channel = null;
      }
    }
    // No BroadcastChannel: the `storage` event (fired in the OTHER tabs by the
    // localStorage write every recorded activity makes) carries it instead.
    window.addEventListener('storage', this.onStorage);
  }

  private detach(): void {
    for (const type of ACTIVITY_EVENTS) {
      window.removeEventListener(type, this.onInput, { capture: true });
    }
    window.removeEventListener('storage', this.onStorage);
    try { this.channel?.close(); } catch { /* already closed */ }
    this.channel = null;
  }
}

/** This page's tracker — the API client and the idle guard share it. */
export const activityTracker = new ActivityTracker();
