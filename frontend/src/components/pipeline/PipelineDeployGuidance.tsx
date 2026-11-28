// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import Link from 'next/link';
import { Rocket } from 'lucide-react';
import { CodeBlock } from '@/components/ui/CodeBlock';
import { InfoAlert } from '@/components/ui/InfoAlert';
import { WarningAlert } from '@/components/ui/WarningAlert';
import { DeployPipelinePanel } from './DeployPipelinePanel';

/**
 * What to tell someone about a pipeline that has no deploy registration yet.
 *
 * A pipeline created in the dashboard (Generate from Git, manual create, a
 * template) is only a CONFIG: nothing runs until it is deployed, and nothing
 * reports until it is registered. The facts the copy below relies on:
 *
 *  - A pipeline runner with deploys enabled (`setup-runner --enable-deploy`)
 *    deploys it into the runner's AWS account and registers it
 *    (DeployPipelinePanel) — the dashboard's way.
 *  - `pipeline-manager pipeline deploy --id <id>` deploys it and registers it
 *    from a machine with AWS credentials — the alternative.
 *  - Run pipeline does NOT deploy: it starts an already-deployed CodePipeline
 *    through the org's pipeline runner (found by its `pb.pipeline-id` tag). For
 *    a never-deployed pipeline the runner finds nothing to start.
 *  - A pipeline deployed any other way (CDK directly, CI, a runner-driven
 *    deploy) registers itself on its first pipeline event, once the events
 *    forwarder is set up (`pipeline-manager setup-events`).
 */

/** The CLI command that deploys (and registers) a pipeline. */
export function deployCommand(pipelineId: string): string {
  return `pipeline-manager pipeline deploy --id ${pipelineId}`;
}

/** Where the Deployments page opens its Register deployment form for one pipeline. */
export function registerDeploymentHref(pipelineId: string): string {
  return `/dashboard/deployments?register=${encodeURIComponent(pipelineId)}`;
}

/**
 * The pipeline page's banner for an UNREGISTERED pipeline (renders nothing when
 * registered). `hasEvents` tells the two states apart: false is the normal
 * state right after create (never deployed); true means it has reported before,
 * so it was deployed and its registration has since gone.
 */
export function PipelineRegistrationBanner({ pipelineId, registered, hasEvents, onRegister, className }: {
  pipelineId: string;
  registered: boolean;
  hasEvents?: boolean;
  /** Open the Register deployment dialog on this page; without it, the action links to the Deployments page. */
  onRegister?: () => void;
  className?: string;
}) {
  if (registered) return null;
  const registerAction = onRegister
    ? <button type="button" onClick={onRegister} className="action-link">Register deployment</button>
    : <Link href={registerDeploymentHref(pipelineId)} className="action-link">Register deployment</Link>;
  if (hasEvents) {
    return (
      <WarningAlert
        className={className}
        message={(
          <>
            <strong>Deployed but not registered.</strong> This pipeline has reported runs before, but it has no
            deploy registration now, so new runs, reports and DORA metrics are not recorded. It registers itself
            on its next pipeline event; to register it now, use{' '}
            {registerAction}.
          </>
        )}
      />
    );
  }
  return (
    <InfoAlert
      className={className}
      message={(
        <>
          <strong>Not deployed yet.</strong> Runs, reports and DORA metrics start after the first deploy. Deploy it
          through a pipeline runner with deploys enabled, or with <code>{deployCommand(pipelineId)}</code>. Run pipeline only starts a pipeline that is already deployed
          (through your pipeline runner); it does not deploy one. Deployed it another way (CDK, CI)? It registers
          itself on its first pipeline event, or use{' '}
          {registerAction}.
        </>
      )}
    />
  );
}

/** The create flows' success state: the pipeline exists, and deploying it is the next step —
 *  through a pipeline runner here, or with the CLI as the alternative. */
export function DeployNextStep({ pipelineId, className = '' }: { pipelineId: string; className?: string }) {
  return (
    <section aria-label="Next step: deploy" className={['rounded-xl border border-default p-4 space-y-3', className].filter(Boolean).join(' ')}>
      <div className="flex items-center gap-2">
        <Rocket className="w-4 h-4 text-fg-muted" aria-hidden="true" />
        <h3 className="text-sm font-semibold text-fg">Next step: deploy it</h3>
      </div>
      <p className="text-sm text-fg-muted">
        The pipeline is saved but not deployed: nothing runs, and its runs, reports and DORA metrics stay empty
        until it is.
      </p>
      <DeployPipelinePanel pipelineId={pipelineId} />
      <p className="text-sm text-fg-muted">Or deploy it from a machine with AWS credentials for the target account:</p>
      <CodeBlock code={deployCommand(pipelineId)} language="bash" />
      <p className="text-xs text-fg-subtle">
        Either way the deploy registers the pipeline for reporting. Run pipeline starts an already-deployed pipeline; it
        does not deploy one. A pipeline deployed another way registers itself on its first pipeline event.
      </p>
      <Link href={`/dashboard/pipelines/${encodeURIComponent(pipelineId)}`} className="action-link text-sm">Open pipeline →</Link>
    </section>
  );
}
