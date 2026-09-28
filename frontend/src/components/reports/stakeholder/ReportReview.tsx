// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react';
import { AlertTriangle, ArrowDown, ArrowRight, ArrowUp, Link2, Lock, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
import { CopyButton } from '@/components/ui/CopyButton';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { FormField } from '@/components/ui/FormField';
import { InfoAlert } from '@/components/ui/InfoAlert';
import { Input } from '@/components/ui/Input';
import { useFetch } from '@/hooks/useFetch';
import { useFormState } from '@/hooks/useFormState';
import api from '@/lib/api';
import type {
  ComposedSection,
  ReportRun,
  ReportShareLink,
  TrendDirection,
} from '@/lib/api/domains/stakeholder-reports';

/** The change arrow. `unknown` gets no arrow at all — an absent comparison is not "flat". */
function TrendArrow({ direction }: { direction: TrendDirection }) {
  if (direction === 'up') return <ArrowUp className="w-4 h-4 text-success-strong" aria-label="up" />;
  if (direction === 'down') return <ArrowDown className="w-4 h-4 text-danger-strong" aria-label="down" />;
  if (direction === 'flat') return <ArrowRight className="w-4 h-4 text-fg-subtle" aria-label="unchanged" />;
  return null;
}

/**
 * One section, as the manager will read it.
 *
 * A LOCKED section is shown, not hidden: the report still says the panel exists
 * and what would unlock it, which is the difference between an upsell and a
 * mysteriously short report. A FAILED section says so plainly for the same reason —
 * a missing panel that looks like "nothing happened" is the failure mode this
 * whole feature is trying to avoid.
 */
export function SectionCard({ section }: { section: ComposedSection }) {
  if (section.state === 'locked') {
    return (
      <div className="rounded-lg border border-default p-3">
        <div className="flex items-center gap-2">
          <Lock className="w-4 h-4 text-fg-subtle" aria-hidden="true" />
          <span className="text-sm font-medium text-fg">{section.title}</span>
          <Badge color="gray">Not on your plan</Badge>
        </div>
        <p className="mt-1 text-xs text-fg-muted">
          Needs {section.requiresFeature}. The rest of the report is unaffected.
        </p>
      </div>
    );
  }
  if (section.state === 'failed') {
    return (
      <div className="rounded-lg border border-default p-3">
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-warning-strong" aria-hidden="true" />
          <span className="text-sm font-medium text-fg">{section.title}</span>
          <Badge color="yellow">Could not be computed</Badge>
        </div>
      </div>
    );
  }
  const { headline, change } = section;
  return (
    <div className="rounded-lg border border-default p-3">
      <p className="text-sm font-medium text-fg">{section.title}</p>
      {headline ? (
        <div className="mt-1 flex items-baseline gap-2">
          <span className="text-2xl font-semibold text-fg">
            {headline.value}{headline.unit ?? ''}
          </span>
          <span className="text-xs text-fg-muted">{headline.label}</span>
          {change && change.direction !== 'unknown' && (
            <span className="ml-1 inline-flex items-center gap-1 text-xs text-fg-muted">
              <TrendArrow direction={change.direction} />
              {change.absolute > 0 ? '+' : ''}{change.absolute}
              {change.percent !== null && <span>({change.percent > 0 ? '+' : ''}{change.percent}%)</span>}
            </span>
          )}
        </div>
      ) : (
        <p className="mt-1 text-xs text-fg-muted">No single headline for this section.</p>
      )}
    </div>
  );
}

/** The links panel: mint, list, revoke. The token is visible exactly once. */
function ShareLinks({ runId, published, canShare, readOnly, externalSharing }: {
  runId: string;
  published: boolean;
  canShare: boolean;
  readOnly: boolean;
  externalSharing: boolean;
}) {
  const { data, loading, error, refetch } = useFetch<ReportShareLink[]>(
    async (signal) => {
      const res = await api.listReportShareLinks(runId, { signal });
      if (res.success && res.data) return res.data.links;
      throw new Error('Could not load the links');
    },
    [runId],
  );
  const form = useFormState();
  const [ttlDays, setTtlDays] = useState(30);
  const [redact, setRedact] = useState(false);
  /** The one and only time the raw token is readable. Cleared on the next mint. */
  const [minted, setMinted] = useState<{ token: string; notice: string } | null>(null);

  const mint = async () => {
    setMinted(null);
    await form.run(
      async () => {
        const res = await api.createReportShareLink(runId, { ttlDays, redactNames: redact });
        if (!res.success || !res.data) throw new Error('Could not create the link');
        return res.data;
      },
      {
        onSuccess: (result) => {
          setMinted({ token: result.token, notice: result.notice });
          void refetch();
        },
      },
    );
  };

  const revoke = async (id: string) => {
    await form.run(
      async () => { await api.revokeReportShareLink(id); },
      { onSuccess: () => { void refetch(); } },
    );
  };

  if (!canShare) return null;

  return (
    <Card>
      <div className="flex items-center gap-2 mb-2">
        <Link2 className="w-4 h-4 text-fg-subtle" aria-hidden="true" />
        <h4 className="font-medium text-fg">Share links</h4>
      </div>
      <ErrorAlert message={form.error ?? (error ? error.message : null)} onDismiss={form.reset} onRetry={refetch} />

      {!externalSharing ? (
        <p className="text-sm text-fg-muted">
          Public share links are turned off for this organization. An administrator can turn them on in
          reporting settings — it is their decision, not the report author&apos;s, because a link lets anyone
          holding it read the numbers.
        </p>
      ) : !published ? (
        <p className="text-sm text-fg-muted">
          Publish the report first. A link to a draft would show numbers you have not reviewed.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <FormField label="Expires in (days)" className="w-32">
              <Input
                type="number"
                min={1}
                max={180}
                value={ttlDays}
                onChange={(e) => setTtlDays(Number(e.target.value))}
              />
            </FormField>
            <label className="flex items-center gap-2 pb-2 text-sm">
              <Checkbox checked={redact} onChange={(e) => setRedact(e.target.checked)} />
              <span>Hide pipeline and project names</span>
            </label>
            <Button size="sm" onClick={mint} loading={form.loading} readOnly={readOnly} className="mb-2">
              Create link
            </Button>
          </div>

          {minted && (
            <div className="mt-2 space-y-2">
              <InfoAlert message={minted.notice} />
              <div className="flex items-center gap-2">
                <code className="break-all text-xs">{minted.token}</code>
                <CopyButton text={minted.token} />
              </div>
            </div>
          )}
        </>
      )}

      {!loading && (data ?? []).length > 0 && (
        <ul className="mt-3 space-y-2">
          {(data ?? []).map((link) => (
            <li key={link.id} className="flex items-center justify-between gap-3 text-sm">
              <span className="text-fg-muted">
                {link.revokedAt
                  ? <Badge color="gray">Revoked</Badge>
                  : new Date(link.expiresAt) <= new Date()
                    ? <Badge color="gray">Expired</Badge>
                    : <Badge color="green">Live</Badge>}
                <span className="ml-2">
                  {link.viewCount} {link.viewCount === 1 ? 'view' : 'views'}
                  {link.redactNames && ' · names hidden'}
                  {' · expires '}{new Date(link.expiresAt).toLocaleDateString()}
                </span>
              </span>
              {!link.revokedAt && (
                <Button size="xs" variant="danger" onClick={() => revoke(link.id)} readOnly={readOnly}>
                  <Trash2 className="w-3 h-3" aria-hidden="true" /> Revoke
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

interface ReportReviewProps {
  run: ReportRun;
  /** `reports:author` — may edit the notes on an unpublished run. */
  canAuthor: boolean;
  /** `reports:share` — may publish and mint links. */
  canShare: boolean;
  /** The org's admin-owned opt-in to public links. */
  externalSharing: boolean;
  readOnly?: boolean;
  onChanged: () => void;
}

/**
 * The review screen: the numbers beside the editable summary.
 *
 * The narrative sits next to the data on purpose. The whole reason a lead reviews
 * a report before it goes out is that the numbers cannot supply the context — "we
 * paused deploys Tuesday for the migration" is the difference between a manager
 * reading a dip as a problem and reading it as a plan.
 *
 * Once published, the notes lock. The recipients read a specific version, and a
 * narrative that can be edited afterwards makes the delivered report
 * unreconstructable; regenerating produces version N+1 instead.
 */
export function ReportReview({ run, canAuthor, canShare, externalSharing, readOnly = false, onChanged }: ReportReviewProps) {
  const form = useFormState();
  const publish = useFormState();
  const [notes, setNotes] = useState(run.leadNotes ?? '');
  const [notice, setNotice] = useState<string | null>(null);
  const published = run.status === 'published';

  useEffect(() => { setNotes(run.leadNotes ?? ''); }, [run.id, run.leadNotes]);

  const save = async () => {
    await form.run(
      async () => { await api.saveReportNotes(run.id, notes); },
      { successMessage: 'Saved', onSuccess: onChanged },
    );
  };

  const doPublish = async () => {
    setNotice(null);
    await publish.run(
      async () => {
        const res = await api.publishReportRun(run.id);
        if (!res.success || !res.data) throw new Error('Could not publish the report');
        return res.data;
      },
      {
        onSuccess: (result) => {
          setNotice(
            result.alreadyPublished
              ? 'This report was already published — nothing was sent twice.'
              : `${result.notice} ${result.recipients.deliverable} recipient`
                + `${result.recipients.deliverable === 1 ? '' : 's'} will receive it`
                + `${result.recipients.blocked > 0 ? `; ${result.recipients.blocked} skipped` : ''}.`,
          );
          onChanged();
        },
      },
    );
  };

  const snapshot = run.snapshot;

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="h3">{run.periodLabel}</h3>
            <p className="text-xs text-fg-muted">
              {new Date(run.periodStart).toLocaleDateString()} – {new Date(run.periodEnd).toLocaleDateString()}
              {run.version > 1 && ` · version ${run.version}`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {published
              ? <Badge color="green">Published</Badge>
              : run.status === 'failed'
                ? <Badge color="red">Failed</Badge>
                : <Badge color="blue">Ready for review</Badge>}
            {run.supersededBy && <Badge color="gray">Superseded</Badge>}
          </div>
        </div>
        {run.failureReason && <p className="mt-2 text-sm text-danger-strong">{run.failureReason}</p>}
      </Card>

      {snapshot && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {snapshot.sections.map((s) => <SectionCard key={s.id} section={s} />)}
          </div>

          {snapshot.notes.length > 0 && (
            <Card>
              <h4 className="font-medium text-fg mb-2">Worth knowing about this data</h4>
              <ul className="space-y-1 text-sm text-fg-muted list-disc pl-5">
                {snapshot.notes.map((note, i) => <li key={`${note.code}-${i}`}>{note.message}</li>)}
              </ul>
            </Card>
          )}
        </>
      )}

      <Card>
        <FormField
          label="Your summary"
          hint={published
            ? 'This report has been published, so its summary is frozen — the recipients read exactly this. Regenerate the period to correct it.'
            : 'The context the numbers cannot supply. Managers read this first.'}
        >
          <textarea
            className="input min-h-[8rem]"
            value={notes}
            maxLength={10_000}
            disabled={published || !canAuthor}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="We paused deploys on Tuesday for the database migration, which is most of the dip."
          />
        </FormField>
        <ErrorAlert message={form.error ?? publish.error} onDismiss={() => { form.reset(); publish.reset(); }} />
        {form.success && <p className="text-xs text-success-strong" role="status">{form.success}</p>}
        {notice && <InfoAlert message={notice} className="mt-2" />}
        <div className="mt-3 flex flex-wrap gap-2">
          {!published && canAuthor && (
            <Button size="sm" variant="secondary" onClick={save} loading={form.loading} readOnly={readOnly}>
              Save summary
            </Button>
          )}
          {!published && canShare && run.status !== 'failed' && (
            <Button size="sm" onClick={doPublish} loading={publish.loading} readOnly={readOnly}>
              Publish
            </Button>
          )}
        </div>
        {!published && canShare && (
          <p className="mt-2 text-xs text-fg-muted">
            Publishing sends it. A delivered copy cannot be recalled — revoking a link later stops new
            views of the link, it does not pull back an email that has already arrived.
          </p>
        )}
      </Card>

      <ShareLinks
        runId={run.id}
        published={published}
        canShare={canShare}
        readOnly={readOnly}
        externalSharing={externalSharing}
      />

      {snapshot && (
        <p className="text-xs text-fg-subtle">{snapshot.methodology}</p>
      )}
    </div>
  );
}
