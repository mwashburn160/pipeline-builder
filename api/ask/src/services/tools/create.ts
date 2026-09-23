// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The CREATE proposals: whole new pipelines, plugins and templates.
 *
 * None of these writes. Each returns a DRAFT the user reviews and commits from
 * the Ask panel through their own session. What changed in this pass is that a
 * draft no longer comes back unexamined:
 *
 *  - every draft is dry-run against the org's compliance rules before it is
 *    returned, so the card says "compliant" or NAMES the rule it breaks
 *    (phase 2), and
 *  - a drafted TEMPLATE additionally goes through pipeline-core's
 *    `validateTemplateDraft`, because `propose_template` is the only propose
 *    tool with no service-side generator behind it: it was raw model output
 *    against a Zod schema, so an undeclared `{{ vars.NAME }}` or a reference
 *    cycle was creatable and only surfaced at synth.
 */

import { generateObject, tool } from '@pipeline-builder/ai-core';
import type { ToolSet } from '@pipeline-builder/ai-core';
import { validateTemplateDraft } from '@pipeline-builder/pipeline-core';
import { z } from 'zod';

import { checkDraft, pipelineAttributes, pluginAttributes } from './compliance.js';
import { ASK_PROVENANCE, declined } from '../proposals.js';
import type { AgentToolDeps } from '../tool-deps.js';
import { ResourceId } from '../tool-deps.js';
import { asRecord, unwrap } from '../tool-helpers.js';

/** Shape the model drafts for a reusable pipeline template. */
const TemplateSchema = z.object({
  name: z.string().describe('Short template name'),
  description: z.string().optional(),
  category: z.string().optional(),
  props: z.record(z.string(), z.any()).describe('Pipeline config; use {{ vars.NAME }} for parameterized values'),
  inputs: z
    .array(z.object({
      name: z.string(),
      description: z.string().optional(),
      required: z.boolean().optional(),
      default: z.string().optional(),
    }))
    .optional()
    .describe('Declared variables referenced by {{ vars.NAME }} in props'),
});

/** What the pipeline/plugin generators answer with. */
interface Generated {
  props?: unknown;
  config?: unknown;
  dockerfile?: string;
  description?: string;
  keywords?: string[];
  analysis?: unknown;
}

export function createTools(deps: AgentToolDeps): ToolSet {
  const { pipeline, plugin, model, defaults, orgId, chargeAiCall, maxOutputTokens } = deps;

  /** The provider/model the request chose, added to a delegated generator's body. */
  const generationBody = (base: Record<string, unknown>): Record<string, unknown> => {
    const body = { ...base };
    if (defaults.provider) body.provider = defaults.provider;
    if (defaults.model) body.model = defaults.model;
    return body;
  };

  return {
    propose_pipeline: tool({
      description:
        'Generate a PROPOSED pipeline configuration from a natural-language description. '
        + 'This does NOT create anything — it returns a draft the user must review and confirm. '
        + "The draft is dry-run against the organization's compliance rules and reports any rule it breaks. "
        + 'Use it when the user asks to create or build a pipeline. Never claim the pipeline was created.',
      inputSchema: z.object({ prompt: z.string().describe('What the pipeline should do') }),
      execute: async ({ prompt }) => {
        const res = await pipeline.post('/pipelines/generate', generationBody({ prompt }));
        const data = unwrap<Generated>(res) ?? {};
        return {
          kind: 'pipeline' as const,
          props: data.props,
          description: data.description,
          keywords: data.keywords,
          compliance: await checkDraft(deps, 'pipeline', pipelineAttributes(data.props, orgId)),
          refusedFields: [],
          provenance: ASK_PROVENANCE,
        };
      },
    }),

    propose_pipeline_from_repo: tool({
      description:
        'Generate a PROPOSED pipeline for a Git repository by analyzing it (languages, frameworks, '
        + 'package manager, Dockerfile/CDK) — prefer this over propose_pipeline whenever the user gives a '
        + 'repository URL. Draft only: nothing is created until the user reviews and confirms it.',
      inputSchema: z.object({ gitUrl: z.string().describe('The repository URL (HTTPS, SSH, or git@ form)') }),
      execute: async ({ gitUrl }) => {
        const body = generationBody({ gitUrl });
        // Private-repo token comes from the request, never from the model.
        if (defaults.repoToken) body.repoToken = defaults.repoToken;
        const data = unwrap<Generated>(await pipeline.post('/pipelines/generate/from-url', body)) ?? {};
        return {
          kind: 'pipeline' as const,
          props: data.props,
          description: data.description,
          keywords: data.keywords,
          analysis: data.analysis,
          compliance: await checkDraft(deps, 'pipeline', pipelineAttributes(data.props, orgId)),
          refusedFields: [],
          provenance: ASK_PROVENANCE,
        };
      },
    }),

    propose_plugin: tool({
      description:
        'Generate a PROPOSED plugin (plugin-spec + Dockerfile) from a description. Draft only — the '
        + 'user reviews and confirms; creating a plugin then runs an ASYNC Docker build. Use it when the '
        + 'user asks to create/build a plugin. Never claim the plugin was created — creation is asynchronous.',
      inputSchema: z.object({ prompt: z.string().describe('What the plugin/build should do') }),
      execute: async ({ prompt }) => {
        const data = unwrap<Generated>(await plugin.post('/plugins/generate', generationBody({ prompt }))) ?? {};
        return {
          kind: 'plugin' as const,
          config: data.config,
          dockerfile: data.dockerfile,
          compliance: await checkDraft(deps, 'plugin', pluginAttributes(data.config)),
          refusedFields: [],
          provenance: ASK_PROVENANCE,
        };
      },
    }),

    propose_plugin_from_repo: tool({
      description:
        'Generate a PROPOSED plugin (plugin-spec + Dockerfile) for a Git repository by analyzing it first '
        + '(languages, frameworks, package manager, Dockerfile/CDK), so the draft matches how the repository '
        + 'actually builds. Prefer it over propose_plugin whenever the user gives a repository URL. Draft only '
        + '— nothing is created, and creating a plugin then runs an ASYNC Docker build.',
      inputSchema: z.object({ gitUrl: z.string().describe('The repository URL (HTTPS, SSH, or git@ form)') }),
      execute: async ({ gitUrl }) => {
        // TWO delegated generations, deliberately. The plugin service has no
        // `/generate/from-url` counterpart and repository analysis lives behind
        // the pipeline service's Git-analysis client, so the only way to draft a
        // plugin FROM a repo is: analyze via the pipeline generator, then feed
        // the analysis summary to the plugin generator. Each endpoint reserves
        // its OWN `aiCalls` slot (they are separate model invocations), so this
        // tool costs two — the same accounting as any other delegated generator,
        // just twice. The pipeline half's config is discarded; only its
        // `analysis` is used, and it is carried onto the draft so the card can
        // show what the repository was found to be.
        const analyzeBody = generationBody({ gitUrl });
        if (defaults.repoToken) analyzeBody.repoToken = defaults.repoToken;
        const analyzed = unwrap<Generated>(await pipeline.post('/pipelines/generate/from-url', analyzeBody)) ?? {};
        const analysis = analyzed.analysis;
        if (!analysis) {
          return declined('plugin', 'The repository could not be analyzed, so no plugin was drafted.');
        }

        const prompt =
          'Create a build plugin for this repository. Repository analysis (authoritative — do not invent facts '
          + `beyond it):\n${JSON.stringify(analysis)}\n`
          + 'Match its language, package manager and build tooling. Keep the plugin minimal and valid.';
        const data = unwrap<Generated>(await plugin.post('/plugins/generate', generationBody({ prompt }))) ?? {};
        return {
          kind: 'plugin' as const,
          config: data.config,
          dockerfile: data.dockerfile,
          analysis,
          compliance: await checkDraft(deps, 'plugin', pluginAttributes(data.config)),
          refusedFields: [],
          provenance: ASK_PROVENANCE,
        };
      },
    }),

    propose_template: tool({
      description:
        'Generate a PROPOSED reusable pipeline TEMPLATE (with {{ vars.NAME }} placeholders and declared '
        + 'inputs) from a description. Draft only — the user reviews and creates it. Templates have no '
        + 'dedicated generator, so this drafts one directly and then validates it exactly as the create API '
        + 'will. Use it when the user asks for a reusable template.',
      inputSchema: z.object({ prompt: z.string().describe('What the template should do') }),
      execute: async ({ prompt }) => {
        // In-process generation pays its own aiCalls slot, and DECLINES rather
        // than failing when the org is out (design rule 9).
        if (!(await chargeAiCall('propose_template'))) {
          return declined('template', 'The organization has no AI generation quota left for this period.');
        }
        const { object } = await generateObject({
          model,
          maxOutputTokens,
          schema: TemplateSchema,
          prompt:
            `Create a reusable Pipeline Builder template for: ${prompt}\n`
            + 'Parameterize values with {{ vars.NAME }} and declare each one in "inputs". Keep it minimal and valid.',
        });
        // pipeline-core's own drafted-template validator: parse errors anywhere
        // in the body, reserved/unknown scope roots, cycles, undeclared
        // `{{ vars.NAME }}`, and inputs that are duplicated, unusable as
        // identifiers, or declared but never referenced.
        const validation = validateTemplateDraft(asRecord(object));
        return {
          kind: 'template' as const,
          template: object,
          validation,
          // A template renders into a pipeline, so it is judged by the PIPELINE
          // rule set — the same rules the instantiated pipeline will face.
          compliance: await checkDraft(deps, 'pipeline', pipelineAttributes(asRecord(object).props, orgId)),
          refusedFields: [],
          provenance: ASK_PROVENANCE,
        };
      },
    }),

    list_templates: tool({
      description:
        "List the org's reusable pipeline templates with their declared input variables. Use this to find a "
        + 'template to instantiate into a pipeline, and to see which inputs it needs.',
      inputSchema: z.object({}),
      execute: async () => {
        const res = (await pipeline.get('/pipeline-templates')) as { data?: unknown };
        return { templates: res?.data ?? res };
      },
    }),

    propose_pipeline_from_template: tool({
      description:
        "Fill a variable TEMPLATE's inputs to produce a concrete pipeline DRAFT (renders {{ vars.NAME }} with the "
        + 'supplied values). Use when the user wants a pipeline created FROM an existing template. Draft only — the '
        + 'user reviews and confirms. Find the template + its inputs first with list_templates.',
      inputSchema: z.object({
        templateId: ResourceId.describe('The template id (from list_templates)'),
        project: z.string().describe('Project identifier for the new pipeline'),
        // NOTE: `organization` is deliberately NOT a model-supplied input — it is
        // injected from the authenticated caller's org below, so a prompt-injected
        // message can't retarget the instantiation at another tenant's org.
        pipelineName: z.string().optional(),
        inputs: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe("Values for the template's declared input variables, keyed by input name"),
      }),
      execute: async ({ templateId, project, pipelineName, inputs }) => {
        // organization is the authenticated caller's org — never model-chosen.
        const body: Record<string, unknown> = { project, organization: orgId };
        if (pipelineName) body.pipelineName = pipelineName;
        if (inputs) body.inputs = inputs;
        const data = unwrap<Generated>(await pipeline.post(`/pipeline-templates/${encodeURIComponent(templateId)}/instantiate`, body)) ?? {};
        // A rendered template is a concrete pipeline draft — same commit path as propose_pipeline.
        return {
          kind: 'pipeline' as const,
          props: data.props,
          description: data.description,
          compliance: await checkDraft(deps, 'pipeline', pipelineAttributes(data.props, orgId)),
          refusedFields: [],
          provenance: ASK_PROVENANCE,
        };
      },
    }),
  };
}
