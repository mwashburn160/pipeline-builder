// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Keep the Ask transcript across a drawer close.
 *
 * The panel is mounted as `{askOpen && <AskPanel/>}`, so closing it UNMOUNTS
 * the component and `useState` took the whole conversation with it. Clicking
 * outside the drawer is enough to lose a long answer, and there was no way to
 * read an answer while navigating the dashboard it describes — which is most of
 * what the answers are about.
 *
 * `sessionStorage`, deliberately, not `localStorage`: a transcript is a working
 * context for the tab the reader is in, not something to resurrect weeks later
 * on a shared machine. It dies with the tab.
 *
 * Nothing here is load-bearing. Every read and write is wrapped, because the
 * accessor itself THROWS (not returns null) in a private window or with site
 * data blocked, and a panel that cannot restore a transcript must still open.
 */

/** Per-tab key. Versioned so a shape change cannot resurrect as a wrong-typed blob. */
const KEY = 'pb.ask.transcript.v1';

/**
 * Cap on the stored JSON.
 *
 * A transcript carrying drafted plugins (config + Dockerfile) grows quickly,
 * and `sessionStorage` throws `QuotaExceededError` when it is full — which, in
 * a shared try/catch, would silently stop persisting ANYTHING from then on.
 * Dropping the oldest turns keeps the recent conversation, which is the part
 * worth keeping.
 */
const MAX_BYTES = 256 * 1024;

/**
 * Persist a transcript, trimming from the FRONT until it fits.
 *
 * @param messages - Serializable chat turns. Anything non-JSON (a React node,
 *   a function) must never reach this.
 */
export function saveTranscript<T>(messages: readonly T[]): void {
  try {
    if (messages.length === 0) {
      window.sessionStorage.removeItem(KEY);
      return;
    }
    let slice = messages.slice();
    let json = JSON.stringify(slice);
    // Drop the oldest turn at a time rather than halving: a transcript is
    // usually one oversized draft away from fitting.
    while (json.length > MAX_BYTES && slice.length > 1) {
      slice = slice.slice(1);
      json = JSON.stringify(slice);
    }
    // A single turn still over the cap is not worth corrupting the store for.
    if (json.length > MAX_BYTES) return;
    window.sessionStorage.setItem(KEY, json);
  } catch {
    // Private window, blocked site data, or a full quota. Not persisting a
    // transcript is never a reason to break the panel.
  }
}

/** The stored transcript, or an empty list when there is none or it is unreadable. */
export function loadTranscript<T>(): T[] {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    // Anything but an array means a different writer or a corrupted value;
    // treat it as absent rather than handing the panel a non-iterable.
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/** Forget the transcript — the "Clear" control, and an empty transcript. */
export function clearTranscript(): void {
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    // See saveTranscript.
  }
}
