// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `/plugins/submit` — submit a plugin WITHOUT an account.
 *
 * Choose a zip → it is inspected (a dry run, after a proof-of-work) → accept or
 * edit each detected catalog field and look at the lint / heuristics
 * preview → give an email address and accept the terms → a second
 * proof-of-work → submit → "check your email". Everything else (the email
 * link, the isolated build, the gates, moderation) happens server-side.
 *
 * The page never sends the visitor's session: a submission is anonymous even
 * for a signed-in visitor, who is pointed at publishing from their account.
 */
import Link from 'next/link';
import { useRouter } from 'next/router';
import type { GetServerSideProps } from 'next';
import { FileArchive, MailCheck, ShieldCheck } from 'lucide-react';
import { PublicLayout, DirectoryHead } from '@/components/public-directory/PublicLayout';
import { useClientAuth } from '@/components/public-directory/PublicHeader';
import { TrustTierBadge } from '@/components/public-directory/TrustTierBadge';
import { CatalogFieldEditor } from '@/components/plugin/CatalogFieldEditor';
import { ListingCardPreview } from '@/components/publisher/ListingCardPreview';
import { PowProgress } from '@/components/plugin-submissions/PowProgress';
import { SubmissionChecksPreview } from '@/components/plugin-submissions/SubmissionChecks';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Checkbox } from '@/components/ui/Checkbox';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { LinkButton } from '@/components/ui/LinkButton';
import { usePluginSubmission } from '@/hooks/usePluginSubmission';
import { applyCatalogEdits } from '@/lib/ecosystem';
import { COMMUNITY_PUBLISHER, SUBMISSION_DOCS_URL } from '@/lib/plugin-submissions/status';
import type { SubmissionErrorInfo } from '@/lib/plugin-submissions/submit-flow';
import { loginHref } from '@/lib/public-directory/links';
import { resolveSiteUrl, type WithSiteUrl } from '@/lib/site-url';

const DESCRIPTION = 'Submit a plugin to the Pipeline Builder directory without an account. Every submission is checked automatically and reviewed by a moderator.';

function HowItWorks() {
  const router = useRouter();
  const { signedIn } = useClientAuth();
  return (
    <Callout variant="info" icon={ShieldCheck} title="How submissions work">
      <ul className="list-disc space-y-1 pl-5">
        <li>You confirm an email address, then the plugin is built in an isolated sandbox and checked: spec and license, Dockerfile lint, not running as root, a vulnerability scan, a scan for suspicious patterns, and its smoke test.</li>
        <li>A moderator reviews every submission that passes. Nothing is listed until they approve it.</li>
        <li>
          Approved plugins are listed as <span className="font-mono">{COMMUNITY_PUBLISHER}/&lt;name&gt;</span> with the{' '}
          <TrustTierBadge tier="unverified" /> tier. Organizations must allow that tier before they can install it.
        </li>
        <li>Create an account with the same email address later to claim the listing and publish it under your own publisher.</li>
      </ul>
      <p className="mt-2">
        {signedIn ? (
          <>You&apos;re signed in: to publish under your organization&apos;s publisher instead, use <Link href="/dashboard/publisher" className="action-link">Publisher</Link>.</>
        ) : (
          <>Have an account? <Link href={loginHref(router.asPath)} className="action-link">Sign in</Link> to publish under your organization&apos;s publisher instead.</>
        )}
        {' '}<a href={SUBMISSION_DOCS_URL} className="action-link" rel="noopener noreferrer">Submission guide and terms</a>
      </p>
    </Callout>
  );
}

function ErrorNotice({ error }: { error: SubmissionErrorInfo }) {
  if (error.kind === 'disabled') return null;
  const title = error.kind === 'limit' ? 'Submission limit reached'
    : error.kind === 'name_taken' ? 'That name is taken'
      : error.kind === 'pow' ? 'Anti-spam check failed'
        : error.kind === 'validation' ? 'Some details need fixing'
          : 'Something went wrong';
  return (
    <Callout variant={error.kind === 'pow' ? 'warning' : 'danger'} title={title}>
      <span data-testid="submit-error" data-kind={error.kind}>{error.message}</span>
      {error.kind === 'limit' && error.retryAfter ? <> (retry in about {Math.ceil(error.retryAfter / 60)} min)</> : null}
    </Callout>
  );
}

function Disabled() {
  const router = useRouter();
  return (
    <div className="card space-y-3 p-6" data-testid="submissions-disabled">
      <h2 className="text-lg font-semibold text-fg">Submissions are not enabled on this instance</h2>
      <p className="text-sm text-fg-muted">
        This Pipeline Builder instance doesn&apos;t accept plugins from visitors without an account. To publish a plugin,
        sign in and publish it from your organization&apos;s Publisher page.
      </p>
      <div className="flex flex-wrap gap-3">
        <LinkButton href={loginHref(router.asPath)} size="sm">Sign in</LinkButton>
        <LinkButton href="/plugins" variant="secondary" size="sm">Browse plugins</LinkButton>
      </div>
    </div>
  );
}

function Sent({ email, onAnother }: { email: string; onAnother: () => void }) {
  return (
    <div className="card space-y-3 p-6" data-testid="submission-sent" role="status">
      <div className="flex items-center gap-2">
        <MailCheck className="h-6 w-6 text-success" aria-hidden />
        <h2 className="text-lg font-semibold text-fg">Check your email</h2>
      </div>
      <p className="text-sm text-fg">
        We sent a confirmation link to <span className="font-medium">{email}</span>. Open it within 30 minutes to start the checks.
        Nothing is built or reviewed until you confirm.
      </p>
      <p className="text-sm text-fg-muted">
        After you confirm you&apos;ll get a status link to follow the checks and the moderator&apos;s decision. No email arrived? Check
        your spam folder; an unconfirmed submission is deleted after 30 days.
      </p>
      <Button variant="secondary" size="sm" onClick={onAnother}>Submit another plugin</Button>
    </div>
  );
}

export default function SubmitPluginPage({ siteUrl }: WithSiteUrl) {
  const { state, chooseFile, submit, setEdits, setEmail, setAcceptTerms, reset } = usePluginSubmission();
  const busy = state.step === 'inspecting' || state.step === 'submitting';
  const inspect = state.inspect;

  return (
    <PublicLayout>
      <DirectoryHead title="Submit a plugin" description={DESCRIPTION} canonical={`${siteUrl}/plugins/submit`} siteUrl={siteUrl} />
      <div className="mx-auto max-w-3xl space-y-6">
        <div>
          <h1 className="text-3xl font-bold text-fg">Submit a plugin</h1>
          <p className="mt-1 text-fg-muted">Share a plugin with every Pipeline Builder user, no account needed.</p>
        </div>

        {state.step === 'disabled' ? (
          <Disabled />
        ) : state.step === 'sent' ? (
          <Sent email={state.email.trim()} onAnother={reset} />
        ) : (
          <>
            <HowItWorks />
            {state.error && <ErrorNotice error={state.error} />}

            <section aria-labelledby="package-heading" className="card space-y-3 p-5">
              <h2 id="package-heading" className="flex items-center gap-2 text-base font-semibold text-fg">
                <FileArchive className="h-5 w-5" aria-hidden />1. Your plugin package
              </h2>
              <FormField
                label="Plugin package (.zip)"
                error={state.fieldErrors.plugin}
                hint="A zip with plugin-spec.yaml and a Dockerfile, up to 50 MB. The same format as an in-app upload."
              >
                <input
                  type="file"
                  accept=".zip,application/zip"
                  disabled={busy}
                  className="input"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) chooseFile(f); e.target.value = ''; }}
                />
              </FormField>
              {state.file && state.step !== 'select' && (
                <p className="text-xs text-fg-muted">Selected: <span className="font-mono">{state.file.name}</span></p>
              )}
              {state.step === 'inspecting' && state.phase && (
                <PowProgress phase={state.phase} attempts={state.attempts} difficulty={state.difficulty} action="Reading your package." />
              )}
            </section>

            {inspect && (state.step === 'review' || state.step === 'submitting') && (
              <>
                <section aria-labelledby="details-heading" className="card space-y-4 p-5" data-testid="submission-review">
                  <h2 id="details-heading" className="text-base font-semibold text-fg">2. Check the details</h2>
                  <p className="text-sm text-fg">
                    <span className="font-mono font-medium">{COMMUNITY_PUBLISHER}/{inspect.plugin.name}</span>{' '}
                    <span className="text-fg-muted">v{inspect.plugin.version}</span>
                    {inspect.plugin.pluginType && <span className="text-fg-muted"> · {inspect.plugin.pluginType}</span>}
                    {inspect.plugin.buildType && <span className="text-fg-muted"> · {inspect.plugin.buildType}</span>}
                  </p>
                  {inspect.plugin.smokeTest === false && (
                    <Callout variant="danger" title="No smoke test">
                      <span data-testid="no-smoke-test">Declare a <span className="font-mono">smokeTest</span> in plugin-spec.yaml. Submissions without one fail the automated checks.</span>
                    </Callout>
                  )}
                  {inspect.nameCheck && !inspect.nameCheck.ok && (
                    <Callout variant="warning" title="Name check">
                      <span data-testid="name-check">{inspect.nameCheck.message}</span>{' '}
                      If this is an update to a community plugin you submitted, it&apos;s checked again against your email address when you submit.
                    </Callout>
                  )}
                  <CatalogFieldEditor
                    fields={inspect.fields}
                    edits={state.edits}
                    onEditsChange={setEdits}
                    disabled={busy}
                    heading="Catalog details"
                    headingId="submission-catalog-heading"
                    description="Detected from your package. Accept each value or edit it. Commands, env, secrets and other execution settings come only from the spec and can't be edited here."
                    fieldErrors={state.fieldErrors.catalog}
                    testId="submission-catalog"
                  />
                  <ListingCardPreview
                    name={inspect.plugin.name}
                    version={inspect.plugin.version}
                    // Community listings never use a curated vendor icon: the card shows a monogram.
                    values={{ ...applyCatalogEdits(inspect.fields, state.edits), icon: null }}
                    publisher={{ handle: COMMUNITY_PUBLISHER, displayName: 'Community', tier: 'unverified' }}
                  />
                  <SubmissionChecksPreview lint={inspect.lint} heuristics={inspect.heuristics} />
                </section>

                <section aria-labelledby="confirm-heading" className="card space-y-4 p-5">
                  <h2 id="confirm-heading" className="text-base font-semibold text-fg">3. Confirm and submit</h2>
                  <FormField
                    label="Email address"
                    required
                    error={state.fieldErrors.email}
                    hint="Used only to confirm the submission and tell you the outcome. It is never shown to anyone, and it is deleted 90 days after the decision."
                  >
                    <Input
                      type="email"
                      autoComplete="email"
                      value={state.email}
                      onChange={(e) => setEmail(e.target.value)}
                      disabled={busy}
                    />
                  </FormField>
                  <div className="space-y-1">
                    <label className="flex items-start gap-2 text-sm text-fg">
                      <Checkbox
                        className="mt-0.5"
                        checked={state.acceptTerms}
                        onChange={(e) => setAcceptTerms(e.target.checked)}
                        disabled={busy}
                        aria-invalid={state.fieldErrors.acceptTerms ? true : undefined}
                      />
                      <span>
                        I have the right to publish this code under its license, and I accept the{' '}
                        <a href={SUBMISSION_DOCS_URL} className="action-link" rel="noopener noreferrer">submission terms</a>.
                      </span>
                    </label>
                    {state.fieldErrors.acceptTerms && (
                      <p className="form-error" role="alert">{state.fieldErrors.acceptTerms}</p>
                    )}
                  </div>
                  {state.step === 'submitting' && state.phase && (
                    <PowProgress phase={state.phase} attempts={state.attempts} difficulty={state.difficulty} action="Submitting." />
                  )}
                  <div className="flex justify-end">
                    <Button onClick={submit} loading={state.step === 'submitting'}>Submit for review</Button>
                  </div>
                </section>
              </>
            )}
          </>
        )}
      </div>
    </PublicLayout>
  );
}

export const getServerSideProps: GetServerSideProps<WithSiteUrl> = async () => ({ props: { siteUrl: resolveSiteUrl() } });
