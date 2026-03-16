import { forwardRef, type SelectHTMLAttributes } from 'react';

interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children'> {
  options: SelectOption[];
  placeholder?: string;
  variant?: 'default' | 'filter';
  error?: boolean;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ options, placeholder, variant = 'default', error = false, className = '', ...props }, ref) => {
    const baseClass = variant === 'filter' ? 'filter-select' : 'input';
    const errorClass = error ? 'border-red-500 dark:border-red-500 focus:ring-red-500/40' : '';

    return (
      <select
        ref={ref}
        className={`${baseClass} ${errorClass} ${className}`}
        aria-invalid={error || undefined}
        {...props}
      >
        {placeholder && <option value="">{placeholder}</option>}
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    );
  },
);

Select.displayName = 'Select';
