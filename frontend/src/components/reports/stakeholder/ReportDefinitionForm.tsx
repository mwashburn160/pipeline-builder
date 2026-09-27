// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { useFormState } from '@/hooks/useFormState';
import api from '@/lib/api';
import type {
  ReportCadence,
  ReportDefinition,
  ReportDefinitionInput,
  ReportRecipient,
  ReportTemplate,
} from '@/lib/api/domains/stakeholder-reports';

/** The three templates, with what each is FOR rather than what it contains. */
const TEMPLATES: { id: ReportTemplate; label: string; cadence: ReportCadence; blurb: string }[] = [
  {
    id: 'weekly_delivery',
    label: 'Weekly delivery',
    cadence: 'weekly',
    blurb: 'What shipped and what broke, for a manager who wants one screen on Monday.',
  },
  {
    id: 'monthly_health',
    label: 'Monthly health',
    cadence: 'monthly',
    blurb: 'Delivery plus reliability and plugin health, with the month-over-month move.',
  },
  {
    id: 'quarterly_review',
    label: 'Quarterly review',
    cadence: 'quarterly',
    blurb: 'The full picture for a review conversation, including trends.',
  },
];

/**
 * A short, honest timezone list plus whatever the browser is set to.
 *
 * Periods are cut in the REPORT's timezone, not the reader's, so this is a real
 * decision: a weekly report for a team in Chicago that buckets in UTC puts
 * Sunday evening's deploys in the wrong week. The browser's own zone leads the
 * list because it is right far more often than UTC is.
 */
function timezoneOptions(): string[] {
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const common = [
    'UTC', 'America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York',
    'Europe/London', 'Europe/Berlin', 'Europe/Madrid', 'Asia/Kolkata', 'Asia/Singapore',
    'Asia/Tokyo', 'Australia/Sydney',
  ];
  return [...new Set([local, ...common].filter(Boolean))];
}

/** Why an address would be skipped, in words a lead can act on. */
export function blockedLabel(reason?: string): string {
  if (reason === 'pending_verification') return 'not confirmed yet';
  if (reason === 'unsubscribed') return 'unsubscribed';
  if (reason === 'bouncing') return 'bouncing';
  if (reason === 'removed') return 'removed';
  return 'not deliverable';
}

interface ReportDefinitionFormProps {
  /** Editing an existing definition, or undefined to create one. */
  definition?: ReportDefinition;
  recipients: ReportRecipient[];
  /** `reports:rollup` — a rollup scope is refused at save without it. */
  canRollup: boolean;
  /**
   * Whether this instance can send email at all. `false` ⇒ delivery is IN-APP ONLY, and the
   * form says so before the lead picks a distribution list — platform's mailer reports a
   * disabled send as success, so otherwise the first sign of trouble is a manager saying
   * they never got it.
   */
  emailAvailable?: boolean;
  readOnly?: boolean;
  onSaved: (definition: ReportDefinition) => void;
  onCancel: () => void;
}

/**
 * Create or edit a saved report.
 *
 * The form deliberately surfaces three things a picker would hide: the TIMEZONE the period
 * is cut in, which recipients are actually deliverable, and whether this installation can
 * send email at all. A lead who schedules a report to three addresses — two never
 * confirmed, on an instance with no SMTP — should learn that here, not from a manager
 * saying they never got it.
 */
export function ReportDefinitionForm({
  definition, recipients, canRollup, emailAvailable = true, readOnly = false, onSaved, onCancel,
}: ReportDefinitionFormProps) {
  const form = useFormState();
  const [name, setName] = useState(definition?.name ?? '');
  const [template, setTemplate] = useState<ReportTemplate>(definition?.template ?? 'weekly_delivery');
  const [cadence, setCadence] = useState<ReportCadence>(definition?.cadence ?? 'weekly');
  const [timezone, setTimezone] = useState(definition?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC');
  const [weekStart, setWeekStart] = useState<'monday' | 'sunday'>(definition?.weekStart ?? 'monday');
  const [scopeKind, setScopeKind] = useState<'org' | 'projects' | 'rollup'>(definition?.scope.kind ?? 'org');
  const [projects, setProjects] = useState((definition?.scope.projects ?? []).join(', '));
  const [autoSend, setAutoSend] = useState(definition?.autoSend ?? false);
  const [selected, setSelected] = useState<string[]>(definition?.recipients ?? []);

  const zones = useMemo(timezoneOptions, []);
  const chosenTemplate = TEMPLATES.find((t) => t.id === template);

  /** Picking a template moves the cadence with it — that is what the template means. */
  const pickTemplate = (id: ReportTemplate) => {
    setTemplate(id);
    const spec = TEMPLATES.find((t) => t.id === id);
    if (spec) setCadence(spec.cadence);
  };

  const toggleRecipient = (id: string) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((r) => r !== id) : [...prev, id]));
  };

  const undeliverable = recipients.filter((r) => selected.includes(r.id) && !r.deliverable);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const body: ReportDefinitionInput = {
      name: name.trim(),
      template,
      cadence,
      timezone,
      weekStart,
      scope: scopeKind === 'projects'
        ? { kind: 'projects', projects: projects.split(',').map((p) => p.trim()).filter(Boolean) }
        : { kind: scopeKind },
      recipients: selected,
      autoSend,
    };
    await form.run(
      async () => {
        const res = definition
          ? await api.updateReportDefinition(definition.id, body)
          : await api.createReportDefinition(body);
        if (!res.success || !res.data) throw new Error('Could not save the report');
        return res.data.definition;
      },
      { onSuccess: onSaved },
    );
  };

  return (
    <Card>
      <form onSubmit={submit} className="space-y-4">
        <h3 className="h3">{definition ? 'Edit report' : 'New report'}</h3>
        <ErrorAlert message={form.error} onDismiss={form.reset} />

        <FormField label="Name" required hint="What a manager will see at the top of the report.">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} required placeholder="Platform team — weekly delivery" />
        </FormField>

        <FormField label="Template" hint={chosenTemplate?.blurb}>
          <Select value={template} onChange={(e) => pickTemplate(e.target.value as ReportTemplate)}>
            {TEMPLATES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </Select>
        </FormField>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Cadence">
            <Select value={cadence} onChange={(e) => setCadence(e.target.value as ReportCadence)}>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
              <option value="quarterly">Quarterly</option>
            </Select>
          </FormField>
          <FormField
            label="Timezone"
            hint="Periods are cut in this zone. A team in Chicago reporting in UTC gets Sunday evening's deploys in the wrong week."
          >
            <Select value={timezone} onChange={(e) => setTimezone(e.target.value)}>
              {zones.map((z) => <option key={z} value={z}>{z}</option>)}
            </Select>
          </FormField>
        </div>

        {cadence === 'weekly' && (
          <FormField label="Week starts on">
            <Select value={weekStart} onChange={(e) => setWeekStart(e.target.value as 'monday' | 'sunday')}>
              <option value="monday">Monday</option>
              <option value="sunday">Sunday</option>
            </Select>
          </FormField>
        )}

        <FormField
          label="Covers"
          hint={scopeKind === 'rollup' && !canRollup
            ? 'Rolling up your descendant teams needs the "Roll up team reports" permission.'
            : undefined}
        >
          <Select value={scopeKind} onChange={(e) => setScopeKind(e.target.value as typeof scopeKind)}>
            <option value="org">This organization</option>
            <option value="projects">Specific projects</option>
            <option value="rollup" disabled={!canRollup}>
              This organization and its teams{canRollup ? '' : ' — needs permission'}
            </option>
          </Select>
        </FormField>

        {scopeKind === 'projects' && (
          <FormField label="Projects" hint="Comma-separated project names.">
            <Input value={projects} onChange={(e) => setProjects(e.target.value)} placeholder="atlas, billing" />
          </FormField>
        )}

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-fg">Recipients</legend>
          {recipients.length === 0 ? (
            <p className="text-sm text-fg-muted">
              No addresses yet. Add them on the Recipients tab — an external address has to confirm by email
              before anything is delivered to it.
            </p>
          ) : recipients.map((r) => (
            <label key={r.id} className="flex items-center gap-2 text-sm">
              <Checkbox checked={selected.includes(r.id)} onChange={() => toggleRecipient(r.id)} />
              <span>
                {r.email}
                {!r.deliverable && (
                  <span className="ml-2 text-xs text-warning-strong">{blockedLabel(r.blockedReason)}</span>
                )}
              </span>
            </label>
          ))}
        </fieldset>

        {undeliverable.length > 0 && (
          <p className="text-xs text-warning-strong" role="status">
            {undeliverable.length} selected {undeliverable.length === 1 ? 'address' : 'addresses'} would be skipped today.
            They stay on the report and start receiving it once they are deliverable.
          </p>
        )}

        {/* Said before the choice, not after the first missed report. A disabled send is
            reported as a SUCCESS by the mail layer, so without this an install with no SES
            or SMTP — which is most local and minikube ones — would record every report as
            delivered to managers who never received it. */}
        {!emailAvailable && (
          <p className="text-xs text-warning-strong" role="status" data-testid="email-unavailable">
            This installation has no outbound email configured, so reports are delivered
            in-app only. Recipients you pick here stay on the report and will be emailed once
            email is set up; until then, share a published report with a link.
          </p>
        )}

        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={autoSend} onChange={(e) => setAutoSend(e.target.checked)} />
          <span>Publish automatically, without my review</span>
        </label>
        <p className="text-xs text-fg-muted">
          Off by default. The review step is where you add the context the numbers cannot:
          &ldquo;we paused deploys Tuesday for the migration&rdquo;.
        </p>

        <div className="flex gap-2">
          <Button type="submit" loading={form.loading} readOnly={readOnly}>
            {definition ? 'Save changes' : 'Create report'}
          </Button>
          <Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button>
        </div>
      </form>
    </Card>
  );
}
