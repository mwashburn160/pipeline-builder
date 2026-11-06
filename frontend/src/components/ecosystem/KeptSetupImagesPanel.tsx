// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import type { Permission } from '@pipeline-builder/api-core/permissions';
import { Archive } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { LoadingSpinner } from '@/components/ui/Loading';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { RetryError } from '@/components/ui/RetryError';
import { SectionCard } from '@/components/ui/SectionCard';
import { useToast } from '@/components/ui/Toast';
import { useFetch } from '@/hooks/useFetch';
import api from '@/lib/api';
import { ApiError } from '@/lib/api/errors';
import type { KeptSetupImageView, PromotionResult } from '@/lib/api/pipeline-security-types';
import { formatError } from '@/lib/constants';
import { describeFinding, normalizeVulnFindings } from '@/lib/plugin-vulns';
import { shortDigest } from '@/lib/pipeline-security';

/** The outcome of the last promote attempt per image. */
type Outcome =
  | { ok: true; result: PromotionResult }
  | { ok: false; code: string | null; message: string; findings: string[] };

/**
 * Kept setup images: images the setup catalog load built but the scan gates
 * refused, kept (until they expire) so they can be promoted without a rebuild
 * once their findings are fixed or waived. Promote re-runs the CURRENT gates; a
 * 409 means they still refuse it and lists what remains. System org +
 * `plugins:moderate` + an aal2 session (the console page enforces the first and
 * last; the button is disabled, with the reason, without the permission).
 */
export function KeptSetupImagesPanel({ can }: { can: (permission: Permission) => boolean }) {
  const toast = useToast();
  const mayModerate = can('plugins:moderate');
  const read = useFetch<KeptSetupImageView[]>(async (signal) => {
    const res = await api.listKeptSetupImages({ signal });
    if (!res.success || !res.data) throw new Error(res.message || 'Failed to load kept setup images');
    return res.data.images;
  }, []);
  const [busy, setBusy] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});

  const promote = async (img: KeptSetupImageView) => {
    setBusy(img.id);
    try {
      const res = await api.promoteKeptSetupImage(img.id);
      if (!res.success || !res.data) throw new Error(res.message || 'Promotion failed');
      setOutcomes((o) => ({ ...o, [img.id]: { ok: true, result: res.data! } }));
      toast.success(`Promoted ${res.data.plugin.name}@${res.data.plugin.version}`);
      void read.refetch();
    } catch (err) {
      const details = err instanceof ApiError ? err.details : undefined;
      const findings = normalizeVulnFindings(details?.findings).map(describeFinding);
      setOutcomes((o) => ({
        ...o,
        [img.id]: { ok: false, code: err instanceof ApiError ? err.code ?? null : null, message: formatError(err, 'Promotion failed'), findings },
      }));
    } finally {
      setBusy(null);
    }
  };

  const images = read.data ?? [];

  return (
    <SectionCard
      title="Kept setup images"
      icon={Archive}
      description="Setup-catalog images the scan gates refused, kept for promotion without a rebuild. Promote re-checks them against the current gates."
    >
      {read.loading && !read.data && <LoadingSpinner />}
      {read.error && <RetryError message={formatError(read.error, 'Failed to load kept setup images')} onRetry={read.refetch} />}
      {read.data && images.length === 0 && <p className="text-sm text-fg-subtle">No kept images.</p>}
      {images.length > 0 && (
        <ul className="divide-y divide-default rounded-lg border border-default text-sm" aria-label="Kept setup images" data-testid="kept-setup-images">
          {images.map((img) => {
            const outcome = outcomes[img.id];
            const findings = normalizeVulnFindings(img.refusalFindings);
            return (
              <li key={img.id} className="space-y-2 px-3 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-fg">{img.pluginName}@{img.pluginVersion}</span>
                  <span className="font-mono text-xs text-fg-muted" title={img.imageDigest}>{shortDigest(img.imageDigest)}</span>
                  <Badge color="red">{img.refusalCode}</Badge>
                  {img.publishRequest && <Badge color="blue">Publish request</Badge>}
                  <span className="ml-auto text-xs text-fg-muted">
                    kept <RelativeTime value={img.keptAt} /> · expires <RelativeTime value={img.expiresAt} />
                  </span>
                </div>
                <p className="text-xs text-fg-muted">{img.refusalMessage}</p>
                {findings.length > 0 && (
                  <p className="font-mono text-2xs text-fg-subtle">{findings.slice(0, 5).map(describeFinding).join('; ')}{findings.length > 5 ? '; …' : ''}</p>
                )}
                <div className="flex items-center gap-2">
                  <Button
                    variant="secondary"
                    className="text-xs"
                    onClick={() => void promote(img)}
                    disabled={!mayModerate || busy !== null}
                    title={mayModerate ? 'Re-run the current gates and store the version if it passes' : 'Requires plugins:moderate'}
                  >
                    {busy === img.id ? <LoadingSpinner size="sm" /> : null}
                    Promote
                  </Button>
                </div>
                {outcome?.ok === true && (
                  <Callout variant="success" title={`Promoted ${outcome.result.plugin.name}@${outcome.result.plugin.version}`}>
                    {outcome.result.messages.length > 0 && (
                      <ul className="list-disc pl-4 text-xs">
                        {outcome.result.messages.map((m, i) => <li key={i}>{m.level === 'WARN' ? 'Warning: ' : ''}{m.message}</li>)}
                      </ul>
                    )}
                  </Callout>
                )}
                {outcome?.ok === false && (
                  <Callout variant="danger" title={outcome.code ? `Not promoted (${outcome.code})` : 'Not promoted'}>
                    <p className="text-xs">{outcome.message}</p>
                    {outcome.findings.length > 0 && (
                      <ul className="mt-1 list-disc pl-4 font-mono text-2xs" aria-label="Remaining findings">
                        {outcome.findings.map((f) => <li key={f}>{f}</li>)}
                      </ul>
                    )}
                  </Callout>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  );
}
