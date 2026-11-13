// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useRef, useState } from 'react';
import { CheckCircle2, XCircle } from 'lucide-react';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { Callout } from '@/components/ui/Callout';
import { FormField } from '@/components/ui/FormField';
import { LoadingSpinner } from '@/components/ui/Loading';
import { RetryError } from '@/components/ui/RetryError';
import { Textarea } from '@/components/ui/Textarea';
import { useToast } from '@/components/ui/Toast';
import { useFetch } from '@/hooks/useFetch';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import {
  canaryGuardFails, classifySetDefaultError, gateLines, guardLabel, hardGuardFailures, platformBlastRadiusText,
  type SetDefaultRefusal,
} from '@/lib/toolchain-console';
import type { ToolchainGateThresholds } from '@/types/toolchain';

interface Props {
  releaseVersion: string;
  /** What the confirmation calls it ("Set 1.4.2 as the platform default", "Set previous as default (1.4.1)"). */
  action?: string;
  /** The canary panel's thresholds, when the operator changed them: the preview and the promotion judge the gate with them. */
  canaryGate?: ToolchainGateThresholds;
  /** Open with the override reason showing (the canary panel's "Override and promote"). */
  override?: boolean;
  onClose: () => void;
  /** After a successful promotion, with the new default. */
  onDone: (platformDefault: string) => void;
}

/**
 * "Set as platform default" (§8): ONE step-up dialog that first shows what the
 * promotion would do — every guard, ok or not, and the blast radius — then
 * re-verifies and sends `expectedCurrentDefault` (the default the preview was
 * read against), so two operators can't race.
 *
 * A refusal keeps the dialog open: `TOOLCHAIN_DEFAULT_CHANGED` refreshes the
 * preview (the next confirm carries the new default), the canary-gate refusal
 * shows the gate's numbers and asks for an override reason, and any other
 * guard refusal is shown as such. The server enforces every guard; the dialog
 * only explains them, and blocks a confirm that could only be refused.
 */
export function SetPlatformDefaultFlow({ releaseVersion, action, canaryGate, override = false, onClose, onDone }: Props) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [refusal, setRefusal] = useState<SetDefaultRefusal | null>(null);
  /** Set when a confirm was refused: StepUpModal closes itself after `onConfirmed`, which must not end the flow. */
  const refusedRef = useRef(false);

  const preview = useFetch(
    async (signal) => (await api.getToolchainDefaultPreview(releaseVersion, { signal, thresholds: canaryGate })).data ?? null,
    [releaseVersion, canaryGate?.n, canaryGate?.m, canaryGate?.t],
  );
  const p = preview.data;

  const gateBlocks = !!p && canaryGuardFails(p.guards);
  const needsReason = override || gateBlocks || refusal?.kind === 'gate';
  const hard = p ? hardGuardFailures(p.guards) : [];

  const disabledReason = preview.loading && !p
    ? 'Loading the preview…'
    : !p
      ? 'The preview could not be loaded.'
      : hard.length > 0
        ? `Refused by ${hard.map((g) => guardLabel(g.code)).join(', ')}.`
        : needsReason && !reason.trim()
          ? 'The canary gate has not passed: give an override reason.'
          : null;

  const confirm = async (token: string) => {
    if (!p) return;
    try {
      const res = await api.setToolchainPlatformDefault(releaseVersion, {
        expectedCurrentDefault: p.currentDefault,
        ...(needsReason && reason.trim() ? { overrideReason: reason.trim() } : {}),
        ...(canaryGate ? { canaryGate } : {}),
      }, token);
      const now = res.data?.platformDefault ?? releaseVersion;
      toast.success(`${now} is now the platform default`);
      onDone(now);
    } catch (err) {
      const r = classifySetDefaultError(err);
      refusedRef.current = true;
      setRefusal(r);
      if (r.kind === 'changed') await preview.refetch();
    }
  };

  const close = () => {
    if (refusedRef.current) { refusedRef.current = false; return; }
    onClose();
  };

  const details = (
    <div className="space-y-3 text-sm" data-testid="toolchain-set-default">
      {refusal && (
        <Callout variant="danger" title="Not promoted">
          <p data-testid="toolchain-set-default-refusal">{refusal.message}</p>
          {refusal.kind === 'gate' && refusal.gate && (
            <ul className="mt-1 list-disc pl-5" data-testid="toolchain-refusal-gate">
              {gateLines(refusal.gate).map((l) => <li key={l}>{l}</li>)}
            </ul>
          )}
        </Callout>
      )}
      {!p && preview.loading && <div className="flex items-center gap-2 text-fg-muted"><LoadingSpinner size="sm" /> Loading the preview…</div>}
      {!p && !preview.loading && (
        <RetryError message={formatError(preview.error, 'Could not load the preview')} onRetry={preview.refetch} />
      )}
      {p && (
        <>
          <p>
            Current platform default: <strong className="font-mono">{p.currentDefault ?? 'none'}</strong>
          </p>
          <ul className="space-y-1" data-testid="toolchain-guards" aria-label="Guards">
            {p.guards.map((g) => (
              <li key={g.code} className="flex items-start gap-2" data-guard={g.code} data-ok={g.ok ? 'true' : 'false'}>
                {g.ok
                  ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-label="ok" />
                  : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-label="failed" />}
                <span>
                  {guardLabel(g.code)}
                  {g.detail && <span className="block text-xs text-fg-muted">{g.detail}</span>}
                </span>
              </li>
            ))}
          </ul>
          {canaryGate && (
            <p className="text-xs text-fg-muted">Canary gate judged with your thresholds: N={canaryGate.n}, M={canaryGate.m}, T={canaryGate.t}.</p>
          )}
          <p data-testid="toolchain-platform-blast-radius">{platformBlastRadiusText(p.blastRadius)}</p>
        </>
      )}
      {needsReason && (
        <FormField label="Override reason" hint="Required to promote past the canary gate. Recorded in the history and the audit log.">
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            aria-label="Override reason"
            placeholder="e.g. hotfix for a pipeline-manager regression; canary too small to reach N"
          />
        </FormField>
      )}
    </div>
  );

  return (
    <StepUpModal
      title="Set the platform default?"
      action={action ?? `Set ${releaseVersion} as the platform default`}
      details={details}
      confirmDisabledReason={disabledReason}
      onConfirmed={confirm}
      onClose={close}
    />
  );
}
