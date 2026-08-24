// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { AlertCircle } from 'lucide-react';
import { Callout } from './Callout';

interface RetryErrorProps {
  message?: string;
  onRetry: () => void;
  className?: string;
}

/**
 * The "something failed — Retry" box, standardized. Replaces the identical
 * red-bordered box + underlined Retry link hand-rolled in settings, incident
 * settings, and the PAT section.
 */
export function RetryError({ message = 'Something went wrong.', onRetry, className }: RetryErrorProps) {
  return (
    <Callout variant="danger" icon={AlertCircle} className={className}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>{message}</span>
        <button type="button" onClick={onRetry} className="font-medium underline hover:opacity-80">Retry</button>
      </div>
    </Callout>
  );
}
