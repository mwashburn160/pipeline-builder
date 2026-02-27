import { useEffect } from 'react';

/** Props for the Toast component. */
interface ToastProps {
  /** Text displayed in the toast notification */
  message: string;
  /** Visual style variant: green for success, red for error */
  type: 'success' | 'error';
  /** Callback fired when the toast auto-dismisses */
  onDone: () => void;
  /** Time in milliseconds before the toast auto-dismisses; defaults to 3500 */
  duration?: number;
}

/** Fixed-position toast notification that auto-dismisses after a configurable duration. */
export function Toast({ message, type, onDone, duration = 3500 }: ToastProps) {
  useEffect(() => {
    const t = setTimeout(onDone, duration);
    return () => clearTimeout(t);
  }, [onDone, duration]);

  return (
    <div
      role="alert"
      aria-live="assertive"
      className={`fixed bottom-6 right-6 z-50 px-5 py-3 rounded-xl text-sm font-medium shadow-lg backdrop-blur-sm transition-all ${
        type === 'error'
          ? 'bg-red-50/90 text-red-800 border border-red-200 dark:bg-red-900/90 dark:text-red-200 dark:border-red-800'
          : 'bg-green-50/90 text-green-800 border border-green-200 dark:bg-green-900/90 dark:text-green-200 dark:border-green-800'
      }`}
    >
      {message}
    </div>
  );
}
