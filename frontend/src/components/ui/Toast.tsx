import { useEffect } from 'react';

interface ToastProps {
  message: string;
  type: 'success' | 'error';
  onDone: () => void;
  duration?: number;
}

export function Toast({ message, type, onDone, duration = 3500 }: ToastProps) {
  useEffect(() => {
    const t = setTimeout(onDone, duration);
    return () => clearTimeout(t);
  }, [onDone, duration]);

  return (
    <div
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
