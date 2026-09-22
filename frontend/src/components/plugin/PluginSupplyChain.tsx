// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState, type ReactNode } from 'react';
import { AlertTriangle, Download, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { CopyButton } from '@/components/ui/CopyButton';
import { useToast } from '@/components/ui/Toast';
import api from '@/lib/api';
import { ApiError } from '@/lib/api/errors';
import type { PluginSummary } from '@/lib/api/domains/plugins';
import { formatError } from '@/lib/constants';
import { triggerBlobDownload } from '@/lib/download';

type SupplyChainFields = Pick<PluginSummary, 'buildType' | 'pluginType' | 'imageDigest'>;

/**
 * Whether the plugin runs in an image of its own (mirrors the server's
 * `pluginRequiresImage`). Such a plugin must carry a signed `imageDigest` —
 * synth refuses one without.
 */
export function pluginProducesImage(plugin: Pick<SupplyChainFields, 'buildType' | 'pluginType'>): boolean {
  return plugin.buildType !== 'metadata_only' && plugin.pluginType !== 'ManualApprovalStep';
}

/** `sha256:abcdef…123456` — enough of both ends to eyeball-compare digests. */
export function truncateDigest(digest: string): string {
  const [algo, hex] = digest.includes(':') ? digest.split(':', 2) : ['', digest];
  const short = hex.length > 16 ? `${hex.slice(0, 8)}…${hex.slice(-8)}` : hex;
  return algo ? `${algo}:${short}` : short;
}

/**
 * The plugin detail modal's "Supply chain" section: signature status, the
 * pinned image digest, how the image was produced, and the SBOM download
 * (read from the signed attestation, so it doubles as a verification check).
 */
export function PluginSupplyChain({ plugin }: {
  plugin: Pick<PluginSummary, 'id' | 'buildType' | 'pluginType' | 'imageDigest' | 'imageSource'>;
}) {
  const toast = useToast();
  const [downloading, setDownloading] = useState(false);

  const downloadSbom = async () => {
    setDownloading(true);
    try {
      const { blob, filename } = await api.downloadPluginSbom(plugin.id);
      triggerBlobDownload(blob, filename);
    } catch (err) {
      toast.error(err instanceof ApiError && err.code === 'IMAGE_VERIFICATION_FAILED'
        ? `Image verification failed: ${err.message}`
        : formatError(err, 'SBOM download failed'));
    } finally {
      setDownloading(false);
    }
  };

  let body: ReactNode;
  if (!pluginProducesImage(plugin)) {
    body = <p className="text-xs text-fg-muted">This plugin runs without its own image.</p>;
  } else if (!plugin.imageDigest) {
    body = (
      <p className="flex items-center gap-1.5 text-xs text-warning">
        <AlertTriangle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        Unsigned image — rebuild or re-upload this plugin to use it in pipelines.
      </p>
    );
  } else {
    body = (
      <div className="space-y-2">
        <p className="flex items-center gap-1.5 text-xs font-medium text-success">
          <ShieldCheck className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          Signed
        </p>
        <div className="flex items-center gap-2">
          <code className="text-fg font-mono text-xs truncate" title={plugin.imageDigest}>
            {truncateDigest(plugin.imageDigest)}
          </code>
          <CopyButton text={plugin.imageDigest} />
        </div>
        {plugin.imageSource && (
          <p className="text-xs text-fg-muted">
            {plugin.imageSource === 'built'
              ? 'Built by the platform — includes build provenance'
              : 'Uploaded image — no build provenance'}
          </p>
        )}
        <Button variant="outline" size="xs" onClick={downloadSbom} loading={downloading}>
          <Download className="w-3.5 h-3.5 mr-1" aria-hidden="true" />
          Download SBOM
        </Button>
      </div>
    );
  }

  return (
    <div>
      <p className="text-xs font-medium text-fg-muted mb-1">Supply chain</p>
      {body}
    </div>
  );
}
