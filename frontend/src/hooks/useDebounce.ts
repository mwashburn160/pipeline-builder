/**
 * Generic debounce hook for delaying rapidly-changing values.
 */
import { useState, useEffect } from 'react';

/**
 * Returns a debounced version of `value` that only updates after `delay` ms of inactivity.
 * Useful for deferring expensive operations (e.g. API calls) triggered by user input.
 *
 * @param value - The value to debounce
 * @param delay - Debounce delay in milliseconds
 * @returns The debounced value
 */
export function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debouncedValue;
}
