// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ShieldCheck, ShieldAlert, ShieldQuestion } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { useMutation } from '@/hooks/useMutation';
import api from '@/lib/api';
import type { AuditChainBreak, AuditChainVerification } from '@/types/audit';

const BREAK_TEXT: Record<AuditChainBreak, string> = {
  'hash-mismatch': 'an event was altered',
  'broken-link': 'an event was deleted or re-ordered',
  'sequence-gap': 'an event was deleted',
  'head-mismatch': 'the chain diverges from its published head',
  'tail-truncated': 'the newest events were deleted (chain no longer reaches its head)',
  'head-truncated': 'the oldest events were deleted outside the retention window',
  'watermark-invalid': 'a retention watermark failed its signature check or belongs to another chain',
  'published-head-invalid': 'the published chain head failed its signature check',
};

function describeBreak(result: AuditChainVerification): string {
  const what = result.reason ? BREAK_TEXT[result.reason] : 'chain broken';
  return result.brokenAt ? `${what} (at ${result.brokenAt})` : what;
}

interface ChainVerifyStripProps {
  /** Org whose hash-chain is verified; empty means "nothing in scope". */
  orgId: string;
  /** Renders an org reference as `name (id)` — supplied by the page's lookup. */
  renderOrgRef: (id: string) => ReactNode;
}

/**
 * Audit hash-chain tamper-verify (sysadmin only): a button plus an inline
 * result badge. Owns its own request/result/error state — the audit page kept
 * three `useState`s and a reset effect for it, none of which anything else read.
 */
export function ChainVerifyStrip({ orgId, renderOrgRef }: ChainVerifyStripProps) {
  const [result, setResult] = useState<AuditChainVerification | null>(null);

  // The verification in flight, so a scope change (or unmount) stops it on the
  // wire. `useMutation` binds the outcome to `orgId`, so a verify started for
  // org A that resolves after the scope moved to org B can't paint A's verdict
  // ("Chain intact") next to B's name — and A's error is not shown for B.
  const inFlight = useRef<AbortController | null>(null);

  const verify = useMutation({
    fn: async (forOrg: string) => {
      const ctrl = new AbortController();
      inFlight.current = ctrl;
      setResult(null);
      const res = await api.verifyAuditChain(forOrg, { signal: ctrl.signal });
      if (!res.success || !res.data) throw new Error(res.message || 'Failed to verify audit chain');
      return res.data;
    },
    scopeKey: orgId,
    errorFallback: 'Failed to verify audit chain',
    onSuccess: (data) => setResult(data),
  });
  const verifying = verify.pending;
  const error = verify.error;

  // Reset any stale verify result — and drop the one in flight — when the org
  // in scope changes (and on unmount).
  useEffect(() => {
    setResult(null);
    return () => { inFlight.current?.abort(); inFlight.current = null; };
  }, [orgId]);

  const runVerify = async () => {
    if (!orgId) return;
    await verify.run(orgId);
  };

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <Button
        onClick={runVerify}
        disabled={verifying || !orgId}
        variant="secondary"
        className="inline-flex items-center gap-1.5"
        title={orgId
          ? `Verify the audit hash-chain for org ${orgId}`
          : 'No org in scope to verify'}
      >
        <ShieldCheck className="w-4 h-4" />
        {verifying ? 'Verifying…' : 'Verify integrity'}
      </Button>
      {orgId && (
        <span className="text-xs text-fg-muted inline-flex items-center gap-1">
          org {renderOrgRef(orgId)}
        </span>
      )}
      {error && (
        <span className="inline-flex items-center gap-1 text-xs text-danger">
          <ShieldQuestion className="w-4 h-4" /> {error}
        </span>
      )}
      {result && (result.ok ? (
        <Badge color="green">
          <span className="inline-flex items-center gap-1">
            <ShieldCheck className="w-3.5 h-3.5" />
            {/* Still GREEN when rows are unverifiable — the server is explicit
                that a missing write-time digest is not tampering — but the count
                is named, because those events are outside the proof and "intact"
                on its own claims more than the check establishes. */}
            Chain intact ({result.count} event{result.count === 1 ? '' : 's'}
            {result.unverifiable > 0 ? `, ${result.unverifiable} could not be verified` : ''})
          </span>
        </Badge>
      ) : (
        <Badge color="red">
          <span className="inline-flex items-center gap-1">
            <ShieldAlert className="w-3.5 h-3.5" />
            TAMPER DETECTED — {describeBreak(result)}
          </span>
        </Badge>
      ))}
    </div>
  );
}
