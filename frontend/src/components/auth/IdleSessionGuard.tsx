// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from 'react';
import { Timer } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { useAuth } from '@/hooks/useAuth';
import api from '@/lib/api';
import { activityTracker } from '@/lib/session/activity';

/** How long before the idle deadline the warning shows. */
export const IDLE_WARNING_MS = 2 * 60_000;

/** How often the guard re-reads the deadline (and the countdown ticks). */
const TICK_MS = 1000;

/** Least time between two activity reports, so a failing refresh is not retried every tick. */
const REPORT_RETRY_MS = 15_000;

/** `m:ss` for the visual countdown. */
function clock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * The spoken / written remaining time. Coarse on purpose — it is the
 * `aria-live` text, and a screen reader must not be handed a new sentence every
 * second: whole minutes while more than one is left, then 15-second steps.
 */
function remainingWords(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  if (seconds > 60) return `${Math.ceil(seconds / 60)} minutes`;
  return `${Math.max(15, Math.ceil(seconds / 15) * 15)} seconds`;
}

/**
 * Signs an unattended interactive session out — in every tab — after its idle
 * timeout (`idleTimeoutMinutes`, the strictest of the platform ceiling and the
 * org's policy), warning first. Mounted once, by `_app`.
 *
 * The deadline is the later of the session's last activity as the SERVER
 * recorded it and the latest real input in any tab (`activityTracker`), plus
 * the timeout. Polling never moves it: requests are not input, and a polling
 * tab's refreshes are `passive`. Input the server has not heard about yet is
 * reported (a `user` refresh) by halfway to the server's deadline, so the
 * server never refuses a refresh the browser still thinks is in time.
 *
 * {@link IDLE_WARNING_MS} before the deadline a dialog counts down; ambient
 * input in this tab no longer counts then (the person answers it): "Stay
 * signed in" records activity and refreshes at once, "Sign out" signs out.
 * At the deadline the session is signed out with the inactivity reason, which
 * the API client broadcasts to the other tabs (whose own guards would reach
 * the same deadline anyway) and the sign-in page explains.
 */
export function IdleSessionGuard() {
  const { user, logout } = useAuth();
  const [remainingMs, setRemainingMs] = useState<number | null>(null);
  const stayRef = useRef<HTMLButtonElement>(null);
  const lastReportRef = useRef(Number.NEGATIVE_INFINITY);
  const signingOutRef = useRef(false);
  const logoutRef = useRef(logout);
  logoutRef.current = logout;

  const signedIn = !!user;

  const tick = useCallback(() => {
    const idle = api.getSessionIdle();
    if (!idle || !api.isAuthenticated()) {
      setRemainingMs(null);
      return;
    }
    const now = Date.now();
    const timeoutMs = idle.idleTimeoutMinutes * 60_000;
    const lastActivity = activityTracker.lastActivityAt();

    // Keep the server's idle clock in step with input it has not been told of.
    if (lastActivity > idle.lastActiveAt && now - idle.lastActiveAt >= timeoutMs / 2
      && now - lastReportRef.current >= REPORT_RETRY_MS) {
      lastReportRef.current = now;
      void api.reportActivity().catch(() => undefined);
    }

    const deadline = Math.max(lastActivity, idle.lastActiveAt) + timeoutMs;
    const left = deadline - now;
    if (left <= 0) {
      setRemainingMs(null);
      // Once per session: the sign-out ends it (and this guard's run with it).
      if (signingOutRef.current) return;
      signingOutRef.current = true;
      void logoutRef.current({ reason: 'idle', idleTimeoutMinutes: idle.idleTimeoutMinutes }).catch(() => undefined);
      return;
    }
    setRemainingMs(left <= IDLE_WARNING_MS ? left : null);
  }, []);

  // Track input for as long as someone is signed in; re-evaluate on every
  // change of the idle state and every second.
  useEffect(() => {
    if (!signedIn) return;
    signingOutRef.current = false;
    const stopTracking = activityTracker.start();
    const unsubscribeIdle = api.onSessionIdleChange(tick);
    const unsubscribeActivity = activityTracker.subscribe(tick);
    const timer = setInterval(tick, TICK_MS);
    tick();
    return () => {
      clearInterval(timer);
      unsubscribeActivity();
      unsubscribeIdle();
      stopTracking();
      activityTracker.setSuspended(false);
    };
  }, [signedIn, tick]);

  const warning = remainingMs !== null;
  useEffect(() => {
    activityTracker.setSuspended(warning);
  }, [warning]);

  const staySignedIn = useCallback(() => {
    // Claimed first, so the tick the recorded activity triggers does not send
    // a second report of the same click.
    lastReportRef.current = Date.now();
    activityTracker.record();
    void api.reportActivity().catch(() => undefined);
    tick();
  }, [tick]);

  const signOut = useCallback(() => {
    setRemainingMs(null);
    void logoutRef.current().catch(() => undefined);
  }, []);

  if (!signedIn || remainingMs === null) return null;

  return (
    <Modal
      title="Are you still there?"
      titleIcon={<Timer className="h-5 w-5 text-warning shrink-0" aria-hidden="true" />}
      // Escape, the close button and the backdrop are all a person answering:
      // they count as "Stay signed in".
      onClose={staySignedIn}
      initialFocusRef={stayRef}
    >
      <div className="space-y-4">
        <p className="text-sm text-fg" aria-live="polite" aria-atomic="true">
          You&apos;ll be signed out in {remainingWords(remainingMs)} for inactivity.
        </p>
        <p className="text-3xl font-semibold tabular-nums text-center" role="timer" aria-label="Time left before sign-out">
          {clock(remainingMs)}
        </p>
        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <Button type="button" variant="secondary" onClick={signOut}>
            Sign out
          </Button>
          <Button ref={stayRef} type="button" variant="primary" onClick={staySignedIn}>
            Stay signed in
          </Button>
        </div>
      </div>
    </Modal>
  );
}
