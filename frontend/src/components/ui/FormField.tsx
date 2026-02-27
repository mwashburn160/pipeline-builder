import type { ReactNode } from 'react';

/** Props for the FormField component. */
interface FormFieldProps {
  /** Label text displayed above the input */
  label: string;
  /** Optional id linking the label to its form control via htmlFor */
  id?: string;
  /** Validation error message shown below the input in red */
  error?: string;
  /** Helper text shown below the input when there is no error */
  hint?: string;
  /** Additional CSS classes for the wrapper div */
  className?: string;
  /** The form control (input, select, textarea, etc.) */
  children: ReactNode;
}

/** Form field wrapper that renders a label, the input control, and an error or hint message. */
export function FormField({ label, id, error, hint, className, children }: FormFieldProps) {
  return (
    <div className={className}>
      <label className="label" htmlFor={id}>{label}</label>
      {children}
      {error && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>}
      {hint && !error && <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{hint}</p>}
    </div>
  );
}
