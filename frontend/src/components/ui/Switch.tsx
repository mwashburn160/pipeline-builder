// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Accessible name — required (there's no visible label inside the control). */
  'aria-label'?: string;
  'aria-labelledby'?: string;
  id?: string;
}

/**
 * Accessible on/off toggle (`role="switch"`) — brand-filled when on. Replaces the
 * raw `<input type="checkbox">` used for boolean settings. Keyboard-operable
 * (Space/Enter) and reports `aria-checked`.
 */
export function Switch({ checked, onChange, disabled = false, id, ...aria }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={aria['aria-label']}
      aria-labelledby={aria['aria-labelledby']}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      className={[
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pb-brand)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--pb-surface)]',
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
        checked ? 'bg-[var(--pb-brand)]' : 'bg-[var(--pb-border)]',
      ].join(' ')}
    >
      <span
        className={[
          'inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform',
          checked ? 'translate-x-[22px]' : 'translate-x-0.5',
        ].join(' ')}
      />
    </button>
  );
}
