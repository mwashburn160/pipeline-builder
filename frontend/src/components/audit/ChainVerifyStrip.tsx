// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ShieldCheck, ShieldAlert, ShieldQuestion } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { formatError } from '@/lib/constants';
import api from '@/lib/api';
import type { AuditChainBreak, AuditChainVerification } from '@/types/audit';

const BREAK_TEXT: Record<AuditChainBreak, string> = {
  'hash-mismatch': 'an event was altered',
  'broken-link': 'an event was deleted or re-ordered',
  'sequence-gap': 'an event was deleted',
  'head-mismatch': 'the chain diverges from its published head',
  'tail-truncated': 'the newest events were deleted (chain no longer reaches its head)',
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
  const [verifying, setVerifying] = useState(false);
  const [result, setResult] = useState<AuditChainVerification | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The verification in flight, and which org it is for, so a verify started
  // for org A that resolves after the scope moved to org B can't paint A's
  // verdict ("Chain intact") next to B's name.
  const inFlight = useRef<{ orgId: string; ctrl: AbortController } | null>(null);

  // Reset any stale verify result — and drop the one in flight — when the org
  // in scope changes (and on unmount).
  useEffect(() => {
    setResult(null);
    setError(null);
    setVerifying(false);
    return () => { inFlight.current?.ctrl.abort(); inFlight.current = null; };
  }, [orgId]);

  const runVerify = async () => {
    if (!orgId) return;
    inFlight.current?.ctrl.abort();
    const mine = { orgId, ctrl: new AbortController() };
    inFlight.current = mine;
    setVerifying(true);
    setResult(null);
    setError(null);
    try {
      const res = await api.verifyAuditChain(orgId, { signal: mine.ctrl.signal });
      if (inFlight.current !== mine) return; // superseded or scope moved
      if (res.success && res.data) setResult(res.data);
      else setError(res.message || 'Failed to verify audit chain');
    } catch (e) {
      if (inFlight.current !== mine) return;
      setError(formatError(e, 'Failed to verify audit chain'));
    } finally {
      if (inFlight.current === mine) {
        inFlight.current = null;
        setVerifying(false);
      }
    }
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
            Chain intact ({result.count} event{result.count === 1 ? '' : 's'})
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
