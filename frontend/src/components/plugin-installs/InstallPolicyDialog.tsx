// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { ModalFooter } from '@/components/ui/ModalFooter';
import { FormField } from '@/components/ui/FormField';
import { Select } from '@/components/ui/Select';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { useFetch } from '@/hooks/useFetch';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import { VERSION_POLICIES, VERSION_POLICY_LABELS } from '@/lib/plugin-installs';
import type { ListingVersionState, VersionPolicy } from '@/types/plugin-installs';

/**
 * Choose a version policy and baseline version for an install — used to pin an
 * implicit Official install (creating an explicit one) and to change an
 * existing install's policy. Versions come from the listing's install state;
 * yanked and paused versions can't be picked.
 */
export function InstallPolicyDialog({
  publisher, name, title, initialPolicy = 'minor', initialVersion, submitLabel = 'Save', onSubmit, onClose,
}: {
  publisher: string;
  name: string;
  title: string;
  initialPolicy?: VersionPolicy;
  initialVersion?: string | null;
  submitLabel?: string;
  /** `version` is undefined for "the latest stable version" (server default). */
  onSubmit: (body: { versionPolicy: VersionPolicy; version?: string }) => Promise<void>;
  onClose: () => void;
}) {
  const [policy, setPolicy] = useState<VersionPolicy>(initialPolicy);
  const [version, setVersion] = useState<string>(initialVersion ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const versions = useFetch(async (signal): Promise<ListingVersionState[]> => {
    const res = await api.getListingInstallState(publisher, name, { signal });
    return res.data?.versions ?? [];
  }, [publisher, name]);
  const selectable = (versions.data ?? []).filter((v) => !v.yanked && !v.paused);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ versionPolicy: policy, ...(version ? { version } : {}) });
      onClose();
    } catch (e) {
      setError(formatError(e, 'Could not save the install'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={<ModalFooter onCancel={onClose} onConfirm={() => void submit()} confirmLabel={submitLabel} loading={busy} />}
    >
      <div className="space-y-4">
        {error && <ErrorAlert message={error} />}
        <p className="text-sm text-fg-muted">
          <span className="font-mono">{publisher}/{name}</span>
        </p>
        <FormField label="Version policy" hint="Which new versions your pipelines pick up automatically. A major version never flows in without an upgrade.">
          <Select aria-label="Version policy" value={policy} onChange={(e) => setPolicy(e.target.value as VersionPolicy)}>
            {VERSION_POLICIES.map((p) => <option key={p} value={p}>{VERSION_POLICY_LABELS[p]}</option>)}
          </Select>
        </FormField>
        <FormField label="Baseline version" hint="The version the policy's range starts from.">
          <Select aria-label="Baseline version" value={version} onChange={(e) => setVersion(e.target.value)} disabled={versions.loading && !versions.data}>
            <option value="">Latest stable version</option>
            {selectable.map((v) => (
              <option key={v.version} value={v.version}>
                {v.version}{v.breaking ? ' (breaking)' : ''}{v.deprecated ? ' (deprecated)' : ''}
              </option>
            ))}
          </Select>
        </FormField>
        {versions.error && <p className="text-xs text-fg-muted">Couldn&apos;t load the version list; the latest stable version will be used.</p>}
      </div>
    </Modal>
  );
}
