import { type ReactNode, isValidElement, cloneElement, useId } from 'react';
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
  const autoId = useId();
  const fieldId = id ?? autoId;
  const errorId = error ? `${fieldId}-error` : undefined;
  const hintId = hint && !error && !success ? `${fieldId}-hint` : undefined;
  const successId = success && !error ? `${fieldId}-success` : undefined;
  const describedBy = [errorId, successId, hintId].filter(Boolean).join(' ') || undefined;

  const enhancedChildren = isValidElement<Record<string, unknown>>(children)
    ? cloneElement(children, {
      id: fieldId,
      'aria-invalid': error ? true : undefined,
      'aria-describedby': describedBy,
      className: [
        children.props.className as string | undefined,
        error ? 'input-error' : '',
        success && !error ? 'input-success' : '',
      ]
        .filter(Boolean)
        .join(' '),
    })
    : children;

  return (
    <div className={`form-field ${className ?? ''}`}>
      <label className="label" htmlFor={fieldId}>
        {label}
        {required && <span className="text-red-500 ml-0.5">*</span>}
      </label>
      {enhancedChildren}
      {error && (
        <p id={errorId} className="form-error" role="alert">
          <AlertCircle className="w-3 h-3 flex-shrink-0" />
          {error}
        </p>
      )}
      {success && !error && (
        <p id={successId} className="form-success">
          <CheckCircle className="w-3 h-3 flex-shrink-0" />
          {success}
        </p>
      )}
      {hint && !error && !success && <p id={hintId} className="form-hint">{hint}</p>}
    </div>
  );
}
