// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { FileUp } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { Input } from '@/components/ui/Input';
import { SegmentedFilter } from '@/components/ui/SegmentedFilter';
import { Textarea } from '@/components/ui/Textarea';
import { useFormState } from '@/hooks/useFormState';
import api from '@/lib/api';
import type { ParsedIdpMetadata } from '@/types';

type Source = 'url' | 'xml';

/**
 * Import the identity provider's SAML metadata — by URL (fetched by the SERVER,
 * under its SSRF guard: https only, no private addresses, no redirects, size and
 * time limits), or by pasting / uploading the XML. It only PRE-FILLS the form:
 * nothing is saved until the administrator reviews the values and saves them
 * (behind the usual step-up).
 */
export function SamlMetadataImport({
  orgId,
  disabled,
  onImported,
}: {
  orgId: string;
  disabled?: boolean;
  onImported: (metadata: ParsedIdpMetadata) => void;
}) {
  const form = useFormState();
  const [source, setSource] = useState<Source>('url');
  const [url, setUrl] = useState('');
  const [xml, setXml] = useState('');

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setXml(await file.text());
    setSource('xml');
  };

  const importNow = async () => {
    const payload = source === 'url' ? { url: url.trim() } : { xml };
    if (source === 'url' ? !url.trim().startsWith('https://') : !xml.trim()) {
      form.setError(source === 'url' ? 'Enter the https URL of the metadata document.' : 'Paste or upload the metadata XML.');
      return;
    }
    const res = await form.run(() => api.importIdpMetadata(orgId, payload));
    const metadata = res?.data?.metadata;
    if (metadata) {
      onImported(metadata);
      form.setSuccess(`Imported ${metadata.entityId} — review the fields below, then save.`);
    }
  };

  return (
    <div className="rounded-lg border border-dashed border-gray-300 dark:border-gray-700 p-3 space-y-3" data-testid="saml-metadata-import">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-fg-muted">Import identity-provider metadata</p>
        <SegmentedFilter
          options={[{ value: 'url', label: 'From URL' }, { value: 'xml', label: 'Paste / upload' }]}
          value={source}
          onChange={(v) => setSource(v as Source)}
          ariaLabel="Metadata source"
        />
      </div>
      <ErrorAlert message={form.error} />
      {form.success && <p className="text-xs text-green-700 dark:text-green-400">{form.success}</p>}
      {source === 'url' ? (
        <Input
          type="url"
          aria-label="Metadata URL"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://idp.example.com/app/metadata"
          className="font-mono text-sm"
          disabled={disabled || form.loading}
        />
      ) : (
        <div className="space-y-2">
          <Textarea
            aria-label="Metadata XML"
            rows={5}
            value={xml}
            onChange={(e) => setXml(e.target.value)}
            placeholder={'<md:EntityDescriptor entityID="…">…</md:EntityDescriptor>'}
            className="font-mono text-xs"
            disabled={disabled || form.loading}
          />
          <label className="inline-flex items-center gap-2 text-xs text-fg-muted cursor-pointer">
            <FileUp className="w-4 h-4" />
            <span>Upload an .xml file</span>
            <input
              type="file"
              accept=".xml,application/xml,text/xml,application/samlmetadata+xml"
              className="sr-only"
              aria-label="Upload metadata file"
              disabled={disabled || form.loading}
              onChange={(e) => { void onFile(e.target.files?.[0]); }}
            />
          </label>
        </div>
      )}
      <Button type="button" size="sm" variant="secondary" loading={form.loading} disabled={disabled} onClick={() => { void importNow(); }}>
        Import metadata
      </Button>
    </div>
  );
}
