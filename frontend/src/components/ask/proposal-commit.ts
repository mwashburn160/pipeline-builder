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
 * PROVENANCE (rule 6). Every commit made here is marked as an agent draft that
 * a person applied, by one of two channels.
 *
 * The queue kinds carry it in the free-text field their route already delivers
 * to the approver and the audit row (`note` / `reason`), folded in before the
 * diff is rendered so the reviewed text is the filed text. That text is FOR A
 * HUMAN, so it is not duplicated into `details` — the same fact twice in two
 * vocabularies is one more thing to keep in sync, and the approver is the one
 * who needs to see it.
 *
 * Every other kind — the creates, the plain edits, and org settings — sends the
 * `X-PB-Proposed-By` HEADER, as `{ proposedByAgent: true }` on the api call.
 * The receiving route accepts exactly one value (the shared
 * `ASK_AGENT_PROPOSER` constant, refusing any other with a 400 before it
 * writes) and folds it into its OWN audit details with
 * `withProposalProvenance`, which can write only the `proposedBy` key and
 * applies it last. So the audit event stays the handler's, and the one thing
 * this browser can add to it is the one thing rule 6 asks for:
 * `details: { proposedBy: 'ask-agent' }`.
 *
 * A HEADER, not a body field, for the reason the earlier gap existed at all: a
 * `proposedBy` in the body would be a new key on six domain schemas, several of
 * which feed `Object.keys(body)` straight into a column list and an audit
 * `fields` array, and two of which are `.strict()` and would 400 on it.
 * Transport metadata belongs on the transport — the same place
 * `X-Step-Up-Token` rides.
 */

import { orgSettingRequests } from '@pipeline-builder/api-core/ask-proposals';
import api from '@/lib/api';
import type { ProposedByOptions } from '@/lib/api/util';
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

/**
 * Rule 6's marker, on every write this module makes. It is a constant, not a
 * parameter: there is no path through `commitProposal` that is not an agent
 * draft the user reviewed and applied.
 *
 * The two QUEUE kinds are the exception and deliberately do not use it — their
 * provenance is the sentence in the `note` / `reason` the approver reads (see
 * the module note above), and a duplicate in `details` would add nothing the
 * queue row does not already say.
 */
const PROPOSED_BY_AGENT: ProposedByOptions = { proposedByAgent: true };

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
      await api.updatePipeline(p.id as string, body<Parameters<typeof api.updatePipeline>[1]>(payload), PROPOSED_BY_AGENT);
      invalidate.pipelines();
      return;
    case 'plugin-edit':
      await api.updatePlugin(p.id as string, body<Parameters<typeof api.updatePlugin>[1]>(payload), PROPOSED_BY_AGENT);
      invalidate.plugins();
      return;
    case 'template-edit':
      await api.updatePipelineTemplate(p.id as string, body<Parameters<typeof api.updatePipelineTemplate>[1]>(payload), PROPOSED_BY_AGENT);
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
    }, PROPOSED_BY_AGENT);
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
    }, PROPOSED_BY_AGENT);
    return true;
  }

  if (p.kind === 'template') {
    const tmpl = p.template as Parameters<typeof api.createPipelineTemplate>[0] | undefined;
    if (!tmpl?.name || !tmpl.props) throw incomplete('missing name/props');
    await api.createPipelineTemplate(tmpl, PROPOSED_BY_AGENT);
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
