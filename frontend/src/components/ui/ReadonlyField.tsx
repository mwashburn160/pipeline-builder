import { type ReactNode } from 'react';

interface ReadonlyFieldProps {
  /** Field label shown above the value. */
  label: string;
  /** The read-only value to display in the gray box. */
  value: ReactNode;
  /** Extra classes for the wrapping element (e.g. `col-span-2`). */
  className?: string;
  /** Extra classes for the value box (e.g. `font-mono`, `break-all`). */
  valueClassName?: string;
}

/**
 * A labeled, read-only "gray-box" field: a small label above a muted, rounded
 * value box. Used in the System Information sections of the edit modals.
 */
export function ReadonlyField({ label, value, className, valueClassName }: ReadonlyFieldProps) {
  return (
    <div className={className}>
      <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">{label}</label>
      <p className={`text-sm text-gray-700 dark:text-gray-300 bg-gray-50 dark:bg-gray-800 px-2 py-1 rounded-lg${valueClassName ? ` ${valueClassName}` : ''}`}>{value}</p>
    </div>
  );
}
