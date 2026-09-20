// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState, type ReactNode } from 'react';
import { ShieldCheck, ShieldAlert, ShieldQuestion } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { formatError } from '@/lib/constants';
import api from '@/lib/api';
import type { AuditChainVerification } from '@/types/audit';

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

  // Reset any stale verify result when the org in scope changes.
  useEffect(() => { setResult(null); setError(null); }, [orgId]);

  const runVerify = async () => {
    if (!orgId) return;
    setVerifying(true);
    setResult(null);
    setError(null);
    try {
      const res = await api.verifyAuditChain(orgId);
      if (res.success && res.data) setResult(res.data);
      else setError(res.message || 'Failed to verify audit chain');
    } catch (e) {
      setError(formatError(e, 'Failed to verify audit chain'));
    } finally {
      setVerifying(false);
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
            TAMPER DETECTED — chain broken at {result.brokenAt ?? 'unknown'}
          </span>
        </Badge>
      ))}
    </div>
  );
}
