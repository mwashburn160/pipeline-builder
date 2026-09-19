// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import { Button } from './Button';
import { CopyButton } from './CopyButton';
import { buttonClasses } from './buttonClasses';

interface SecretActionsProps {
  /** The secret itself — what Copy puts on the clipboard and Download writes. */
  text: string;
  /** Download filename, e.g. `pipeline-builder-access-key.txt`. */
  filename: string;
  /** Lines written above the secret in the file (context for whoever opens it). */
  fileHeader?: string;
  /** Dismiss the panel. Omit only where there is nothing to dismiss. */
  onDone?: () => void;
  /** Label of the acknowledgement button. */
  doneLabel?: string;
  className?: string;
}

/**
 * The three things every one-time secret needs: copy it, save it as a file, and
 * say you've saved it.
 *
 * The recovery-codes sheet had all three; the access-key / service-account-key /
 * machine-token / SCIM-key / webhook-token reveals had only Copy — so the one
 * credential a person could not recover was also the one the UI let them scroll
 * past. One component now backs both, which is also the only way the two stay
 * consistent as either changes.
 *
 * The download is a client-side blob: the secret never takes a second trip to
 * the server to be turned into a file, and the object URL is revoked when the
 * value changes or the panel is dismissed rather than left holding the secret
 * in browser memory.
 */
export function SecretActions({
  text, filename, fileHeader, onDone, doneLabel = "I've saved it", className = '',
}: SecretActionsProps) {
  const [href, setHref] = useState<string | null>(null);
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    const body = fileHeader ? `${fileHeader}\n\n${text}\n` : `${text}\n`;
    const url = URL.createObjectURL(new Blob([body], { type: 'text/plain' }));
    urlRef.current = url;
    setHref(url);
    return () => {
      URL.revokeObjectURL(url);
      urlRef.current = null;
    };
  }, [text, fileHeader]);

  const done = useCallback(() => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    onDone?.();
  }, [onDone]);

  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`}>
      <CopyButton text={text} />
      {href && (
        <a
          href={href}
          download={filename}
          className={buttonClasses('outline', 'xs', false, 'inline-flex items-center')}
        >
          <Download className="w-3.5 h-3.5 mr-1.5" /> Download
        </a>
      )}
      {onDone && (
        <Button variant="primary" size="sm" onClick={done} className="ml-auto">
          {doneLabel}
        </Button>
      )}
    </div>
  );
}
