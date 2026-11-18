// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * EDIT proposals.
 *
 * Every other propose tool CREATES something. "Add a test stage", "bump the base
 * image", "add an input to that template" — the more common request by far —
 * needs its own tools, or the assistant either refuses or re-drafts the whole
 * thing from scratch and silently drops whatever the existing document carried.
 *
 * Each tool here READS the entity as it is now, diffs the model's requested
 * changes against it, and returns BOTH sides. Three properties fall out of that:
 *
 *  - the card can render CURRENT → PROPOSED instead of a wall of new JSON;
 *  - the commit payload is exactly `pick(proposed, changedFields)`, so a field
 *    the model slipped in that the card never showed is structurally
 *    unappliable — the reviewed diff IS the commit payload;
 *  - the read's `updatedAt` travels as `baseUpdatedAt`, which the UI sends as
 *    the update's `expectedUpdatedAt`: a change landing after the draft is a
 *    412 from the update route, so what the user approved is what is applied.
 *
 * SECRETS. The model never sees a secret value: every tool result reaches it
 * through `redactForModel`, so the `props` it hands back carry `[REDACTED:<tag>]`
 * placeholders where the secrets were. Before anything is diffed, the edit
 * restores the real values from its own re-read (`restoreSecrets`), so applying
 * the draft never writes a placeholder over a real secret. Then the safer rule:
 *
 *  - a placeholder that matches no current secret DECLINES the edit (it cannot
 *    be restored, and must never be persisted);
 *  - a model-written value where a DIFFERENT secret already lives DECLINES the
 *    edit — the assistant cannot change a secret; the user does that in the
 *    editor, where they can see what they are replacing;
 *  - a model-written value at a secret position that held nothing (a new env
 *    entry) is drafted, and listed in `addedSecrets` for the reviewer.
 *
 * Each tool has its OWN allowlist of editable fields. The plugin
 * one is not written out here at all — it IS `PLUGIN_CATALOG_FIELDS`, the same
 * table `PUT /plugins/:id` accepts, so the agent can never be offered an
 * execution-contract key (commands, env, compute type) that the API would refuse
 * anyway: changing what a plugin RUNS is a new version, a new digest and a
 * review diff, never an edit.
 */

import { tool } from '@pipeline-builder/ai-core';
import type { ToolSet } from '@pipeline-builder/ai-core';
import { PLUGIN_CATALOG_FIELDS, pickRuleAttributes } from '@pipeline-builder/api-core';
import { validateTemplateDraft } from '@pipeline-builder/pipeline-core';
import { z } from 'zod';

import { checkDraft, pipelineAttributes, pluginAttributes } from './compliance.js';
import type { CommitTarget, DeclinedProposal, EditProposal } from '../proposals.js';
import { ASK_PROVENANCE, declined } from '../proposals.js';
import { restoreSecrets } from '../secret-redaction.js';
import type { AgentToolDeps } from '../tool-deps.js';
import { ResourceId } from '../tool-deps.js';
import { asRecord, buildDiff, settle, unwrap } from '../tool-helpers.js';

/**
 * Editable pipeline fields. `visibility`, `isDefault` and `isActive` are
 * deliberately absent: who can see a pipeline and which one a project defaults
 * to are authority decisions, not content edits, and an allowlist means they
 * stay unavailable until somebody deliberately adds them.
 */
const PIPELINE_EDIT_FIELDS = ['pipelineName', 'description', 'keywords', 'props'] as const;

/** Editable template fields — same reasoning; `visibility` is absent. */
const TEMPLATE_EDIT_FIELDS = ['name', 'description', 'keywords', 'category', 'props', 'inputs'] as const;

/** Editable plugin fields: the descriptive catalog table, and nothing else. */
const PLUGIN_EDIT_FIELDS = PLUGIN_CATALOG_FIELDS;

const PIPELINE_COMMIT: CommitTarget = { service: 'pipeline', method: 'PUT', path: '/pipelines/:id', permission: 'pipelines:write' };
const PLUGIN_COMMIT: CommitTarget = { service: 'plugin', method: 'PUT', path: '/plugins/:id', permission: 'plugins:write' };
const TEMPLATE_COMMIT: CommitTarget = { service: 'pipeline', method: 'PUT', path: '/pipeline-templates/:id', permission: 'templates:write' };

/** The `changes` object the model supplies. Field names are checked against the tool's allowlist. */
const ChangesSchema = z
  .record(z.string(), z.any())
  .describe('Only the fields to change, keyed by field name, each carrying its COMPLETE new value');

/** Pull `{ pipeline: … }` / `{ plugin: … }` / `{ template: … }` out, tolerating a bare body. */
function named(value: unknown, key: string): Record<string, unknown> {
  const rec = asRecord(value);
  return key in rec ? asRecord(rec[key]) : rec;
}

/**
 * The optimistic-concurrency token of the base read: its `updatedAt`, as the
 * ISO string the update routes compare (at millisecond precision). Omitted when
 * the read carried no usable timestamp.
 */
function baseUpdatedAtOf(current: Record<string, unknown>): { baseUpdatedAt?: string } {
  const v = current.updatedAt;
  if (typeof v !== 'string' && !(v instanceof Date)) return {};
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? {} : { baseUpdatedAt: d.toISOString() };
}

export function editTools(deps: AgentToolDeps): ToolSet {
  const { pipeline, plugin, orgId, onRefusedFields } = deps;

  /**
   * The shared body of every edit tool: read → diff → refuse what is off the
   * allowlist → decline an empty diff → hand back both sides.
   */
  async function proposeEdit(opts: {
    kind: EditProposal['kind'];
    toolName: string;
    id: string;
    read: () => Promise<Record<string, unknown>>;
    allowed: readonly string[];
    changes: Record<string, unknown>;
    reason?: string;
    commit: CommitTarget;
    label: (current: Record<string, unknown>) => string;
  }): Promise<EditProposal | DeclinedProposal> {
    const read = await settle(opts.read);
    if (!read.ok) return declined(opts.kind, `Could not read the current ${opts.kind.replace('-edit', '')}: ${read.reason}`);
    const current = read.value;
    const noun = opts.kind.replace('-edit', '');

    // Put the real secrets back where the model left placeholders — before the
    // diff, so an untouched secret is not a change and a placeholder is never
    // proposed (let alone applied) in its place.
    const secrets = restoreSecrets(opts.changes, current);
    if (secrets.unknownPlaceholders.length > 0) {
      return declined(opts.kind,
        `The change carries a redacted secret value that matches nothing in the current ${noun} (${secrets.unknownPlaceholders.join(', ')}). `
        + `Secret values are never shown to the assistant: keep each [REDACTED:…] placeholder exactly as the ${noun} was read, or read it again first.`);
    }
    if (secrets.misplacedPlaceholders.length > 0) {
      return declined(opts.kind,
        `A redacted secret value can only stay where a secret belongs (${secrets.misplacedPlaceholders.join(', ')}). `
        + 'Leave each [REDACTED:…] placeholder in a secret field (env, buildArgs, a token/secret/password key); it is never copied into another field.');
    }
    if (secrets.overwrittenSecrets.length > 0) {
      return declined(opts.kind,
        `Secret values cannot be changed through the assistant (${secrets.overwrittenSecrets.join(', ')}). `
        + `Leave each [REDACTED:…] placeholder as it was read; the user changes a secret in the ${noun} editor.`);
    }

    const diff = buildDiff(current, secrets.value as Record<string, unknown>, opts.allowed);
    if (diff.refusedFields.length > 0) onRefusedFields(opts.toolName, diff.refusedFields);

    if (diff.changedFields.length === 0) {
      const why = diff.refusedFields.length > 0
        ? `None of the requested fields is editable here. Editable: ${opts.allowed.join(', ')}.`
        : 'The requested values already match the current ones — nothing to change.';
      return { ...declined(opts.kind, why), refusedFields: diff.refusedFields };
    }

    return {
      kind: opts.kind,
      id: opts.id,
      target: opts.label(current),
      changedFields: diff.changedFields,
      current: diff.current,
      proposed: diff.proposed,
      changedPaths: diff.changedPaths,
      commit: opts.commit,
      description: opts.reason,
      refusedFields: diff.refusedFields,
      ...(secrets.addedSecrets.length > 0 ? { addedSecrets: secrets.addedSecrets } : {}),
      ...baseUpdatedAtOf(current),
      provenance: ASK_PROVENANCE,
    };
  }

  return {
    propose_pipeline_edit: tool({
      description:
        'Propose a CHANGE to an existing pipeline — add a stage, change a step, rename it, adjust its '
        + 'description or keywords. Read it with inspect_pipeline FIRST, then pass only the fields you are '
        + 'changing, each with its COMPLETE new value (a changed `props` must be the whole props document, not '
        + 'a fragment). Secret values read as [REDACTED:…] placeholders: keep each one exactly as read — they '
        + 'are restored on apply, and a secret cannot be changed here. Returns a reviewable before/after diff; '
        + `nothing is changed until the user applies it. Editable fields: ${PIPELINE_EDIT_FIELDS.join(', ')}.`,
      inputSchema: z.object({
        id: ResourceId.describe('The pipeline id'),
        changes: ChangesSchema,
        reason: z.string().max(500).optional().describe('One sentence: what this change does and why'),
      }),
      execute: async ({ id, changes, reason }) => {
        let currentDoc: Record<string, unknown> = {};
        const proposal = await proposeEdit({
          kind: 'pipeline-edit',
          toolName: 'propose_pipeline_edit',
          id,
          read: async () => {
            currentDoc = named(unwrap(await pipeline.get(`/pipelines/${encodeURIComponent(id)}`)), 'pipeline');
            return currentDoc;
          },
          allowed: PIPELINE_EDIT_FIELDS,
          changes: asRecord(changes),
          reason,
          commit: PIPELINE_COMMIT,
          label: (c) => String(c.pipelineName ?? c.project ?? id),
        });
        if (!('changedFields' in proposal)) return proposal;
        // Every editable field (name, description, keywords, props) is one a
        // rule can read, so every edit is dry-run — and against the pipeline AS
        // IT WILL BE, its stored visibility/owner/labels included, exactly the
        // document `PUT /pipelines/:id` re-checks.
        return {
          ...proposal,
          compliance: await checkDraft(deps, 'pipeline', pickRuleAttributes('pipeline', { ...currentDoc, ...proposal.proposed })),
        };
      },
    }),

    propose_plugin_edit: tool({
      description:
        "Propose a CHANGE to an existing plugin's catalog metadata — its summary, description, category, "
        + 'keywords, license, links, icon, changelog or README. Returns a reviewable before/after diff; '
        + 'nothing is changed until the user applies it. What a plugin RUNS (commands, env, secrets, compute '
        + 'type, name, version) is NOT editable — that is a new version with a new image, so propose a new '
        + `plugin instead. Editable fields: ${PLUGIN_EDIT_FIELDS.join(', ')}.`,
      inputSchema: z.object({
        id: ResourceId.describe('The plugin id'),
        changes: ChangesSchema,
        reason: z.string().max(500).optional().describe('One sentence: what this change does and why'),
      }),
      execute: async ({ id, changes, reason }) => {
        let currentDoc: Record<string, unknown> = {};
        const proposal = await proposeEdit({
          kind: 'plugin-edit',
          toolName: 'propose_plugin_edit',
          id,
          read: async () => {
            currentDoc = named(unwrap(await plugin.get(`/plugins/${encodeURIComponent(id)}`)), 'plugin');
            return currentDoc;
          },
          allowed: PLUGIN_EDIT_FIELDS,
          changes: asRecord(changes),
          reason,
          commit: PLUGIN_COMMIT,
          label: (c) => String(c.name ?? id),
        });
        if (!('changedFields' in proposal)) return proposal;
        // Catalog fields such as `keywords` and `category` are readable by
        // compliance rules, so the edited spec is dry-run like any other draft —
        // the WHOLE spec as it would stand after the edit. `proposal.current`
        // holds only the changed fields, so judging that alone left every rule
        // on an untouched field (name, publisher, compute type…) reading absent.
        return {
          ...proposal,
          compliance: await checkDraft(deps, 'plugin', pluginAttributes({ ...currentDoc, ...proposal.proposed })),
        };
      },
    }),

    propose_template_edit: tool({
      description:
        'Propose a CHANGE to an existing pipeline TEMPLATE — add or rename a declared input, adjust the '
        + 'parameterized props, change its name/description/category/keywords. Read it with list_templates '
        + 'first, then pass only the fields you are changing, each with its COMPLETE new value. The edited '
        + 'template is validated exactly as the update API will validate it (unknown scope roots, reference '
        + 'cycles, undeclared {{ vars.X }}). Returns a reviewable before/after diff; nothing is changed until '
        + `the user applies it. Editable fields: ${TEMPLATE_EDIT_FIELDS.join(', ')}.`,
      inputSchema: z.object({
        id: ResourceId.describe('The template id (from list_templates)'),
        changes: ChangesSchema,
        reason: z.string().max(500).optional().describe('One sentence: what this change does and why'),
      }),
      execute: async ({ id, changes, reason }) => {
        let currentDoc: Record<string, unknown> = {};
        const proposal = await proposeEdit({
          kind: 'template-edit',
          toolName: 'propose_template_edit',
          id,
          read: async () => {
            currentDoc = named(unwrap(await pipeline.get(`/pipeline-templates/${encodeURIComponent(id)}`)), 'template');
            return currentDoc;
          },
          allowed: TEMPLATE_EDIT_FIELDS,
          changes: asRecord(changes),
          reason,
          commit: TEMPLATE_COMMIT,
          label: (c) => String(c.name ?? id),
        });
        if (!('changedFields' in proposal)) return proposal;
        const touchesBody = proposal.changedFields.includes('props') || proposal.changedFields.includes('inputs');
        if (!touchesBody) return proposal;
        // Validate the MERGED document: changing only `inputs` can leave a
        // placeholder in the untouched `props` undeclared, and changing only
        // `props` can introduce a placeholder the untouched `inputs` never
        // declared. Either way the update API would 400.
        const merged = { ...currentDoc, ...proposal.proposed };
        return {
          ...proposal,
          validation: validateTemplateDraft(asRecord(merged)),
          compliance: await checkDraft(deps, 'pipeline', pipelineAttributes(asRecord(merged).props, orgId)),
        };
      },
    }),
  };
}
