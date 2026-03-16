import { type ReactNode } from 'react';
import { AlertCircle, CheckCircle } from 'lucide-react';

interface FormFieldProps {
  label: string;
  id?: string;
  error?: string;
  hint?: string;
  className?: string;
  children: ReactNode;
  required?: boolean;
  success?: string;
}

export function FormField({ label, id, error, hint, className, children, required, success }: FormFieldProps) {
  return (
    <div className={className}>
      <label className="label" htmlFor={id}>
        {label}
        {required && <span className="text-red-500 ml-0.5">*</span>}
      </label>
      {children}
      {error && (
        <p className="mt-1 text-xs text-red-600 dark:text-red-400 flex items-center gap-1">
          <AlertCircle className="w-3 h-3 flex-shrink-0" />
          {error}
        </p>
      )}
      {success && !error && (
        <p className="mt-1 text-xs text-green-600 dark:text-green-400 flex items-center gap-1">
          <CheckCircle className="w-3 h-3 flex-shrink-0" />
          {success}
        </p>
      )}
      {hint && !error && !success && <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{hint}</p>}
    </div>
  );
}
