// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Copy, Check, X } from 'lucide-react';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import { COPY_FEEDBACK_RESET_MS } from '@/lib/constants';

interface Props {
  /** The full value to copy. */
  value: string;
  /** Optional shorter display string — defaults to `value`. Useful for
   *  showing a truncated ObjectId like `…a1b2c3` while still copying the
   *  full thing. */
  display?: string;
  /** Visual size, matching the rest of the primitive UI library. */
  size?: 'sm' | 'md' | 'lg';
}

const CODE_CLASS: Record<NonNullable<Props['size']>, string> = {
  sm: 'text-xs',
  md: 'text-sm',
  lg: 'text-base',
};

/**
 * Inline `<code>id</code>` + tiny copy icon. Built for tables / dl rows
 * where the full ObjectId is the truth but a giant copy button would
 * dominate the cell. The bigger `CopyButton` from this directory is
 * still the right choice for one-off "copy command" boxes.
 */
export function CopyableId({ value, display, size }: Props) {
  const effectiveSize: NonNullable<Props['size']> = size ?? 'md';
  const { state, copy } = useCopyToClipboard(COPY_FEEDBACK_RESET_MS);

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    void copy(value);
  };

  return (
    <span className="inline-flex items-center gap-1.5 align-middle">
      <code className={`${CODE_CLASS[effectiveSize]} text-gray-700 dark:text-gray-300 break-all`}>
        {display ?? value}
      </code>
      <button
        type="button"
        onClick={handleClick}
        title={state === 'copied' ? 'Copied!' : state === 'failed' ? 'Copy failed' : 'Copy to clipboard'}
        aria-label="Copy to clipboard"
        className="inline-flex h-5 w-5 items-center justify-center rounded text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-200"
      >
        {state === 'copied' ? (
          <Check className="h-3.5 w-3.5 text-green-500" />
        ) : state === 'failed' ? (
          <X className="h-3.5 w-3.5 text-red-500" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
      </button>
    </span>
  );
}
