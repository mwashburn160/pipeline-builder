// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useId, type ButtonHTMLAttributes, type MouseEvent, type ReactNode, type Ref } from 'react';
import { Loader2 } from 'lucide-react';
import { buttonClasses } from './buttonClasses';
import { READ_ONLY_REASON } from './ReadOnlyNotice';
import { Tooltip } from './Tooltip';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'success' | 'ghost' | 'danger-outline' | 'outline' | 'indigo' | 'purple' | 'orange' | 'link';
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Colour variant → maps to the `.btn-*` classes in globals.css. */
  variant?: ButtonVariant;
  /** Size → maps to `.btn-xs/.btn-sm/.btn-lg` (`md` is the base `.btn`). */
  size?: ButtonSize;
  /** Stretch to the container width (`.btn-full`). */
  fullWidth?: boolean;
  /** Show a leading spinner and disable the button while an action is in flight. */
  loading?: boolean;
  /**
   * Read-only session (impersonation): the button is unavailable with
   * `READ_ONLY_REASON` as its `disabledReason` (replacing any `title`). Use it
   * for write controls instead of wiring `disabled` + `title` by hand.
   */
  readOnly?: boolean;
  /**
   * Why the action is unavailable (a missing permission, nothing to act on).
   * When set, the button is `aria-disabled` instead of natively `disabled`, so
   * it stays FOCUSABLE — a keyboard or screen-reader user can reach it and learn
   * why — activation is swallowed, and the reason is exposed as the button's
   * accessible description (`aria-describedby`) and shown in the focus-aware
   * Tooltip. Prefer this over `disabled` + `title`: a natively disabled button
   * is skipped by Tab, and `title` never shows on keyboard focus or touch.
   * Falsy means available (subject to `disabled`).
   */
  disabledReason?: string | null | false;
  /** React 19 passes `ref` as a regular prop; it's spread onto the native
   *  `<button>` so callers can grab the DOM node (e.g. a dialog focusing its
   *  primary action once it knows which one that is). Mirrors `Input`. */
  ref?: Ref<HTMLButtonElement>;
  children: ReactNode;
}

/**
 * Typed wrapper over the `.btn` CSS layer. Defaults `type="button"` (native
 * default is `submit`, a common footgun) and folds `loading` into the disabled
 * state, and `readOnly` / `disabledReason` into the explained-unavailable state,
 * so callers don't repeat the spinner / reason wiring by hand.
 */
export function Button({
  variant = 'primary', size = 'md', fullWidth = false, loading = false, readOnly = false,
  disabledReason, disabled, title, type = 'button', className = '', children, onClick,
  'aria-describedby': describedBy, ...props
}: ButtonProps) {
  const reasonId = useId();
  const classes = buttonClasses(variant, size, fullWidth, className);
  const reason = readOnly ? READ_ONLY_REASON : disabledReason || undefined;

  if (!reason) {
    return (
      <button
        type={type}
        disabled={disabled || loading}
        title={title}
        className={classes}
        onClick={onClick}
        aria-describedby={describedBy}
        {...props}
      >
        {loading && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" aria-hidden />}
        {children}
      </button>
    );
  }

  // Unavailable WITH a reason: focusable, inert, and explained.
  const swallow = (e: MouseEvent<HTMLButtonElement>) => {
    // Also stops a `type="submit"` from submitting its form.
    e.preventDefault();
    e.stopPropagation();
  };
  const wide = fullWidth || /(^|\s)w-full(\s|$)/.test(className);
  return (
    <Tooltip content={reason} multiline className={wide ? 'w-full' : undefined}>
      <button
        type={type}
        aria-disabled="true"
        className={classes}
        onClick={swallow}
        aria-describedby={describedBy ? `${describedBy} ${reasonId}` : reasonId}
        {...props}
      >
        {children}
      </button>
      <span id={reasonId} className="sr-only">{reason}</span>
    </Tooltip>
  );
}
