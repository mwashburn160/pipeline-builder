// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

// Tool set for the "Ask" agent's tool-calling loop. All tools are READ or
// PROPOSE — none of them writes. `propose_pipeline` calls the pipeline service's
// generate endpoint (forwarding the user's token) and returns a DRAFT; the actual
// create is a separate, explicit user action in the UI (confirm gate), committed
// through the user's own session. So the agent can never mutate anything.

import { buildGroundingContext, generateObject, tool } from '@pipeline-builder/ai-core';
import type { GroundingIndex, LanguageModel, ToolSet } from '@pipeline-builder/ai-core';
import { z } from 'zod';

import type { ServiceClient } from './internal-http.js';

export interface AgentToolDeps {
  index: GroundingIndex;
  /** Pipeline service client, pre-bound to the caller's forwarded bearer token. */
  pipeline: ServiceClient;
  /** Plugin service client, pre-bound to the caller's forwarded bearer token. */
  plugin: ServiceClient;
  /** The resolved model — used by propose_template (templates have no AI endpoint). */
  model: LanguageModel;
  /**
   * Out-of-band values for delegated generation (from the request): the
   * provider/model, and a private-repo token for propose_pipeline_from_repo.
   * Never exposed to the model as tool input.
   */
  defaults: { provider?: string; model?: string; repoToken?: string };
  /**
   * The AUTHENTICATED caller's org id. Injected into tenant-scoping tool inputs
   * (e.g. template instantiation) so the MODEL can never choose which org a call
   * targets — closing a prompt-injection path where a crafted message could name
   * another tenant's org. The model only ever supplies non-authority fields.
   */
  orgId: string;
  /**
   * Reserve one `aiCalls` slot for a generation this service runs IN-PROCESS on
   * the model's behalf (propose_template → generateObject). The turn's own slot
   * pays for the agent's reasoning; an extra model invocation must pay its own,
   * exactly as the delegated pipeline/plugin generators do. Resolves false when
   * the org is out of quota (the tool then declines instead of generating).
   */
  chargeAiCall: () => Promise<boolean>;
  /** Output-token cap for in-process generations. */
  maxOutputTokens: number;
}

/**
 * A resource id the MODEL supplies (it lands in a URL path). Opaque-id charset
 * only: no `/`, no `.` — so neither a slash nor a `..` segment can walk the
 * forwarded request to a different route than the one the tool names.
 */
const ResourceId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, 'must be an opaque id (letters, digits, - or _)');

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

/** Build the agent's tools. Every tool acts as the calling user (token-forwarded). */
export function buildAgentTools({ index, pipeline, plugin, model, defaults, orgId, chargeAiCall, maxOutputTokens }: AgentToolDeps): ToolSet {
  return {
    answer_how_to: tool({
      description:
        'Look up platform documentation to answer a how-to or functionality question. ' +
        'Returns grounded context and its sources — call this before answering any "how do I…" question, and answer only from what it returns.',
      inputSchema: z.object({ query: z.string().describe('The question to look up in the docs') }),
      execute: async ({ query }) => {
        const hits = index.search(query, 5);
        return {
          context: buildGroundingContext(hits),
          sources: hits.map((h) => ({ id: h.doc.id, title: h.doc.title, url: h.doc.url })),
        };
      },
    }),

    list_pipelines: tool({
      description: "List the current organization's existing pipelines, to reason about what is already there.",
      inputSchema: z.object({}),
      execute: async () => {
        const res = (await pipeline.get('/pipelines')) as { data?: unknown };
        return { pipelines: res?.data ?? res };
      },
    }),

    inspect_pipeline: tool({
      description: 'Fetch one pipeline by id to inspect its configuration before answering or proposing changes.',
      inputSchema: z.object({ id: ResourceId.describe('The pipeline id') }),
      execute: async ({ id }) => {
        const res = (await pipeline.get(`/pipelines/${encodeURIComponent(id)}`)) as { data?: unknown };
        return { pipeline: res?.data ?? res };
      },
    }),

    propose_pipeline: tool({
      description:
        'Generate a PROPOSED pipeline configuration from a natural-language description. ' +
        'This does NOT create anything — it returns a draft the user must review and confirm. ' +
        'Use it when the user asks to create or build a pipeline. Never claim the pipeline was created.',
      inputSchema: z.object({ prompt: z.string().describe('What the pipeline should do') }),
      execute: async ({ prompt }) => {
        const body: Record<string, unknown> = { prompt };
        if (defaults.provider) body.provider = defaults.provider;
        if (defaults.model) body.model = defaults.model;
        const res = (await pipeline.post('/pipelines/generate', body)) as { data?: { props?: unknown; description?: string; keywords?: string[] } };
        const data = res?.data ?? (res as { props?: unknown; description?: string; keywords?: string[] });
        return { kind: 'pipeline', props: data?.props, description: data?.description, keywords: data?.keywords };
      },
    }),

    propose_pipeline_from_repo: tool({
      description:
        'Generate a PROPOSED pipeline for a Git repository by analyzing it (languages, frameworks, ' +
        'package manager, Dockerfile/CDK) — prefer this over propose_pipeline whenever the user gives a ' +
        'repository URL. Draft only: nothing is created until the user reviews and confirms it.',
      inputSchema: z.object({ gitUrl: z.string().describe('The repository URL (HTTPS, SSH, or git@ form)') }),
      execute: async ({ gitUrl }) => {
        const body: Record<string, unknown> = { gitUrl };
        if (defaults.provider) body.provider = defaults.provider;
        if (defaults.model) body.model = defaults.model;
        // Private-repo token comes from the request, never from the model.
        if (defaults.repoToken) body.repoToken = defaults.repoToken;
        const res = (await pipeline.post('/pipelines/generate/from-url', body)) as {
          data?: { props?: unknown; description?: string; keywords?: string[]; analysis?: unknown };
        };
        const data = res?.data ?? (res as { props?: unknown; description?: string; keywords?: string[]; analysis?: unknown });
        return { kind: 'pipeline', props: data?.props, description: data?.description, keywords: data?.keywords, analysis: data?.analysis };
      },
    }),

    propose_plugin: tool({
      description:
        'Generate a PROPOSED plugin (plugin-spec + Dockerfile) from a description. Draft only — the ' +
        'user reviews and confirms; creating a plugin then runs an ASYNC Docker build. Use it when the ' +
        'user asks to create/build a plugin. Never claim the plugin was created — creation is asynchronous.',
      inputSchema: z.object({ prompt: z.string().describe('What the plugin/build should do') }),
      execute: async ({ prompt }) => {
        const body: Record<string, unknown> = { prompt };
        if (defaults.provider) body.provider = defaults.provider;
        if (defaults.model) body.model = defaults.model;
        const res = (await plugin.post('/plugins/generate', body)) as { data?: { config?: unknown; dockerfile?: string } };
        const data = res?.data ?? (res as { config?: unknown; dockerfile?: string });
        return { kind: 'plugin', config: data?.config, dockerfile: data?.dockerfile };
      },
    }),

    propose_template: tool({
      description:
        'Generate a PROPOSED reusable pipeline TEMPLATE (with {{ vars.NAME }} placeholders and declared ' +
        'inputs) from a description. Draft only — the user reviews and creates it. Templates have no ' +
        'dedicated generator, so this drafts one directly. Use it when the user asks for a reusable template.',
      inputSchema: z.object({ prompt: z.string().describe('What the template should do') }),
      execute: async ({ prompt }) => {
        if (!(await chargeAiCall())) {
          return { kind: 'template', error: 'The organization has no AI generation quota left for this period.' };
        }
        const { object } = await generateObject({
          model,
          maxOutputTokens,
          schema: TemplateSchema,
          prompt:
            `Create a reusable Pipeline Builder template for: ${prompt}\n` +
            'Parameterize values with {{ vars.NAME }} and declare each one in "inputs". Keep it minimal and valid.',
        });
        return { kind: 'template', template: object };
      },
    }),

    list_templates: tool({
      description:
        "List the org's reusable pipeline templates with their declared input variables. Use this to find a " +
        'template to instantiate into a pipeline, and to see which inputs it needs.',
      inputSchema: z.object({}),
      execute: async () => {
        const res = (await pipeline.get('/pipeline-templates')) as { data?: unknown };
        return { templates: res?.data ?? res };
      },
    }),

    propose_pipeline_from_template: tool({
      description:
        'Fill a variable TEMPLATE\'s inputs to produce a concrete pipeline DRAFT (renders {{ vars.NAME }} with the ' +
        'supplied values). Use when the user wants a pipeline created FROM an existing template. Draft only — the ' +
        'user reviews and confirms. Find the template + its inputs first with list_templates.',
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
        const res = (await pipeline.post(`/pipeline-templates/${encodeURIComponent(templateId)}/instantiate`, body)) as {
          data?: { props?: unknown; description?: string };
        };
        const data = res?.data ?? (res as { props?: unknown; description?: string });
        // A rendered template is a concrete pipeline draft — same commit path as propose_pipeline.
        return { kind: 'pipeline', props: data?.props, description: data?.description };
      },
    }),
  };
}
