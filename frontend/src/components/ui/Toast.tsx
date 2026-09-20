import { createContext, useContext, useEffect, useRef, useState, useCallback, useMemo, type ReactNode } from 'react';
import { CheckCircle, XCircle, AlertTriangle, Info, X } from 'lucide-react';
import { DEFAULT_TOAST_DURATION_MS, ERROR_TOAST_DURATION_MS, MAX_VISIBLE_TOASTS, TOAST_OFFSET_CSS_VAR } from '@/lib/constants';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ToastType = 'success' | 'error' | 'warning' | 'info';

interface ToastItem {
  id: string;
  type: ToastType;
  message: string;
  duration: number;
  /** How many times this exact message fired while it was showing (dedupe). */
  count: number;
}

interface ToastContextValue {
  toast: (type: ToastType, message: string, duration?: number) => void;
  success: (message: string, duration?: number) => void;
  error: (message: string, duration?: number) => void;
  warning: (message: string, duration?: number) => void;
  info: (message: string, duration?: number) => void;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within a ToastProvider');
  return ctx;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const icons: Record<ToastType, typeof CheckCircle> = {
  success: CheckCircle,
  error: XCircle,
  warning: AlertTriangle,
  info: Info,
};

// One `--pb-*` status triple per severity (background / border / foreground),
// so the stack re-resolves with the theme rather than pairing a light class
// with a `dark:` one.
const typeStyles: Record<ToastType, string> = {
  success: 'bg-success-bg border-success-border text-success-strong',
  error: 'bg-danger-bg border-danger-border text-danger-strong',
  warning: 'bg-warning-bg border-warning-border text-warning-strong',
  info: 'bg-info-bg border-info-border text-info-strong',
};

let nextId = 0;

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/** Severity decides how long a toast stays when the caller doesn't say. */
function defaultDuration(type: ToastType): number {
  return type === 'error' || type === 'warning' ? ERROR_TOAST_DURATION_MS : DEFAULT_TOAST_DURATION_MS;
}

/**
 * Global toast stack.
 *
 * - Errors/warnings stay {@link ERROR_TOAST_DURATION_MS}; success/info
 *   {@link DEFAULT_TOAST_DURATION_MS}. Every toast can be dismissed sooner.
 * - An identical message (same type + text) already on screen is not stacked
 *   again: its timer restarts and it shows a "×N" count.
 * - At most {@link MAX_VISIBLE_TOASTS} show; older ones collapse into a
 *   "+N more" row that can dismiss them all.
 * - The stack sits above any bottom bar that publishes its height in
 *   {@link TOAST_OFFSET_CSS_VAR} (BulkActionBar does).
 * - Only errors interrupt a screen reader (role=alert, assertive); everything
 *   else is announced politely (role=status) so it doesn't cut off whatever
 *   the user is reading.
 * - The slide-in is the `.toast-item` CSS animation, not framer-motion: the
 *   stack mounts on every route (the provider sits in `_app`), and a fade plus
 *   an 8px rise is not worth an animation runtime. Dismissal is immediate —
 *   a CSS exit would have to keep the node mounted, and a toast that lingers
 *   after you close it is worse than one that simply goes.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  // THE stack — not a mirror of `toasts`. `addToast` has to read the current
  // list synchronously (to dedupe and to know the id it must arm a timer for),
  // which state can't give it mid-tick, so the ref is authoritative and
  // `setToasts` simply publishes it. Every mutation below goes through
  // `commit`: when only `addToast` wrote the ref back, a dismiss-then-toast in
  // the same tick re-committed the list as it was BEFORE the dismiss, putting
  // the just-removed toast back on screen.
  const toastsRef = useRef<ToastItem[]>([]);
  const commit = useCallback((next: (prev: ToastItem[]) => ToastItem[]) => {
    toastsRef.current = next(toastsRef.current);
    setToasts(toastsRef.current);
  }, []);
  // Track every auto-dismiss timer so a manual close or provider unmount
  // can cancel it. Without this, a closed toast's expiry timer keeps
  // running and calls setState on an unmounted component (a leak in
  // tests; a stale update in long-lived SPAs).
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const clearTimer = useCallback((id: string) => {
    const timer = timersRef.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  const removeToast = useCallback((id: string) => {
    clearTimer(id);
    commit((prev) => prev.filter((t) => t.id !== id));
  }, [clearTimer, commit]);

  const armTimer = useCallback((id: string, duration: number) => {
    clearTimer(id);
    if (duration > 0) timersRef.current.set(id, setTimeout(() => removeToast(id), duration));
  }, [clearTimer, removeToast]);

  const addToast = useCallback((type: ToastType, message: string, duration = defaultDuration(type)) => {
    const existing = toastsRef.current.find((t) => t.type === type && t.message === message);
    if (existing) {
      const bumped = { ...existing, count: existing.count + 1, duration };
      // Move it to the newest slot so a repeat stays visible under the cap.
      commit((prev) => [...prev.filter((t) => t.id !== existing.id), bumped]);
      armTimer(existing.id, duration);
      return;
    }
    const id = String(++nextId);
    commit((prev) => [...prev, { id, type, message, duration, count: 1 }]);
    armTimer(id, duration);
  }, [armTimer, commit]);

  const dismissMany = useCallback((ids: string[]) => {
    for (const id of ids) clearTimer(id);
    const drop = new Set(ids);
    commit((prev) => prev.filter((t) => !drop.has(t.id)));
  }, [clearTimer, commit]);

  // Cancel any pending dismiss timers on unmount.
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  // Memoize so every `useToast()` consumer doesn't re-render on each toast
  // add/remove (the provider re-renders whenever `toasts` changes). `addToast`
  // is a stable useCallback, so the value identity is stable for the session.
  const value = useMemo<ToastContextValue>(() => ({
    toast: addToast,
    success: (msg, dur) => addToast('success', msg, dur),
    error: (msg, dur) => addToast('error', msg, dur),
    warning: (msg, dur) => addToast('warning', msg, dur),
    info: (msg, dur) => addToast('info', msg, dur),
  }), [addToast]);

  const hidden = toasts.slice(0, Math.max(0, toasts.length - MAX_VISIBLE_TOASTS));
  const visible = toasts.slice(hidden.length);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="fixed right-4 z-[100] flex flex-col gap-2 max-w-sm transition-[bottom] duration-200"
        style={{ bottom: `calc(1rem + var(${TOAST_OFFSET_CSS_VAR}, 0px))` }}
        data-testid="toast-stack"
      >
        {hidden.length > 0 && (
          <div className="flex items-center justify-between gap-3 px-3 py-1.5 rounded-lg border border-default bg-surface text-xs text-fg-muted shadow">
            <span>+{hidden.length} more</span>
            <button
              type="button"
              onClick={() => dismissMany(hidden.map((t) => t.id))}
              className="font-medium hover:underline"
            >
              Dismiss older
            </button>
          </div>
        )}
        {visible.map((t) => {
          const Icon = icons[t.type];
          const urgent = t.type === 'error';
          return (
            <div
              key={t.id}
              role={urgent ? 'alert' : 'status'}
              aria-live={urgent ? 'assertive' : 'polite'}
              className={`toast-item flex items-start gap-3 px-4 py-3 rounded-xl border shadow-lg backdrop-blur-sm ${typeStyles[t.type]}`}
            >
              <Icon className="w-5 h-5 flex-shrink-0 mt-0.5" aria-hidden />
              <p className="text-sm font-medium flex-1">{t.message}</p>
              {t.count > 1 && (
                <span className="flex-shrink-0 text-xs font-semibold opacity-80" aria-label={`repeated ${t.count} times`}>
                  ×{t.count}
                </span>
              )}
              <button
                onClick={() => removeToast(t.id)}
                className="flex-shrink-0 opacity-60 hover:opacity-100 transition-opacity"
                aria-label="Dismiss notification"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
