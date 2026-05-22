// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from 'react';
import { Copy, Check, X } from 'lucide-react';
import { COPY_FEEDBACK_RESET_MS } from '@/lib/constants';

interface Props {
  /** The full value to copy. */
  value: string;
  /** Optional shorter display string — defaults to `value`. Useful for
   *  showing a truncated ObjectId like `…a1b2c3` while still copying the
   *  full thing. */
  display?: string;
  /** Adds `text-xs` instead of the default `text-sm` for tighter rows. */
  small?: boolean;
}

/**
 * Inline `<code>id</code>` + tiny copy icon. Built for tables / dl rows
 * where the full ObjectId is the truth but a giant copy button would
 * dominate the cell. The bigger `CopyButton` from this directory is
 * still the right choice for one-off "copy command" boxes.
 */
export function CopyableId({ value, display, small }: Props) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    clearTimeout(timerRef.current);
    try {
      await navigator.clipboard.writeText(value);
      setState('copied');
    } catch {
      setState('failed');
    }
    timerRef.current = setTimeout(() => setState('idle'), COPY_FEEDBACK_RESET_MS);
  };

  const codeClass = small ? 'text-xs' : 'text-sm';

  return (
    <span className="inline-flex items-center gap-1.5 align-middle">
      <code className={`${codeClass} text-gray-700 dark:text-gray-300 break-all`}>
        {display ?? value}
      </code>
      <button
        type="button"
        onClick={copy}
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
