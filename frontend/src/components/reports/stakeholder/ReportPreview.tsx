// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The free preview: one watermarked sample report for an org that has not bought the
 * add-on.
 *
 * It renders with the SAME `SectionCard` the real review screen uses, deliberately. A
 * bespoke "sample" layout would be a mock-up of the product rather than the product, and
 * the decision the lead is making is whether THIS is worth paying for.
 *
 * IT IS IRREVERSIBLE, AND SAYS SO BEFORE THE CLICK. One preview per organization, ever —
 * not per person and not per month — so the button explains that first and the copy after
 * a spent preview says what happened rather than just disabling itself.
 *
 * NOTHING HERE APPEARS ON A BILLING-DISABLED INSTALL, and not because of a check: those
 * orgs run as the unlimited tier, which includes the feature, so the tab never reaches
 * its locked branch and this component is never mounted. The preview exists to sell
 * something; where there is nothing to sell there is nothing to show.
 */
import { useEffect, useState } from 'react';
import { Eye, FileText } from 'lucide-react';
import { api } from '@/lib/api';
import type { ReportSnapshot } from '@/lib/api/domains/stakeholder-reports';
import { useFormState } from '@/hooks/useFormState';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Card } from '@/components/ui/Card';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { SectionCard } from './ReportReview';

interface ReportPreviewProps {
  /** `reports:author` — composing a report is the authoring act. */
  canAuthor: boolean;
  readOnly?: boolean;
}

export function ReportPreview({ canAuthor, readOnly = false }: ReportPreviewProps) {
  const form = useFormState();
  const [snapshot, setSnapshot] = useState<ReportSnapshot | null>(null);
  const [watermark, setWatermark] = useState<string | null>(null);
  const [used, setUsed] = useState<boolean | null>(null);

  // Asked before the button is offered, so a lead who has already spent the preview reads
  // why rather than clicking and being refused.
  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.getReportPreviewStatus({ signal: controller.signal });
        if (!cancelled && res.success && res.data) setUsed(res.data.used);
      } catch {
        // A failed probe must not hide the offer: the POST enforces once-ever on its own,
        // so the worst case is a refusal the lead can read.
        if (!cancelled) setUsed(false);
      }
    })();
    return () => { cancelled = true; controller.abort(); };
  }, []);

  const generate = async () => {
    await form.run(async () => {
      const res = await api.generateReportPreview();
      if (!res.success || !res.data) throw new Error('The preview could not be generated');
      setSnapshot(res.data.snapshot);
      setWatermark(res.data.watermark);
      setUsed(true);
    });
  };

  if (snapshot) {
    return (
      <Card className="space-y-3" data-testid="report-preview">
        <Callout variant="warning" title="This is your one free preview">
          <span data-testid="report-preview-watermark">{watermark}</span>
        </Callout>
        <div className="flex items-center gap-2">
          <FileText className="w-4 h-4 text-fg-subtle" aria-hidden="true" />
          <h3 className="h3">{snapshot.period.label}</h3>
        </div>
        <div className="space-y-2">
          {snapshot.sections.map((s) => <SectionCard key={s.id} section={s} />)}
        </div>
        <p className="text-xs text-fg-muted">{snapshot.methodology}</p>
      </Card>
    );
  }

  return (
    <Card className="space-y-2">
      <div className="flex items-center gap-2">
        <Eye className="w-4 h-4 text-fg-subtle" aria-hidden="true" />
        <h3 className="h3">See it with your own numbers</h3>
      </div>
      {used === true ? (
        <p className="text-sm text-fg-muted" data-testid="report-preview-used">
          This organization has already used its free preview. Adding the add-on is the way
          to keep producing reports — everything you saw stays available once it&apos;s on.
        </p>
      ) : (
        <>
          <p className="text-sm text-fg-muted">
            Generate one sample report from your own last complete week. It is watermarked,
            it can&apos;t be scheduled or shared, and there is{' '}
            <strong>one per organization, ever</strong> — so it is worth doing when you are
            ready to look properly.
          </p>
          <ErrorAlert message={form.error} onDismiss={form.reset} />
          {canAuthor ? (
            <Button size="sm" onClick={generate} loading={form.loading} readOnly={readOnly}>
              <Eye className="w-3 h-3 mr-1.5" aria-hidden="true" />Generate the sample
            </Button>
          ) : (
            // Said rather than hidden: a viewer who cannot author should learn that the
            // sample exists and who can produce it, not see a blank space.
            <p className="text-xs text-fg-muted" data-testid="report-preview-needs-author">
              A team lead with permission to author reports can generate the sample.
            </p>
          )}
        </>
      )}
    </Card>
  );
}
