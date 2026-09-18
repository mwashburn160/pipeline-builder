// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { CopyButton } from '@/components/ui/CopyButton';
import { buttonClasses } from '@/components/ui/buttonClasses';

/**
 * The one and only showing of a set of recovery codes.
 *
 * They are stored hashed, so this is genuinely the last time they exist in
 * readable form — which is why the panel is loud, offers both copy and download,
 * and makes the person acknowledge before it goes away rather than closing on
 * the next render.
 *
 * The download is a client-side blob: the codes never take a second trip to the
 * server just to be turned into a file.
 */
export function RecoveryCodes({
  codes,
  onDone,
  title = 'Save your recovery codes',
}: {
  codes: string[];
  onDone: () => void;
  title?: string;
}) {
  const asText = codes.join('\n');
  const [href, setHref] = useState<string | null>(null);
  // Kept so the previous object URL is revoked when the codes change — a blob
  // held open is the whole secret sitting in browser memory.
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    const blob = new Blob(
      [`Pipeline Builder recovery codes\n\nEach code works once. Keep them somewhere you can reach without this device.\n\n${asText}\n`],
      { type: 'text/plain' },
    );
    const url = URL.createObjectURL(blob);
    urlRef.current = url;
    setHref(url);
    return () => {
      URL.revokeObjectURL(url);
      urlRef.current = null;
    };
  }, [asText]);

  const done = useCallback(() => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    onDone();
  }, [onDone]);

  return (
    <div className="space-y-3">
      <Callout variant="warning" icon={ShieldCheck} title={title}>
        Each code works once, and this is the only time they are shown. Store them
        somewhere you can reach <strong>without</strong> the device running your
        authenticator app — they are how you get back in if you lose it.
      </Callout>

      <ul
        className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-xl border border-[var(--pb-border)] bg-[var(--pb-surface-muted)] p-4 font-mono text-sm"
        aria-label="Recovery codes"
      >
        {codes.map((code) => <li key={code}>{code}</li>)}
      </ul>

      <div className="flex flex-wrap items-center gap-2">
        <CopyButton text={asText} />
        {href && (
          <a
            href={href}
            download="pipeline-builder-recovery-codes.txt"
            className={buttonClasses('outline', 'xs', false, 'inline-flex items-center')}
          >
            <Download className="w-3.5 h-3.5 mr-1.5" /> Download
          </a>
        )}
        <Button variant="primary" size="sm" onClick={done} className="ml-auto">
          I&apos;ve saved them
        </Button>
      </div>
    </div>
  );
}
