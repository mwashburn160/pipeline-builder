// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Committing a proposal — the confirm half of propose/confirm.
 *
 * Every path here calls the SAME API the dashboard's own button calls, through
 * the user's own session and permissions; the agent never writes. Four rules
 * this module enforces:
 *
 *  - **Re-read first (rule 7).** None of these tables carries a version column,
 *    so the only way to know the approved diff is still the applied diff is to
 *    fetch the live state and compare it against the snapshot the diff was
 *    rendered from. A move is a refusal ({@link StaleDraftError}), not a clobber.
 *  - **Send only the reviewed fields (rule 3).** The payload is a projection of
 *    the rendered rows (`commitPayload`), so a field the model added but the
 *    panel did not render has no way into the request. Org settings get the
 *    same property from the shared allowlist: the per-surface bodies are built
 *    here with `orgSettingRequests(...)` from the changes that were RENDERED,
 *    not taken from the `requests` the stream also carries — a body that
 *    arrived over the wire would be one the user reviewed only by proxy.
 *  - **Never send a secret (rule 4).** A redacted row is rendered as presence
 *    and excluded from the payload, so a credential cannot be committed here at
 *    all — the Settings page is where those are typed.
 *  - **Remediation files a request (Phase 4).** Where the platform already has
 *    an approval queue — install change-requests, compliance exemptions — the
 *    commit enqueues into it rather than writing, so the decision stays with an
 *    approver who was not in the conversation.
 *
 * PROVENANCE (rule 6), and where it stops. The queue kinds carry the marker in
 * the free-text field their route already delivers to the approver and the
 * audit row (`note` / `reason`), folded in before the diff is rendered so the
 * reviewed text is the filed text.
 *
 * The plain edit and org-settings kinds have no such channel. The shared module
 * exports `askProposalAuditDetails()`, which produces the
 * `details: { proposedBy: 'ask-agent' }` fragment rule 6 wants — but it is a
 * fragment for a `RemoteAuditEvent`, which only the SERVICE that handles the
 * write can emit, and no write route reads a provenance field off the request.
 * `PUT /pipelines/:id` validates its body with a non-strict Zod object
 * (`PipelineUpdateSchema`), which STRIPS unknown keys, and the plugin, template
 * and notification-preference routes are the same. Putting `details` in the
 * body would be inventing a field the API ignores, so nothing is sent from
 * here. Closing the gap is a passthrough on those schemas and handlers
 * (api-core + the owning service) that calls `askProposalAuditDetails()` when
 * it records — not a change to this file.
 */

import { orgSettingRequests } from '@pipeline-builder/api-core/ask-proposals';
import api from '@/lib/api';
import { invalidate } from '@/lib/api-cache';
import type { BuilderProps } from '@/types';
import { commitPayload, staleFields } from './proposal-diff';
import type { Proposal } from './proposal';
import { appliableOrgSettingChanges, orgSettingsReview, proposalDiff, proposalSides } from './proposal';
import { applyOrgSettingRequests, readOrgSettings } from './org-settings-client';

/**
 * The live state moved after the draft was rendered, so the diff the user
 * approved is not the diff that would be applied. Nothing was written.
 */
export class StaleDraftError extends Error {
  constructor(public readonly fields: string[]) {
    super(
      `This changed after the draft was reviewed (${fields.join(', ')}), so nothing was applied. `
      + 'Ask again to draft against the current state.',
    );
    this.name = 'StaleDraftError';
  }
}

/** A draft that cannot be committed at all (missing id, unknown route, …). */
function incomplete(what: string): Error {
  return new Error(`Draft is incomplete (${what}).`);
}

type Row = Record<string, unknown>;

/** Cast a reviewed payload to a route's body type at the one place they meet. */
function body<T>(payload: Row): T {
  return payload as unknown as T;
}

/**
 * The live state, keyed by the SAME field names the diff was rendered against.
 * `null` means nothing is being overwritten — a remediation request creates a
 * new queue row, so there is no prior state to go stale.
 */
async function readLiveState(p: Proposal): Promise<Row | null> {
  switch (p.kind) {
    case 'pipeline-edit':
      return (await api.getPipelineById(p.id as string)).data?.pipeline as unknown as Row;
    case 'plugin-edit':
      return (await api.getPluginById(p.id as string)).data?.plugin as unknown as Row;
    case 'template-edit':
      return (await api.getPipelineTemplate(p.id as string)).data?.template as unknown as Row;
    case 'install-change-request': {
      const installs = (await api.listPluginInstalls()).data?.installs ?? [];
      const live = installs.find((i) => i.id === p.id);
      if (!live) throw new Error('That install no longer exists, so nothing was requested.');
      // Normalized into the field names the change-request body uses, which are
      // the names the diff compared — `pinnedVersion` is the install's baseline.
      return { version: live.pinnedVersion, versionPolicy: live.versionPolicy };
    }
    default:
      return null;
  }
}

/**
 * Apply an org-settings proposal.
 *
 * The change set is re-derived from a FRESH read and compared with the one the
 * user approved (rule 7): these records carry no version column, so a setting
 * that moved under the proposal — including one that now already holds the
 * proposed value — invalidates the review. `orgSettingRequests` then builds one
 * request per surface FROM THOSE CHANGES, which is rule 3: a field that was not
 * a reviewed change has no route into a body.
 *
 * The three surfaces are three services with no transaction between them, so a
 * partial apply is reported as a partial apply, never as success.
 */
async function commitOrgSettings(p: Proposal): Promise<void> {
  const changes = appliableOrgSettingChanges(orgSettingsReview(p).changes);
  if (changes.length === 0) throw incomplete('nothing in this draft can be applied');

  const live = await readOrgSettings(changes.map((c) => c.spec.key));
  const moved = changes.filter((c) => live[c.spec.key] !== c.from).map((c) => c.spec.label);
  if (moved.length > 0) throw new StaleDraftError(moved);

  const { applied, failed } = await applyOrgSettingRequests(orgSettingRequests(changes));
  invalidate.organizations();
  if (failed.length > 0) {
    throw new Error(
      `${applied.length > 0 ? `Applied ${applied.length} of ${applied.length + failed.length} settings groups. ` : ''}`
      + `Not applied: ${failed.map((f) => `${f.label} (${f.message})`).join('; ')}.`,
    );
  }
}

/** Apply (or file) the reviewed payload for a non-org-settings kind. */
async function applyPayload(p: Proposal, payload: Row): Promise<void> {
  // The payload's keys are constrained by the proposal allowlist and by the
  // rendered rows, not by these signatures, so each call site is where a
  // dynamic object meets a per-route body type.
  switch (p.kind) {
    case 'pipeline-edit':
      await api.updatePipeline(p.id as string, body<Parameters<typeof api.updatePipeline>[1]>(payload));
      invalidate.pipelines();
      return;
    case 'plugin-edit':
      await api.updatePlugin(p.id as string, body<Parameters<typeof api.updatePlugin>[1]>(payload));
      invalidate.plugins();
      return;
    case 'template-edit':
      await api.updatePipelineTemplate(p.id as string, body<Parameters<typeof api.updatePipelineTemplate>[1]>(payload));
      return;
    case 'install-change-request':
      await api.requestInstallChange(p.id as string, body<Parameters<typeof api.requestInstallChange>[1]>(payload));
      invalidate.plugins();
      return;
    case 'compliance-exemption-request':
      await api.createExemption(body<Parameters<typeof api.createExemption>[0]>(payload));
      return;
    default:
      throw incomplete('unknown proposal kind');
  }
}

/** Create kinds: the drafted document, committed through the normal create route. */
async function commitCreate(p: Proposal): Promise<boolean> {
  if (p.kind === 'pipeline') {
    // The drafted `props` is a full BuilderProps (carries project/organization);
    // wrap it in the create envelope exactly like the normal create flow.
    const bp = p.props as BuilderProps | undefined;
    if (!bp?.project || !bp.organization) throw incomplete('missing project/organization');
    await api.createPipeline({
      project: bp.project,
      organization: bp.organization,
      pipelineName: bp.pipelineName,
      description: p.description,
      props: bp,
      visibility: 'private',
    });
    // Every cached pipeline list (the Pipelines page, palette, home) is stale now.
    invalidate.pipelines();
    return true;
  }

  if (p.kind === 'plugin') {
    if (!p.config || !p.dockerfile) throw incomplete('missing config or Dockerfile');
    await api.deployGeneratedPlugin({
      ...(p.config as Parameters<typeof api.deployGeneratedPlugin>[0]),
      dockerfile: p.dockerfile,
      visibility: 'private',
    });
    return true;
  }

  if (p.kind === 'template') {
    const tmpl = p.template as Parameters<typeof api.createPipelineTemplate>[0] | undefined;
    if (!tmpl?.name || !tmpl.props) throw incomplete('missing name/props');
    await api.createPipelineTemplate(tmpl);
    return true;
  }

  return false;
}

/**
 * Commit a proposal. The caller has already re-checked the kind's permissions —
 * a refused proposal must never look like a failed draft.
 */
export async function commitProposal(p: Proposal): Promise<void> {
  if (await commitCreate(p)) return;

  if (p.kind === 'org-settings-edit') return commitOrgSettings(p);

  const diff = proposalDiff(p);
  const payload = commitPayload(proposalSides(p).proposed, diff.rows);
  if (Object.keys(payload).length === 0) throw incomplete('nothing in this draft can be applied');

  const live = await readLiveState(p);
  if (live) {
    const moved = staleFields(p.current, live, diff.rows);
    if (moved.length > 0) throw new StaleDraftError(moved);
  }

  await applyPayload(p, payload);
}
