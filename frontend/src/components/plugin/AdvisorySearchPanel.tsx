// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { Search, ShieldAlert, Workflow } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { RetryError } from '@/components/ui/RetryError';
import { SectionCard } from '@/components/ui/SectionCard';
import { Skeleton } from '@/components/ui/Skeleton';
import { useFetch } from '@/hooks/useFetch';
import api from '@/lib/api';
import type { AdvisoryAffectedVersion, AdvisorySearchResult } from '@/lib/api/plugin-vulnerability-types';
import { formatError } from '@/lib/constants';
import { describeFinding } from '@/lib/plugin-vulns';
import { pluginPagePath } from '@/lib/public-directory/links';

/** CVE-…, GHSA-…, GO-…, OSV-style ids (`PREFIX-…`): what the scanner reports. */
const ADVISORY_ID = /^[A-Za-z][A-Za-z0-9]*-[A-Za-z0-9._:-]+$/;

/** Where a version can be looked at: the org's plugin list, or the listing's public page. */
function versionHref(v: AdvisoryAffectedVersion): string | null {
  if (v.source === 'listing') return v.publisher ? pluginPagePath(v.publisher, v.name) : null;
  return `/dashboard/plugins?q=${encodeURIComponent(v.name)}`;
}

function AffectedVersion({ v }: { v: AdvisoryAffectedVersion }) {
  const href = versionHref(v);
  const label = `${v.publisher ? `${v.publisher}/` : ''}${v.name}@${v.version}`;
  return (
    <li className="rounded-lg border border-default p-3 space-y-2" data-testid={`advisory-version-${v.id}`}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {href ? <Link href={href} className="action-link font-mono">{label}</Link> : <span className="font-mono">{label}</span>}
        <Badge color={v.source === 'listing' ? 'blue' : 'gray'}>{v.source === 'listing' ? 'Ecosystem listing' : 'Organization plugin'}</Badge>
        {v.pipelines.length > 0 && <Badge color="red">{v.pipelines.length} pipeline{v.pipelines.length === 1 ? '' : 's'}</Badge>}
        {v.scannedAt && <span className="text-xs text-fg-muted">scanned <RelativeTime value={v.scannedAt} /></span>}
      </div>
      <ul className="font-mono text-xs text-fg-muted">
        {v.findings.map((f) => (
          <li key={`${f.id}:${f.packageName}:${f.packageVersion}`}>
            {describeFinding({ id: f.id, severity: f.severity, package: f.packageName, packageVersion: f.packageVersion, fixedIn: f.fixedIn })}
            {' '}<span className="uppercase">{f.severity}</span>{f.kev ? ' · KEV' : ''}
          </li>
        ))}
      </ul>
      {v.truncated && (
        <p className="text-xs text-fg-muted">This version&apos;s stored finding list was capped, so it may be affected in more packages than shown.</p>
      )}
      {v.pipelines.length > 0 && (
        <ul className="flex flex-wrap gap-2 text-xs" aria-label={`Pipelines on ${label}`}>
          {v.pipelines.map((p) => (
            <li key={`${p.pipelineId}:${p.source}`} className="inline-flex items-center gap-1 rounded-md border border-default px-2 py-1">
              <Workflow className="h-3 w-3" aria-hidden />
              <Link href={`/dashboard/pipelines/${encodeURIComponent(p.pipelineId)}`} className="action-link">
                {p.pipelineName ?? p.pipelineId}
              </Link>
              <span className="text-fg-muted">{p.source === 'deployed' ? 'deployed' : 'declared'}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function Results({ data }: { data: AdvisorySearchResult }) {
  if (data.versions.length === 0) {
    return (
      <EmptyState
        compact
        icon={ShieldAlert}
        title={`No visible plugin version is affected by ${data.advisoryId}`}
        description="Only Critical and High findings are stored, and only for versions you can see. A capped finding list is flagged on the version when it happens."
      />
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-sm text-fg" data-testid="advisory-summary">
        {data.advisoryId} affects {data.versions.length} plugin version{data.versions.length === 1 ? '' : 's'}
        {' '}and {data.affectedPipelines} of your pipeline{data.affectedPipelines === 1 ? '' : 's'}.
      </p>
      <ul className="space-y-3" aria-label="Affected plugin versions">
        {data.versions.map((v) => <AffectedVersion key={`${v.source}:${v.id}`} v={v} />)}
      </ul>
    </div>
  );
}

/**
 * "Which of my plugins and pipelines does this advisory hit?" — a CVE / GHSA /
 * GO-… id against every visible plugin version's stored Critical / High findings
 * (`GET /plugins/vulnerabilities/:advisoryId`, `plugins:read`). The id lives in
 * `?advisory=` so a finding elsewhere (the plugin detail's table) can link here.
 */
export function AdvisorySearchPanel() {
  const router = useRouter();
  const fromUrl = typeof router.query.advisory === 'string' ? router.query.advisory.trim() : '';
  const [input, setInput] = useState(fromUrl);
  const [invalid, setInvalid] = useState(false);
  useEffect(() => { setInput(fromUrl); }, [fromUrl]);

  const advisory = ADVISORY_ID.test(fromUrl) ? fromUrl.toUpperCase() : '';
  const resultQ = useFetch(async (signal) => {
    const res = await api.searchPluginAdvisory(advisory, { signal });
    if (!res.success || !res.data) throw new Error(res.message || 'Search failed');
    return res.data;
  }, [advisory], { enabled: !!advisory });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const id = input.trim();
    if (!ADVISORY_ID.test(id)) { setInvalid(true); return; }
    setInvalid(false);
    void router.replace({ query: { ...router.query, advisory: id.toUpperCase() } }, undefined, { shallow: true });
  };

  return (
    <SectionCard
      icon={ShieldAlert}
      title="Vulnerability search"
      description="Find the plugin versions — and the pipelines using them — affected by a CVE, GHSA or other advisory id."
    >
      <div className="space-y-4">
        <form onSubmit={submit} className="flex flex-wrap items-end gap-3" role="search" aria-label="Advisory search">
          <FormField label="Advisory id" className="min-w-[16rem]" error={invalid ? 'Enter an id like CVE-2024-3094, GHSA-xxxx-xxxx-xxxx or GO-2024-2687.' : undefined}>
            <Input value={input} onChange={(e) => setInput(e.target.value)} placeholder="CVE-2024-3094" aria-label="Advisory id" />
          </FormField>
          <Button type="submit" size="sm">
            <Search className="w-4 h-4 mr-1" aria-hidden />Search
          </Button>
        </form>
        {!advisory ? null : resultQ.loading && !resultQ.data ? (
          <Skeleton className="h-24 w-full" />
        ) : resultQ.error ? (
          <RetryError message={formatError(resultQ.error, 'Search failed')} onRetry={resultQ.refetch} />
        ) : resultQ.data ? (
          <Results data={resultQ.data} />
        ) : null}
      </div>
    </SectionCard>
  );
}
