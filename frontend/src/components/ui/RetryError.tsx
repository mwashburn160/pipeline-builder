// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from 'react';
import { AlertCircle } from 'lucide-react';
import { Callout } from './Callout';

interface RetryErrorProps {
  /** What failed. A string or rich content (e.g. the server's error + a hint). */
  message?: ReactNode;
  /** Optional bold lead-in, e.g. "Couldn't load members". */
  title?: ReactNode;
  onRetry: () => void;
  /** A retry is in flight: the button disables and says so, so a second click
   *  can't stack another request behind the first. */
  retrying?: boolean;
  /** Button text. Defaults to "Retry". */
  retryLabel?: string;
  className?: string;
}

/**
 * The "something failed — Retry" box, standardized. Replaces the identical
 * red-bordered box + underlined Retry link hand-rolled in settings, incident
 * settings, and the PAT section. Announced as an alert (via `Callout`).
 */
export function RetryError({
  message = 'Something went wrong.', title, onRetry, retrying = false, retryLabel = 'Retry', className,
}: RetryErrorProps) {
  return (
    <Callout variant="danger" icon={AlertCircle} title={title} className={className}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>{message}</span>
        <button
          type="button"
          onClick={onRetry}
          disabled={retrying}
          aria-busy={retrying || undefined}
          className="font-medium underline hover:opacity-80 disabled:opacity-60 disabled:no-underline disabled:cursor-wait"
        >
          {retrying ? 'Retrying…' : retryLabel}
        </button>
      </div>
    </Callout>
  );
}
