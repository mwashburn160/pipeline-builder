// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useState, useId } from 'react';
import { KeyRound, AlertTriangle, RotateCw } from 'lucide-react';
import api from '@/lib/api';
import { useFetch } from '@/hooks/useFetch';
import { useMutation } from '@/hooks/useMutation';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { Button } from '@/components/ui/Button';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { LoadingSpinner } from '@/components/ui/Loading';
import { Modal } from '@/components/ui/Modal';
import { StepUpModal } from '@/components/admin/StepUpModal';
import type { Organization } from '@/types';
import { formatError } from '@/lib/constants';
import { ApiError } from '@/lib/api/errors';
import type { KmsConfigChangeResult } from '@/lib/api/domains/admin';

interface Props {
  org: Organization;
  onClose: () => void;
  /** Invoked after a successful save or clear so the parent can refresh
   *  any cached view of the org's KMS state. */
  onSaved?: () => void;
}

/**
 * Sysadmin modal for managing an org's per-org KMS CMK binding.
 *
 * The PUT path triggers three-phase re-encryption server-side (capture old
 * blobs under current provider → flip config → re-encrypt under new
 * provider). Operators see counts in the response so they can verify the
 * rotation reached every secret.
 *
 * DELETE clears the binding and reverts the org to the shared
 * SECRET_ENCRYPTION_KEY master. Same re-encryption flow runs in reverse
 * if `reencrypt=true` (default).
 *
 * A change saves the outgoing config on the org until its runner signing keys
 * are re-wrapped; while that is pending (`runnerRewrapPending` on the GET)
 * every save / clear is refused with 409, so the modal holds them back and
 * offers "Retry runner-key re-wrap" (same strong-factor step-up) instead.
 */
export function OrgKmsConfigModal({ org, onClose, onSaved }: Props) {
  const uid = useId();
  const [error, setError] = useState<string | null>(null);
  // The config as this modal last wrote it; until then, as loaded.
  const [written, setWritten] = useState<{ configured: boolean; keyId?: string } | null>(null);
  const [keyId, setKeyId] = useState('');
  const [ciphertextBase64, setCiphertextBase64] = useState('');
  const [testResult, setTestResult] = useState<string | null>(null);
  // Secrets the last change could not move (written under the OLD key by a
  // replica mid-migration): the change landed, but these must be re-entered.
  const [unreadable, setUnreadable] = useState<string[]>([]);
  // The last retry's outcome, when it is not an error.
  const [retryNotice, setRetryNotice] = useState<string | null>(null);
  // Gate destructive ops (save/clear/retry) on a strong-factor step-up.
  const [pendingOp, setPendingOp] = useState<'save' | 'clear' | 'retry' | null>(null);

  // `data` may be omitted on a not-yet-configured org: that is "not
  // configured", not an error.
  const { data: loaded, loading, error: loadError, refetch: reloadBinding } = useFetch(async () => {
    const res = await api.getOrgKmsConfig(org.id);
    if (!res.success) throw new Error(res.message || 'Failed to load KMS config');
    return { configured: res.data?.configured ?? false, keyId: res.data?.keyId, runnerRewrapPending: res.data?.runnerRewrapPending ?? false };
  }, [org.id]);
  const rewrapPending = loaded?.runnerRewrapPending ?? false;
  const configured = written?.configured ?? loaded?.configured ?? false;
  const currentKeyId = written ? written.keyId : loaded?.keyId;

  // One banner for save / test / clear: starting any of them clears it.
  const showError = (_err: unknown, message: string) => setError(message);

  /** Before a save / clear: drop the banners the last one left. */
  const startChange = () => {
    setError(null);
    setUnreadable([]);
    setRetryNotice(null);
  };

  /** A failed save / clear: some 500s answer AFTER the config changed ("saved
   *  but re-encryption failed"), so re-read the binding rather than keep
   *  showing the one this modal last knew. */
  const failChange = (err: unknown, message: string) => {
    showError(err, message);
    setWritten(null);
    void reloadBinding();
    onSaved?.();
  };

  /** After a change landed: close, unless it left secrets unreadable — then stay
   *  open naming them, since closing would read as a clean migration. */
  const finishChange = (result: KmsConfigChangeResult | undefined) => {
    onSaved?.();
    const stranded = result?.unreadableConcurrentWrites ?? [];
    if (stranded.length > 0) {
      setUnreadable(stranded);
      return;
    }
    onClose();
  };

  const saveM = useMutation({
    fn: async (stepUpToken: string) => {
      startChange();
      const res = await api.putOrgKmsConfig(org.id, { keyId, ciphertextBase64 }, undefined, stepUpToken);
      if (!res.success) throw new Error(res.message || 'Failed to save KMS config');
      return res;
    },
    scopeKey: org.id,
    onSuccess: (res) => {
      setWritten({ configured: true, keyId: res.data?.keyId });
      setKeyId('');
      setCiphertextBase64('');
      finishChange(res.data);
    },
    onError: failChange,
  });

  /** Dry-run the proposed config without committing. The backend's
   *  /test endpoint constructs an ephemeral provider, calls KMS Decrypt
   *  + HKDF, and returns the derived-key fingerprint on success — proves
   *  the CMK + wrapped master are valid without re-encrypting anything. */
  const testM = useMutation({
    fn: async () => {
      setError(null);
      setTestResult(null);
      const res = await api.testOrgKmsConfig(org.id, { keyId, ciphertextBase64 });
      if (!res.success || !res.data) throw new Error(res.message || 'Test failed');
      return res.data;
    },
    scopeKey: org.id,
    onSuccess: (data) => setTestResult(`✓ ${data.message} Key fingerprint: ${data.keyFingerprint}`),
    onError: showError,
  });

  const clearM = useMutation({
    fn: async (stepUpToken: string) => {
      startChange();
      const res = await api.deleteOrgKmsConfig(org.id, stepUpToken);
      if (!res.success) throw new Error(res.message || 'Failed to clear KMS config');
      return res;
    },
    scopeKey: org.id,
    onSuccess: (res) => {
      setWritten({ configured: false });
      finishChange(res.data);
    },
    onError: failChange,
  });

  /** Retry the pending runner-key re-wrap. A 409 means nothing was pending (a
   *  retry elsewhere finished it); a 500 means the cause is still there and the
   *  record is kept. Either way the binding is re-read for the pending flag. */
  const retryM = useMutation({
    fn: async (stepUpToken: string) => {
      startChange();
      const res = await api.retryRunnerKeyReencrypt(org.id, stepUpToken);
      if (!res.success) throw new Error(res.message || 'Runner-key re-wrap failed');
      return res.data;
    },
    scopeKey: org.id,
    onSuccess: (data) => {
      setRetryNotice(data
        ? `Re-wrapped ${data.runnerKeysReencrypted} of ${data.runnerKeysScanned} runner signing keys. KMS changes are allowed again.`
        : 'Runner signing keys re-wrapped. KMS changes are allowed again.');
      void reloadBinding();
      onSaved?.();
    },
    onError: (err, message) => {
      if (err instanceof ApiError && err.statusCode === 409) {
        setRetryNotice('Nothing to retry: no runner-key re-wrap is pending for this organization.');
      } else {
        setError(`Runner-key re-wrap failed again, so its cause is still present: ${message}`);
      }
      void reloadBinding();
    },
  });

  const submitting = saveM.pending || clearM.pending || retryM.pending;
  const testing = testM.pending;
  const { run: executeSave } = saveM;
  const { run: executeClear } = clearM;
  const { run: executeRetry } = retryM;
  const { run: runTest } = testM;
  const handleTest = useCallback(() => { void runTest(); }, [runTest]);

  // Public actions just gate on step-up; the executeXxx fns run after.
  const handleSave = useCallback(() => setPendingOp('save'), []);
  const handleClear = useCallback(() => setPendingOp('clear'), []);
  const handleRetry = useCallback(() => setPendingOp('retry'), []);

  const onStepUpConfirmed = useCallback(async (stepUpToken: string) => {
    const op = pendingOp;
    setPendingOp(null);
    if (op === 'save') await executeSave(stepUpToken);
    if (op === 'clear') await executeClear(stepUpToken);
    if (op === 'retry') await executeRetry(stepUpToken);
  }, [pendingOp, executeSave, executeClear, executeRetry]);

  const pendingTitle = rewrapPending ? 'Retry the pending runner-key re-wrap first' : undefined;

  return (
    <>
      <Modal
        title={`KMS Config — ${org.name}`}
        titleIcon={<KeyRound className="w-5 h-5 shrink-0" />}
        onClose={onClose}
        maxWidth="max-w-2xl"
        footer={
          <div className="flex items-center justify-end gap-2">
            {configured && (
              <Button variant="danger-outline" onClick={handleClear} disabled={submitting || testing || rewrapPending} title={pendingTitle}>
                Clear
              </Button>
            )}
            <Button
              variant="secondary"
              onClick={handleTest}
              disabled={testing || submitting || !keyId || !ciphertextBase64}
              title="Verify the proposed config without touching stored secrets"
            >
              {testing ? <LoadingSpinner size="sm" /> : 'Test'}
            </Button>
            <Button variant="secondary" onClick={onClose} disabled={submitting || testing}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={submitting || testing || rewrapPending || !keyId || !ciphertextBase64} title={pendingTitle}>
              {submitting ? <LoadingSpinner size="sm" /> : 'Save & re-encrypt'}
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          {loading && <LoadingSpinner size="sm" />}

          <ErrorAlert message={error ?? (loadError ? formatError(loadError) : null)} />

          {rewrapPending && (
            <div
              role="alert"
              aria-label="Runner-key re-wrap pending"
              className="flex gap-2 rounded-lg bg-warning-bg px-3 py-2 text-sm text-warning-strong"
            >
              <AlertTriangle className="w-5 h-5 flex-shrink-0" />
              <div className="space-y-2">
                <p>
                  An earlier change&apos;s runner signing key re-wrap has not finished. Until it does, this org&apos;s
                  pipeline runners cannot sign and the KMS config cannot be changed. Fix the cause the failure named
                  (pipeline service reachable, CMK grant in place), then retry. Safe to repeat.
                </p>
                <Button size="sm" variant="secondary" onClick={handleRetry} disabled={submitting || testing}>
                  {retryM.pending ? <LoadingSpinner size="sm" /> : <><RotateCw className="w-3.5 h-3.5 mr-1.5" />Retry runner-key re-wrap</>}
                </Button>
              </div>
            </div>
          )}

          {retryNotice && (
            <div role="status" className="rounded-lg bg-info-bg px-3 py-2 text-sm text-info-strong">
              {retryNotice}
            </div>
          )}

          {unreadable.length > 0 && (
            <div
              role="alert"
              aria-label="Secrets that must be re-entered"
              className="flex gap-2 rounded-lg bg-warning-bg px-3 py-2 text-sm text-warning-strong"
            >
              <AlertTriangle className="w-5 h-5 flex-shrink-0" />
              <div>
                The change was saved, but {unreadable.length === 1 ? 'this secret was' : 'these secrets were'} written under
                the previous key while the migration ran and can no longer be read. The org&apos;s admins must re-enter them:
                <ul className="mt-1 list-disc pl-5 font-mono text-xs">
                  {unreadable.map((f) => <li key={f}>{f}</li>)}
                </ul>
              </div>
            </div>
          )}

          {testResult && (
            <div className="rounded-lg bg-info-bg px-3 py-2 text-sm text-info-strong font-mono">
              {testResult}
            </div>
          )}

          <div className="rounded-lg bg-surface-muted px-3 py-2 text-sm">
            <div className="font-medium text-fg-muted mb-1">Current binding</div>
            <div className="text-fg-muted">
              {configured
                ? <>Configured · keyId <code className="text-xs bg-surface-muted px-1.5 py-0.5 rounded">{currentKeyId}</code></>
                : <em>Not configured — org uses the shared SECRET_ENCRYPTION_KEY master.</em>}
            </div>
          </div>

          <div className="flex gap-2 rounded-lg bg-warning-bg px-3 py-2 text-sm text-warning-strong">
            <AlertTriangle className="w-5 h-5 flex-shrink-0" />
            <div>
              Saving rotates the org&apos;s KMS binding and re-encrypts existing AI keys and IdP secrets under the new CMK.
              The operator must have already created the CMK (key policy: allow platform&apos;s IAM role to <code>kms:Decrypt</code>)
              and wrapped a 32-byte master with it (<code>head -c 32 /dev/urandom &gt; master.bin</code>, then the command below).
            </div>
          </div>

          <div>
            <label className="label" htmlFor={`${uid}-kms-key-id-alias`}>KMS key id / alias</label>
            <Input
              id={`${uid}-kms-key-id-alias`}
              type="text"
              value={keyId}
              onChange={(e) => setKeyId(e.target.value)}
              placeholder="alias/pb-org-acme"
              className="font-mono text-sm"
              disabled={submitting}
            />
          </div>

          <div>
            <label className="label" htmlFor={`${uid}-wrapped-master-base64`}>Wrapped master (base64)</label>
            <Textarea
              id={`${uid}-wrapped-master-base64`}
              value={ciphertextBase64}
              onChange={(e) => setCiphertextBase64(e.target.value)}
              placeholder="AQICAHi..."
              rows={4}
              className="font-mono text-xs"
              disabled={submitting}
            />
            <p className="mt-1 text-xs text-fg-muted">
              Output of <code>aws kms encrypt --key-id &lt;keyId&gt; --plaintext fileb://master.bin --output text --query CiphertextBlob</code>.
              Never echoed back — only the keyId is shown on subsequent reads.
            </p>
          </div>

        </div>
      </Modal>

      {pendingOp && (
        <StepUpModal
          action={pendingOp === 'save'
            ? `Rotate KMS binding for ${org.name} (re-encrypts AI keys + IdP secret)`
            : pendingOp === 'clear'
              ? `Clear KMS binding for ${org.name} (fall back to shared master)`
              : `Retry the runner signing key re-wrap for ${org.name}`}
          /* The KMS routes accept only a SECOND FACTOR: pointing an org at
             another key is close to "read every secret this org has", so a
             password re-prompt — which an attacker holding the session may
             already have — is not enough. */
          requireStrongFactor
          onConfirmed={onStepUpConfirmed}
          onClose={() => setPendingOp(null)}
        />
      )}
    </>
  );
}
