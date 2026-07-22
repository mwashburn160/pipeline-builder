// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useState } from 'react';
import { X, KeyRound, AlertTriangle } from 'lucide-react';
import api from '@/lib/api';
import { LoadingSpinner } from '@/components/ui/Loading';
import { ModalPortal } from '@/components/ui/ModalPortal';
import { StepUpModal } from '@/components/admin/StepUpModal';
import type { Organization } from '@/types';

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
 */
export function OrgKmsConfigModal({ org, onClose, onSaved }: Props) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [configured, setConfigured] = useState(false);
  const [currentKeyId, setCurrentKeyId] = useState<string | undefined>();
  const [keyId, setKeyId] = useState('');
  const [ciphertextBase64, setCiphertextBase64] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<string | null>(null);
  // Gate destructive ops (save/clear) on a step-up password reverify.
  const [pendingOp, setPendingOp] = useState<'save' | 'clear' | null>(null);

  // Initial fetch of the current state.
  useEffect(() => {
    let cancelled = false;
    api.getOrgKmsConfig(org.id).then((res) => {
      if (cancelled) return;
      if (res.success) {
        // `data` may be omitted on a not-yet-configured org; treat as
        // "not configured" rather than an error.
        setConfigured(res.data?.configured ?? false);
        setCurrentKeyId(res.data?.keyId);
      } else {
        setError(res.message || 'Failed to load KMS config');
      }
    }).catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [org.id]);

  const executeSave = useCallback(async (stepUpToken: string) => {
    setSubmitting(true);
    setError(null);
    setLastResult(null);
    try {
      const res = await api.putOrgKmsConfig(org.id, { keyId, ciphertextBase64 }, undefined, stepUpToken);
      if (!res.success) throw new Error(res.message || 'Failed to save KMS config');
      setConfigured(true);
      setCurrentKeyId(res.data?.keyId);
      const reenc = res.data?.aiKeysReencrypted !== undefined
        ? ` Re-encrypted ${res.data.aiKeysReencrypted} AI key(s)${res.data.idpSecretReencrypted ? ' + IdP secret' : ''}.`
        : '';
      setLastResult(`KMS config saved.${reenc}`);
      setKeyId('');
      setCiphertextBase64('');
      onSaved?.();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }, [org.id, keyId, ciphertextBase64, onSaved, onClose]);

  /** Dry-run the proposed config without committing. The backend's
   *  /test endpoint constructs an ephemeral provider, calls KMS Decrypt
   *  + HKDF, and returns the derived-key fingerprint on success — proves
   *  the CMK + wrapped master are valid without re-encrypting anything. */
  const handleTest = useCallback(async () => {
    setTesting(true);
    setError(null);
    setTestResult(null);
    try {
      const res = await api.testOrgKmsConfig(org.id, { keyId, ciphertextBase64 });
      if (res.success && res.data) {
        setTestResult(`✓ ${res.data.message} Key fingerprint: ${res.data.keyFingerprint}`);
      } else {
        setError(res.message || 'Test failed');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setTesting(false);
    }
  }, [org.id, keyId, ciphertextBase64]);

  const executeClear = useCallback(async (stepUpToken: string) => {
    setSubmitting(true);
    setError(null);
    setLastResult(null);
    try {
      const res = await api.deleteOrgKmsConfig(org.id, stepUpToken);
      if (!res.success) throw new Error(res.message || 'Failed to clear KMS config');
      setConfigured(false);
      setCurrentKeyId(undefined);
      setLastResult('KMS config cleared.');
      onSaved?.();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }, [org.id, onSaved, onClose]);

  // Public actions just gate on step-up; the executeXxx fns run after.
  const handleSave = useCallback(() => setPendingOp('save'), []);
  const handleClear = useCallback(() => setPendingOp('clear'), []);

  const onStepUpConfirmed = useCallback(async (stepUpToken: string) => {
    const op = pendingOp;
    setPendingOp(null);
    if (op === 'save') await executeSave(stepUpToken);
    if (op === 'clear') await executeClear(stepUpToken);
  }, [pendingOp, executeSave, executeClear]);

  return (
    <ModalPortal>
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="card w-full max-w-2xl">
        <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-700 px-5 py-3">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-gray-900 dark:text-gray-100">
            <KeyRound className="w-5 h-5" /> KMS Config — {org.name}
          </h2>
          <button onClick={onClose} aria-label="Close" className="rounded p-1 hover:bg-gray-100 dark:hover:bg-gray-800">
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {loading && <LoadingSpinner size="sm" />}

          {error && (
            <div className="alert-error">
              <p>{error}</p>
            </div>
          )}

          {lastResult && (
            <div className="rounded-lg bg-green-50 dark:bg-green-900/20 px-3 py-2 text-sm text-green-800 dark:text-green-300">
              {lastResult}
            </div>
          )}

          {testResult && (
            <div className="rounded-lg bg-blue-50 dark:bg-blue-900/20 px-3 py-2 text-sm text-blue-800 dark:text-blue-300 font-mono">
              {testResult}
            </div>
          )}

          <div className="rounded-lg bg-gray-50 dark:bg-gray-800/50 px-3 py-2 text-sm">
            <div className="font-medium text-gray-700 dark:text-gray-300 mb-1">Current binding</div>
            <div className="text-gray-600 dark:text-gray-400">
              {configured
                ? <>Configured · keyId <code className="text-xs bg-gray-200 dark:bg-gray-700 px-1.5 py-0.5 rounded">{currentKeyId}</code></>
                : <em>Not configured — org uses the shared SECRET_ENCRYPTION_KEY master.</em>}
            </div>
          </div>

          <div className="flex gap-2 rounded-lg bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
            <AlertTriangle className="w-5 h-5 flex-shrink-0" />
            <div>
              Saving rotates the org&apos;s KMS binding and re-encrypts existing AI keys and IdP secrets under the new CMK.
              The operator must have already created the CMK (key policy: allow platform&apos;s IAM role to <code>kms:Decrypt</code>)
              and generated a wrapped master via <code>aws kms encrypt --key-id ALIAS --plaintext FILE://master.b64 --output text --query CiphertextBlob</code>.
            </div>
          </div>

          <div>
            <label className="label">KMS key id / alias</label>
            <input
              type="text"
              value={keyId}
              onChange={(e) => setKeyId(e.target.value)}
              placeholder="alias/pb-org-acme"
              className="input font-mono text-sm"
              disabled={submitting}
            />
          </div>

          <div>
            <label className="label">Wrapped master (base64)</label>
            <textarea
              value={ciphertextBase64}
              onChange={(e) => setCiphertextBase64(e.target.value)}
              placeholder="AQICAHi..."
              rows={4}
              className="input font-mono text-xs"
              disabled={submitting}
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Output of <code>aws kms encrypt --key-id &lt;keyId&gt; --plaintext fileb://master.bin --output text --query CiphertextBlob</code>.
              Never echoed back — only the keyId is shown on subsequent reads.
            </p>
          </div>

          <div className="flex items-center justify-end gap-2 pt-2">
            {configured && (
              <button
                onClick={handleClear}
                disabled={submitting || testing}
                className="btn btn-danger-outline"
              >
                Clear
              </button>
            )}
            <button
              onClick={handleTest}
              disabled={testing || submitting || !keyId || !ciphertextBase64}
              className="btn btn-secondary"
              title="Verify the proposed config without touching stored secrets"
            >
              {testing ? <LoadingSpinner size="sm" /> : 'Test'}
            </button>
            <button onClick={onClose} className="btn btn-secondary" disabled={submitting || testing}>
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={submitting || testing || !keyId || !ciphertextBase64}
              className="btn btn-primary"
            >
              {submitting ? <LoadingSpinner size="sm" /> : 'Save & re-encrypt'}
            </button>
          </div>
        </div>
      </div>

      {pendingOp && (
        <StepUpModal
          action={pendingOp === 'save'
            ? `Rotate KMS binding for ${org.name} (re-encrypts AI keys + IdP secret)`
            : `Clear KMS binding for ${org.name} (fall back to shared master)`}
          onConfirmed={onStepUpConfirmed}
          onClose={() => setPendingOp(null)}
        />
      )}
    </div>
    </ModalPortal>
  );
}
